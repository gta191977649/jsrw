export class IdeRegistry {
  constructor() {
    this.byId = new Map();
    this.byModel = new Map();
    this.files = [];
  }

  add(definition, sourcePath = '') {
    const value = sourcePath ? { ...definition, sourcePath } : definition;
    this.byId.set(value.id, value);
    this.byModel.set(value.modelName, value);
  }

  addParsed(parsed, sourcePath = '') {
    this.files.push({
      sourcePath,
      count: parsed?.byId?.size || 0,
    });

    for (const definition of parsed?.byId?.values?.() || []) {
      this.add(definition, sourcePath);
    }
  }

  getById(id) {
    return this.byId.get(id);
  }

  getByModelName(name) {
    return this.byModel.get(String(name || '').toLowerCase());
  }

  values() {
    return this.byId.values();
  }

  get size() {
    return this.byId.size;
  }
}
