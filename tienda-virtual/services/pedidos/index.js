// SERVICIO DE PEDIDOS (órdenes) — puerto 3003
//
// Patrones de resiliencia aplicados:
//  1. Timeout + Circuit Breaker en cada llamada a Productos y Clientes.
//  2. Réplica local (caché persistente) de los datos mínimos que necesita de otros servicios.
//     Si Productos o Clientes están caídos, el pedido se acepta con estado PENDIENTE_VALIDACION.
//  3. Reconciliador en segundo plano: cuando el servicio caído vuelve, confirma o rechaza esos pedidos.
//  4. Lectura/consulta de pedidos 100 % local: nunca depende de otro servicio.
const path = require('path');
const { JsonStore } = require('../../libs/common/store');
const { createService } = require('../../libs/common/server');
const { CircuitBreaker, requestJson } = require('../../libs/common/resilience');

const PORT = process.env.PORT || 3003;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PRODUCTOS_URL = process.env.PRODUCTOS_URL || 'http://localhost:3001';
const CLIENTES_URL = process.env.CLIENTES_URL || 'http://localhost:3002';
const RECONCILE_MS = Number(process.env.RECONCILE_MS || 5000);

const pedidos = new JsonStore(path.join(DATA_DIR, 'pedidos.json'));
const cacheClientes = new JsonStore(path.join(DATA_DIR, 'cache-clientes.json'));
const cacheProductos = new JsonStore(path.join(DATA_DIR, 'cache-productos.json'));

const remotos = {
  clientes: { url: CLIENTES_URL, cache: cacheClientes, breaker: new CircuitBreaker({ name: 'clientes' }), campos: ['id', 'nombre'] },
  productos: { url: PRODUCTOS_URL, cache: cacheProductos, breaker: new CircuitBreaker({ name: 'productos' }), campos: ['id', 'nombre', 'precio'] },
};

// Consulta una entidad al servicio dueño. Resultado: OK | NO_EXISTE | CAIDO
async function consultarRemoto(tipo, id) {
  const r = remotos[tipo];
  try {
    const resp = await r.breaker.exec(() => requestJson(tipo, `${r.url}/${tipo}/${id}`, { timeoutMs: 1500 }));
    if (resp.status === 404) return { estado: 'NO_EXISTE' };
    r.cache.upsert(Object.fromEntries(r.campos.map((c) => [c, resp.data[c]])));
    return { estado: 'OK', data: resp.data, origen: 'servicio' };
  } catch (e) {
    if (!e.unavailable) throw e;
    return { estado: 'CAIDO' };
  }
}

// Igual que la anterior, pero si el servicio está caído intenta con la réplica local.
async function consultarConRespaldo(tipo, id) {
  const r = await consultarRemoto(tipo, id);
  if (r.estado !== 'CAIDO') return r;
  const local = remotos[tipo].cache.find(id);
  return local ? { estado: 'OK', data: local, origen: 'cache' } : r;
}

const { app, listen } = createService('pedidos', PORT);

app.get('/pedidos', (req, res) => {
  let lista = pedidos.all();
  if (req.query.clienteId) lista = lista.filter((p) => p.clienteId === Number(req.query.clienteId));
  res.json([...lista].sort((a, b) => b.id - a.id));
});

app.get('/pedidos/:id', (req, res) => {
  const p = pedidos.find(req.params.id);
  p ? res.json(p) : res.status(404).json({ error: 'Pedido no encontrado' });
});

app.post('/pedidos', async (req, res, next) => {
  try {
    const { clienteId, items } = req.body;
    if (!Number.isInteger(Number(clienteId)) || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Se requiere clienteId y al menos un producto en items' });
    }
    if (items.some((i) => !Number.isInteger(Number(i.productoId)) || !(Number(i.cantidad) >= 1))) {
      return res.status(400).json({ error: 'Cada item necesita productoId y cantidad entera mayor o igual a 1' });
    }

    const [cliente, ...productos] = await Promise.all([
      consultarConRespaldo('clientes', clienteId),
      ...items.map((i) => consultarConRespaldo('productos', i.productoId)),
    ]);

    if (cliente.estado === 'NO_EXISTE') return res.status(400).json({ error: `El cliente ${clienteId} no existe` });
    const faltante = productos.findIndex((p) => p.estado === 'NO_EXISTE');
    if (faltante >= 0) return res.status(400).json({ error: `El producto ${items[faltante].productoId} no existe` });
    if (cliente.estado === 'CAIDO') {
      return res.status(424).json({ error: 'No se puede validar el cliente: el módulo de Clientes no responde y este cliente aún no está en la réplica local. Intente de nuevo en unos segundos.' });
    }
    const sinDatos = productos.findIndex((p) => p.estado === 'CAIDO');
    if (sinDatos >= 0) {
      return res.status(424).json({ error: `No se puede validar el producto ${items[sinDatos].productoId}: el módulo de Productos no responde y ese producto aún no está en la réplica local.` });
    }

    const detalle = items.map((i, n) => {
      const cantidad = Number(i.cantidad);
      const precioUnitario = productos[n].data.precio;
      return { productoId: Number(i.productoId), nombre: productos[n].data.nombre, precioUnitario, cantidad, subtotal: precioUnitario * cantidad };
    });
    const degradado = [cliente, ...productos].some((x) => x.origen === 'cache');

    const pedido = pedidos.insert({
      id: pedidos.nextId(),
      clienteId: Number(clienteId),
      clienteNombre: cliente.data.nombre,
      items: detalle,
      total: detalle.reduce((s, d) => s + d.subtotal, 0),
      estado: degradado ? 'PENDIENTE_VALIDACION' : 'CONFIRMADO',
      nota: degradado ? 'Registrado con datos de la réplica local; se confirmará cuando el módulo origen responda.' : '',
      fecha: new Date().toISOString(),
    });
    res.status(201).json(pedido);
  } catch (e) { next(e); }
});

app.patch('/pedidos/:id/cancelar', (req, res) => {
  const p = pedidos.find(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (['CANCELADO', 'RECHAZADO'].includes(p.estado)) return res.status(409).json({ error: `El pedido ya está ${p.estado}` });
  res.json(pedidos.update(p.id, { estado: 'CANCELADO' }));
});

// --- Reconciliador: revalida pedidos pendientes cuando los servicios vuelven ---
let reconciliando = false;
async function reconciliar() {
  if (reconciliando) return;
  reconciliando = true;
  try {
    for (const p of pedidos.all().filter((x) => x.estado === 'PENDIENTE_VALIDACION')) {
      const res = await Promise.all([
        consultarRemoto('clientes', p.clienteId),
        ...p.items.map((i) => consultarRemoto('productos', i.productoId)),
      ]);
      if (res.some((r) => r.estado === 'CAIDO')) continue; // aún no se puede validar
      if (res.some((r) => r.estado === 'NO_EXISTE')) {
        pedidos.update(p.id, { estado: 'RECHAZADO', nota: 'Rechazado: un cliente o producto ya no existe.' });
      } else {
        pedidos.update(p.id, { estado: 'CONFIRMADO', nota: 'Validado correctamente tras restablecerse la conexión.' });
      }
      console.log(`[pedidos] reconciliado pedido #${p.id}`);
    }
  } finally { reconciliando = false; }
}
setInterval(() => reconciliar().catch((e) => console.error('[pedidos] reconciliador:', e.message)), RECONCILE_MS).unref();

listen();
