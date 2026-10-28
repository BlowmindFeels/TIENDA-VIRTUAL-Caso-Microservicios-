// SERVICIO DE PRODUCTOS (catálogo) — puerto 3001
// Maneja las consultas masivas en temporada de descuentos con una caché en memoria,
// y está aislado del registro de pedidos: actualizar el catálogo no toca pedidos.
const path = require('path');
const { JsonStore } = require('../../libs/common/store');
const { createService } = require('../../libs/common/server');

const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE_TTL_MS = 30_000;

const store = new JsonStore(path.join(DATA_DIR, 'productos.json'), [
  { id: 1, nombre: 'Audífonos inalámbricos', categoria: 'Tecnología', precio: 189900, stock: 40 },
  { id: 2, nombre: 'Teclado mecánico', categoria: 'Tecnología', precio: 259900, stock: 25 },
  { id: 3, nombre: 'Mochila antirrobo', categoria: 'Accesorios', precio: 119900, stock: 60 },
  { id: 4, nombre: 'Botella térmica 750 ml', categoria: 'Hogar', precio: 54900, stock: 120 },
  { id: 5, nombre: 'Lámpara de escritorio LED', categoria: 'Hogar', precio: 79900, stock: 35 },
  { id: 6, nombre: 'Monitor 24" Full HD', categoria: 'Tecnología', precio: 649900, stock: 15 },
]);

// --- Caché de consultas (absorbe los picos de lectura) ---
const cache = new Map();
const invalidarCache = () => cache.clear();

const { app, listen } = createService('productos', PORT);

app.get('/productos', (req, res) => {
  const key = req.originalUrl;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) {
    res.set('X-Cache', 'HIT');
    return res.json(hit.data);
  }
  const { search = '', categoria = '' } = req.query;
  const s = String(search).toLowerCase();
  const data = store.all().filter((p) =>
    (!s || p.nombre.toLowerCase().includes(s)) &&
    (!categoria || p.categoria.toLowerCase() === String(categoria).toLowerCase()));
  cache.set(key, { t: Date.now(), data });
  res.set('X-Cache', 'MISS');
  res.json(data);
});

app.get('/productos/:id', (req, res) => {
  const p = store.find(req.params.id);
  p ? res.json(p) : res.status(404).json({ error: 'Producto no encontrado' });
});

function validar(b) {
  if (!b.nombre || typeof b.nombre !== 'string') return 'El nombre es obligatorio';
  if (!(Number(b.precio) > 0)) return 'El precio debe ser mayor que 0';
  if (!(Number(b.stock) >= 0)) return 'El stock no puede ser negativo';
  return null;
}

app.post('/productos', (req, res) => {
  const error = validar(req.body);
  if (error) return res.status(400).json({ error });
  const { nombre, categoria = 'General', precio, stock } = req.body;
  const p = store.insert({ id: store.nextId(), nombre, categoria, precio: Number(precio), stock: Number(stock) });
  invalidarCache();
  res.status(201).json(p);
});

app.put('/productos/:id', (req, res) => {
  const actual = store.find(req.params.id);
  if (!actual) return res.status(404).json({ error: 'Producto no encontrado' });
  const merged = { ...actual, ...req.body };
  const error = validar(merged);
  if (error) return res.status(400).json({ error });
  const { nombre, categoria, precio, stock } = merged;
  res.json(store.update(req.params.id, { nombre, categoria, precio: Number(precio), stock: Number(stock) }));
  invalidarCache();
});

app.delete('/productos/:id', (req, res) => {
  if (!store.remove(req.params.id)) return res.status(404).json({ error: 'Producto no encontrado' });
  invalidarCache();
  res.status(204).end();
});

listen();
