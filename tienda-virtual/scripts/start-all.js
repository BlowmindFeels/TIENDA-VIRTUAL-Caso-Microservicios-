// Lanza los 4 procesos (gateway + 3 microservicios) con logs de colores.
// Cada uno es un proceso independiente: puede detenerse o reiniciarse por separado.
const { spawn } = require('child_process');
const path = require('path');

const procesos = [
  { name: 'productos', file: 'services/productos/index.js', color: 36 },
  { name: 'clientes', file: 'services/clientes/index.js', color: 33 },
  { name: 'pedidos', file: 'services/pedidos/index.js', color: 35 },
  { name: 'gateway', file: 'services/gateway/index.js', color: 32 },
];
const root = path.join(__dirname, '..');
const hijos = procesos.map((p) => {
  const child = spawn(process.execPath, [p.file], { cwd: root, env: process.env });
  const prefijo = `\x1b[${p.color}m${p.name.padEnd(9)}|\x1b[0m `;
  const pipe = (stream, out) => stream.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => out.write(prefijo + l + '\n')));
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${prefijo}terminó (código ${code})`));
  return child;
});

console.log('\nTienda virtual en http://localhost:3000  (Ctrl+C para detener todo)\n');
const salir = () => { hijos.forEach((h) => h.kill()); process.exit(0); };
process.on('SIGINT', salir);
process.on('SIGTERM', salir);
