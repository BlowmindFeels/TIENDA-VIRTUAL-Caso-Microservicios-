// SERVICIO DE CLIENTES (usuarios) — puerto 3002
const path = require('path');
const { JsonStore } = require('../../libs/common/store');
const { createService } = require('../../libs/common/server');

const PORT = process.env.PORT || 3002;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const store = new JsonStore(path.join(DATA_DIR, 'clientes.json'), [
  { id: 1, nombre: 'Laura Gómez', email: 'laura@correo.com', ciudad: 'Bogotá' },
  { id: 2, nombre: 'Andrés Rojas', email: 'andres@correo.com', ciudad: 'Medellín' },
]);

const { app, listen } = createService('clientes', PORT);

app.get('/clientes', (_req, res) => res.json(store.all()));

app.get('/clientes/:id', (req, res) => {
  const c = store.find(req.params.id);
  c ? res.json(c) : res.status(404).json({ error: 'Cliente no encontrado' });
});

app.post('/clientes', (req, res) => {
  const { nombre, email, ciudad = '' } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'El correo no es válido' });
  if (store.all().some((c) => c.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'Ya existe un cliente con ese correo' });
  }
  res.status(201).json(store.insert({ id: store.nextId(), nombre, email, ciudad }));
});

app.put('/clientes/:id', (req, res) => {
  const { nombre, email, ciudad } = req.body;
  const c = store.update(req.params.id, Object.fromEntries(
    Object.entries({ nombre, email, ciudad }).filter(([, v]) => v !== undefined)));
  c ? res.json(c) : res.status(404).json({ error: 'Cliente no encontrado' });
});

listen();
