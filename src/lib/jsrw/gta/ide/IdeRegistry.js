export class IdeRegistry {
  constructor() {
    this.byId = new Map();
    this.byModel = new Map();
    this.effectsById = new Map();
    this.files = [];
  }

  add(definition, sourcePath = '') {
    const effects = this.effectsById.get(definition.id) || definition.effects || [];
    const value = sourcePath ? { ...definition, sourcePath, effects } : { ...definition, effects };
    this.byId.set(value.id, value);
    this.byModel.set(value.modelName, value);
  }

  addEffects(modelId, effects, sourcePath = '') {
    const normalizedId = Number.parseInt(modelId, 10);
    if (!Number.isFinite(normalizedId)) return;
    const stampedEffects = (effects || []).map((effect) => (
      sourcePath ? { ...effect, sourcePath } : effect
    ));
    this.effectsById.set(normalizedId, stampedEffects);
    const existing = this.byId.get(normalizedId);
    if (existing) {
      const next = { ...existing, effects: stampedEffects };
      this.byId.set(normalizedId, next);
      this.byModel.set(next.modelName, next);
    }
  }

  addParsed(parsed, sourcePath = '') {
    let effectCount = 0;
    for (const effects of parsed?.effectsById?.values?.() || []) {
      effectCount += Array.isArray(effects) ? effects.length : 0;
    }
    this.files.push({
      sourcePath,
      count: parsed?.byId?.size || 0,
      effectCount,
    });

    for (const [modelId, effects] of parsed?.effectsById?.entries?.() || []) {
      this.addEffects(modelId, effects, sourcePath);
    }
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

  getEffectsById(id) {
    return this.effectsById.get(Number.parseInt(id, 10)) || [];
  }

  values() {
    return this.byId.values();
  }

  get size() {
    return this.byId.size;
  }

  get effectsCount() {
    let total = 0;
    for (const effects of this.effectsById.values()) {
      total += Array.isArray(effects) ? effects.length : 0;
    }
    return total;
  }
}
