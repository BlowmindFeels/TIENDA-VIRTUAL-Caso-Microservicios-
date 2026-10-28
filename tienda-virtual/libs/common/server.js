// Arranque común de un microservicio: JSON, log de peticiones y /health.
const express = require('express');

function createService(name, port) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    console.log(`[${name}] ${req.method} ${req.originalUrl}`);
    next();
  });
  app.get('/health', (_req, res) => res.json({ servicio: name, estado: 'UP', uptime: Math.round(process.uptime()) }));
  return {
    app,
    listen() {
      app.use((err, _req, res, _next) => {
        console.error(`[${name}] error:`, err.message);
        res.status(500).json({ error: 'Error interno del servicio' });
      });
      app.listen(port, () => console.log(`[${name}] escuchando en http://localhost:${port}`));
    },
  };
}

module.exports = { createService };
