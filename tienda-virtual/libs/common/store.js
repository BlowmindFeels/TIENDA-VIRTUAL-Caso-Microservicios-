// Persistencia simple en archivo JSON. Cada microservicio tiene SU PROPIO archivo
// (patrón "base de datos por servicio"): ningún servicio lee los datos de otro.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, seed = []) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(seed, null, 2));
    this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  all() { return this.data; }
  find(id) { return this.data.find((x) => x.id === Number(id)); }
  nextId() { return this.data.reduce((m, x) => Math.max(m, x.id), 0) + 1; }
  insert(item) { this.data.push(item); this._save(); return item; }
  update(id, patch) {
    const item = this.find(id);
    if (!item) return null;
    Object.assign(item, patch);
    this._save();
    return item;
  }
  upsert(item) {
    const i = this.data.findIndex((x) => x.id === item.id);
    if (i >= 0) this.data[i] = { ...this.data[i], ...item }; else this.data.push(item);
    this._save();
    return item;
  }
  remove(id) {
    const i = this.data.findIndex((x) => x.id === Number(id));
    if (i < 0) return false;
    this.data.splice(i, 1);
    this._save();
    return true;
  }
  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file); // escritura atómica
  }
}

module.exports = { JsonStore };
