// API GATEWAY — puerto 3000
// Punto de entrada único para la aplicación cliente. Enruta hacia cada microservicio y
// aísla las fallas: si un servicio cae, SOLO sus rutas responden 503; las demás siguen vivas.
const path = require('path');
const express = require('express');
const { CircuitBreaker, requestJson } = require('../../libs/common/resilience');

const PORT = process.env.PORT || 3000;
const servicios = {
  productos: { url: process.env.PRODUCTOS_URL || 'http://localhost:3001' },
  clientes: { url: process.env.CLIENTES_URL || 'http://localhost:3002' },
  pedidos: { url: process.env.PEDIDOS_URL || 'http://localhost:3003' },
};
for (const [name, s] of Object.entries(servicios)) s.breaker = new CircuitBreaker({ name });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Estado de cada módulo (el cliente lo usa para mostrar qué está disponible)
app.get('/api/health', async (_req, res) => {
  const entradas = await Promise.all(Object.entries(servicios).map(async ([name, s]) => {
    try {
      await requestJson(name, `${s.url}/health`, { timeoutMs: 1000 });
      return [name, { estado: 'UP', circuito: s.breaker.state }];
    } catch {
      return [name, { estado: 'DOWN', circuito: s.breaker.state }];
    }
  }));
  res.json({ gateway: 'UP', servicios: Object.fromEntries(entradas) });
});

function proxy(name) {
  const s = servicios[name];
  return async (req, res) => {
    const destino = s.url + req.originalUrl.replace(/^\/api/, '');
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
    try {
      const r = await s.breaker.exec(() => requestJson(name, destino, {
        method: req.method, body: hasBody ? req.body : undefined, timeoutMs: 3000,
      }));
      if (r.headers.get('x-cache')) res.set('X-Cache', r.headers.get('x-cache'));
      if (r.status === 204) return res.status(204).end();
      res.status(r.status).json(r.data);
    } catch (e) {
      if (!e.unavailable) throw e;
      console.warn(`[gateway] ${e.message}`);
      res.status(503).json({ error: `El módulo de ${name} no está disponible en este momento`, modulo: name });
    }
  };
}
for (const name of Object.keys(servicios)) app.use(`/api/${name}`, proxy(name));

app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
app.listen(PORT, () => console.log(`[gateway] escuchando en http://localhost:${PORT}`));
