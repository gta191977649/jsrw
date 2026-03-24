import { createPlacementEntity, getPlacementModelName } from './PlacementEntity.js';

export function createRenderItem(placement, ideRegistry = null) {
  const entity = createPlacementEntity(placement);
  const ideById = ideRegistry?.byId || new Map();
  const ideByModel = ideRegistry?.byModel || new Map();
  const ide = ideByModel.get(entity.modelName) ?? ideById.get(placement?.id) ?? null;

  return {
    modelName: entity.modelName,
    txdName: String(ide?.txdName || '').trim().toLowerCase(),
    count: 1,
    has2dfx: Array.isArray(ide?.effects) && ide.effects.some((effect) => effect?.kind === 'light'),
    hasDffLights: false,
    section: String(ide?.section || ''),
  };
}

export function buildRenderItemGraph(placements = [], ideRegistry = null) {
  const dependencies = new Map();

  for (const placement of placements) {
    const modelName = getPlacementModelName(placement);
    if (!modelName) continue;
    const entry = dependencies.get(modelName);
    if (entry) {
      entry.count += 1;
      continue;
    }
    dependencies.set(modelName, createRenderItem(placement, ideRegistry));
  }

  return Array.from(dependencies.values()).sort((a, b) => a.modelName.localeCompare(b.modelName));
}
