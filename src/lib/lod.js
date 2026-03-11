function normalizeModelName(modelName) {
  return typeof modelName === 'string' ? modelName.trim().toLowerCase() : '';
}

function expectedLodNameByPrefix(modelName) {
  const normalized = normalizeModelName(modelName);
  if (normalized.length < 3) return null;
  return `lod${normalized.slice(3)}`;
}

function positionDistanceSq(a, b) {
  if (!a?.position || !b?.position) return Number.POSITIVE_INFINITY;
  const dx = (a.position.x || 0) - (b.position.x || 0);
  const dy = (a.position.y || 0) - (b.position.y || 0);
  const dz = (a.position.z || 0) - (b.position.z || 0);
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function pickBestSpatialCandidate(candidates, placements, sourcePlacement, usedLodIndices) {
  let bestIndex = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const index of candidates) {
    if (usedLodIndices.has(index)) continue;
    const candidate = placements[index];
    if (!candidate) continue;
    const interiorMismatch = (candidate.interior || 0) !== (sourcePlacement.interior || 0);
    const distSq = positionDistanceSq(sourcePlacement, candidate);
    const score = distSq + (interiorMismatch ? 1_000_000_000 : 0);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return { index: bestIndex, score: bestScore };
}

export function isLodModel(modelName) {
  return normalizeModelName(modelName).startsWith('lod');
}

export function buildLodMapping(placements, gameVersion) {
  const mapping = new Map();
  const usedLodIndices = new Set();
  const version = String(gameVersion || '').trim().toUpperCase();

  const lodNameToIndices = new Map();
  for (let i = 0; i < placements.length; i += 1) {
    const placement = placements[i];
    if (!isLodModel(placement.modelName)) continue;
    const lodName = normalizeModelName(placement.modelName);
    if (!lodNameToIndices.has(lodName)) {
      lodNameToIndices.set(lodName, []);
    }
    lodNameToIndices.get(lodName).push(i);
  }

  // SA has reliable per-placement IPL lod links. VCS/VC exports are far less
  // consistent, so there we keep the link only as a hint and rely primarily on
  // name + spatial matching.
  if (version === 'SA') {
    for (let i = 0; i < placements.length; i += 1) {
      const placement = placements[i];
      if (isLodModel(placement.modelName)) continue;
      const lodIndex = placement.lod;
      if (!Number.isInteger(lodIndex) || lodIndex < 0 || lodIndex >= placements.length) continue;
      const lodPlacement = placements[lodIndex];
      if (!lodPlacement || !isLodModel(lodPlacement.modelName)) continue;
      if (normalizeModelName(lodPlacement.modelName) === normalizeModelName(placement.modelName)) continue;
      if (usedLodIndices.has(lodIndex)) continue;
      mapping.set(i, lodIndex);
      usedLodIndices.add(lodIndex);
    }
  }

  const MAX_FALLBACK_PAIR_DISTANCE_SQ = 64 * 64;
  for (let i = 0; i < placements.length; i += 1) {
    if (mapping.has(i)) continue;
    const placement = placements[i];
    if (isLodModel(placement.modelName)) continue;
    const expected = expectedLodNameByPrefix(placement.modelName);
    if (!expected) continue;
    const candidates = [...(lodNameToIndices.get(expected) || [])];
    if (version !== 'SA') {
      const hintedIndex = placement.lod;
      if (Number.isInteger(hintedIndex) && hintedIndex >= 0 && hintedIndex < placements.length) {
        const hintedPlacement = placements[hintedIndex];
        if (hintedPlacement && normalizeModelName(hintedPlacement.modelName) === expected) {
          candidates.unshift(hintedIndex);
        }
      }
    }
    if (candidates.length === 0) continue;
    const { index: target, score } = pickBestSpatialCandidate(candidates, placements, placement, usedLodIndices);
    if (!Number.isInteger(target) || score > MAX_FALLBACK_PAIR_DISTANCE_SQ) continue;
    mapping.set(i, target);
    usedLodIndices.add(target);
  }

  return { mapping, usedLodIndices };
}
