// Prueba automática de resiliencia: levanta todo el sistema, "desconecta" cada módulo
// (matando su proceso) y comprueba que los demás siguen funcionando.
// Uso: npm run test:resiliencia
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tienda-test-'));
const P = { gateway: 4000, productos: 4001, clientes: 4002, pedidos: 4003 };
const env = {
  ...process.env,
  PRODUCTOS_URL: `http://localhost:${P.productos}`,
  CLIENTES_URL: `http://localhost:${P.clientes}`,
  PEDIDOS_URL: `http://localhost:${P.pedidos}`,
  RECONCILE_MS: '1000',
};
const GW = `http://localhost:${P.gateway}/api`;
const procs = {};
let ok = 0, fail = 0;

function iniciar(name) {
  procs[name] = spawn(process.execPath, [`services/${name}/index.js`], {
    cwd: root, stdio: 'ignore',
    env: { ...env, PORT: String(P[name]), DATA_DIR: path.join(tmp, name) },
  });
}
function detener(name) {
  return new Promise((res) => { procs[name].once('exit', res); procs[name].kill('SIGKILL'); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(method, p, body) {
  const t0 = Date.now();
  try {
    const r = await fetch(GW + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    return { status: r.status, data: await r.json().catch(() => null), ms: Date.now() - t0, cache: r.headers.get('x-cache') };
  } catch { return { status: 0, data: null, ms: Date.now() - t0 }; }
}
function check(desc, cond, extra = '') {
  console.log(`  ${cond ? '✔' : '✘'} ${desc}${extra ? '  ' + extra : ''}`);
  cond ? ok++ : fail++;
}
async function esperar(desc, fn, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await fn()) return true; await sleep(500); }
  return false;
}
const pedido = (clienteId, productoId) => http('POST', '/pedidos', { clienteId, items: [{ productoId, cantidad: 2 }] });

async function main() {
  console.log('\n▶ Iniciando gateway y 3 microservicios (puertos 4000-4003, datos temporales)...');
  for (const n of Object.keys(P)) iniciar(n);
  const arriba = await esperar('arranque', async () => {
    const h = await http('GET', '/health');
    return h.data && Object.values(h.data.servicios).every((s) => s.estado === 'UP');
  });
  check('Los 3 módulos arrancan y el gateway los ve en línea', arriba);
  if (!arriba) throw new Error('El sistema no arrancó');

  console.log('\n▶ Escenario 0: todo en línea');
  const p0 = await pedido(1, 1);
  check('Crear pedido valida contra Clientes y Productos', p0.status === 201 && p0.data.estado === 'CONFIRMADO', `(estado: ${p0.data?.estado})`);
  await pedido(1, 2); // llena la réplica local con el producto 2

  console.log('\n▶ Escenario 1: se cae el módulo de CLIENTES');
  await detener('clientes');
  let r = await http('GET', '/clientes'), h;
  check('Clientes responde 503 (aislado, sin colgar el sistema)', r.status === 503, `(${r.ms} ms)`);
  r = await http('GET', '/productos');
  check('Productos sigue funcionando', r.status === 200 && r.data.length >= 6);
  r = await http('GET', '/pedidos');
  check('Consultar pedidos sigue funcionando', r.status === 200);
  const pDeg = await pedido(1, 1);
  check('Se puede registrar un pedido de un cliente ya conocido (queda PENDIENTE_VALIDACION)', pDeg.status === 201 && pDeg.data.estado === 'PENDIENTE_VALIDACION', `(estado: ${pDeg.data?.estado})`);
  r = await pedido(2, 1);
  check('Un cliente nunca visto se rechaza con error claro 424 (no se inventan datos)', r.status === 424 && /Clientes/.test(r.data?.error || ''));
  h = await http('GET', '/health');
  check('Ese rechazo NO marca a Pedidos como caído (su circuito sigue cerrado)', h.data.servicios.pedidos.estado === 'UP' && h.data.servicios.pedidos.circuito === 'CLOSED');
  h = await http('GET', '/health');
  check('El panel de estado marca solo a Clientes como DOWN', h.data.servicios.clientes.estado === 'DOWN' && h.data.servicios.productos.estado === 'UP' && h.data.servicios.pedidos.estado === 'UP');

  console.log('\n▶ Recuperación de CLIENTES');
  iniciar('clientes');
  check('Clientes vuelve a responder', await esperar('clientes', async () => (await http('GET', '/clientes')).status === 200));
  check('El pedido pendiente se confirma automáticamente', await esperar('reconciliar', async () => (await http('GET', `/pedidos/${pDeg.data.id}`)).data?.estado === 'CONFIRMADO'));

  console.log('\n▶ Escenario 2: se cae el módulo de PRODUCTOS');
  await detener('productos');
  r = await http('GET', '/productos');
  check('Productos responde 503', r.status === 503, `(${r.ms} ms)`);
  r = await http('GET', '/clientes');
  check('Clientes sigue funcionando', r.status === 200);
  r = await http('GET', '/pedidos');
  check('Consultar pedidos sigue funcionando', r.status === 200);
  const pDeg2 = await pedido(1, 2);
  check('Se puede registrar un pedido con productos ya conocidos (PENDIENTE_VALIDACION)', pDeg2.status === 201 && pDeg2.data.estado === 'PENDIENTE_VALIDACION', `(estado: ${pDeg2.data?.estado})`);
  iniciar('productos');
  check('Productos vuelve a responder', await esperar('productos', async () => (await http('GET', '/productos')).status === 200));
  check('El pedido pendiente se confirma automáticamente', await esperar('reconciliar', async () => (await http('GET', `/pedidos/${pDeg2.data.id}`)).data?.estado === 'CONFIRMADO'));

  console.log('\n▶ Escenario 3: se cae el módulo de PEDIDOS');
  await detener('pedidos');
  r = await http('GET', '/pedidos');
  check('Pedidos responde 503', r.status === 503, `(${r.ms} ms)`);
  r = await http('GET', '/productos');
  check('Productos sigue funcionando', r.status === 200);
  r = await http('POST', '/productos', { nombre: 'Producto nuevo (catálogo actualizado con Pedidos caído)', precio: 10000, stock: 5 });
  check('El catálogo se puede actualizar sin Pedidos', r.status === 201);
  r = await http('GET', '/clientes');
  check('Clientes sigue funcionando', r.status === 200);
  iniciar('pedidos');
  check('Pedidos vuelve a responder con sus datos intactos', await esperar('pedidos', async () => { const x = await http('GET', '/pedidos'); return x.status === 200 && x.data.length >= 3; }));

  console.log('\n▶ Escenario 4: pico de consultas (temporada de descuentos)');
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: 400 }, () => http('GET', '/productos')));
  const hits = rs.filter((x) => x.cache === 'HIT').length;
  check('400 consultas simultáneas al catálogo responden 200', rs.every((x) => x.status === 200), `(${Date.now() - t0} ms en total)`);
  check('La caché absorbe la carga', hits > 300, `(${hits} de 400 desde caché)`);
  const rp = await http('GET', '/pedidos');
  check('Pedidos sigue rápido durante la carga de Productos', rp.status === 200 && rp.ms < 1000, `(${rp.ms} ms)`);

  console.log(`\nResultado: ${ok} comprobaciones correctas, ${fail} fallidas\n`);
}

main()
  .catch((e) => { console.error('Error en la prueba:', e.message); fail++; })
  .finally(() => {
    Object.values(procs).forEach((p) => p.kill('SIGKILL'));
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  });
