function expectedLodNameByPrefix(modelName) {
  if (typeof modelName !== 'string' || modelName.length < 3) return null;
  const normalized = modelName.trim().toLowerCase();
  return `lod${normalized.slice(3)}`;
}

export function isLodModel(modelName) {
  return typeof modelName === 'string' && modelName.trim().toLowerCase().startsWith('lod');
}

export function buildLodMapping(placements, gameVersion) {
  const mapping = new Map();
  const usedLodIndices = new Set();

  if (gameVersion === 'SA') {
    for (let i = 0; i < placements.length; i += 1) {
      const placement = placements[i];
      if (isLodModel(placement.modelName)) continue;
      const lodIndex = placement.lod;
      if (!Number.isInteger(lodIndex) || lodIndex < 0 || lodIndex >= placements.length) continue;
      const lodPlacement = placements[lodIndex];
      if (!lodPlacement || !isLodModel(lodPlacement.modelName)) continue;
      if (lodPlacement.modelName.trim().toLowerCase() === placement.modelName.trim().toLowerCase()) continue;
      mapping.set(i, lodIndex);
      usedLodIndices.add(lodIndex);
    }
    return { mapping, usedLodIndices };
  }

  const lodNameToIndices = new Map();
  for (let i = 0; i < placements.length; i += 1) {
    const placement = placements[i];
    if (!isLodModel(placement.modelName)) continue;
    const lodName = placement.modelName.trim().toLowerCase();
    if (!lodNameToIndices.has(lodName)) {
      lodNameToIndices.set(lodName, []);
    }
    lodNameToIndices.get(lodName).push(i);
  }

  for (let i = 0; i < placements.length; i += 1) {
    const placement = placements[i];
    if (isLodModel(placement.modelName)) continue;
    const expected = expectedLodNameByPrefix(placement.modelName);
    if (!expected) continue;
    const candidates = lodNameToIndices.get(expected) || [];
    const target = candidates.find((index) => !usedLodIndices.has(index));
    if (target === undefined) continue;
    mapping.set(i, target);
    usedLodIndices.add(target);
  }

  return { mapping, usedLodIndices };
}
