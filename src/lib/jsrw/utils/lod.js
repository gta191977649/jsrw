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

function isValidPlacementIndex(index, placements) {
  return Number.isInteger(index) && index >= 0 && index < placements.length;
}

function getHintedLodCandidate(placements, placement, usedLodIndices, maxDistanceSq) {
  const hintedIndex = placement?.lod;
  if (!isValidPlacementIndex(hintedIndex, placements)) return null;
  if (usedLodIndices.has(hintedIndex)) return null;
  const hintedPlacement = placements[hintedIndex];
  if (!hintedPlacement || !isLodModel(hintedPlacement.modelName)) return null;
  if (normalizeModelName(hintedPlacement.modelName) === normalizeModelName(placement.modelName)) return null;
  const distSq = positionDistanceSq(placement, hintedPlacement);
  if (distSq > maxDistanceSq) return null;
  return { index: hintedIndex, score: distSq, placement: hintedPlacement };
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

  const MAX_FALLBACK_PAIR_DISTANCE_SQ = 64 * 64;
  const MAX_HINTED_PAIR_DISTANCE_SQ = version === 'SA' ? (256 * 256) : (96 * 96);

  // Prefer explicit IPL lod links whenever they point at a nearby LOD model.
  // This avoids name-based mismatches that can create holes during near/LOD swaps.
  for (let i = 0; i < placements.length; i += 1) {
    const placement = placements[i];
    if (isLodModel(placement.modelName)) continue;
    const hinted = getHintedLodCandidate(
      placements,
      placement,
      usedLodIndices,
      MAX_HINTED_PAIR_DISTANCE_SQ,
    );
    if (!hinted) continue;
    mapping.set(i, hinted.index);
    usedLodIndices.add(hinted.index);
  }

  for (let i = 0; i < placements.length; i += 1) {
    if (mapping.has(i)) continue;
    const placement = placements[i];
    if (isLodModel(placement.modelName)) continue;
    const expected = expectedLodNameByPrefix(placement.modelName);
    if (!expected) continue;
    const candidates = [...(lodNameToIndices.get(expected) || [])];
    const hinted = getHintedLodCandidate(
      placements,
      placement,
      usedLodIndices,
      MAX_HINTED_PAIR_DISTANCE_SQ,
    );
    if (hinted && normalizeModelName(hinted.placement?.modelName) === expected) {
      candidates.unshift(hinted.index);
    }
    if (candidates.length === 0) continue;
    const { index: target, score } = pickBestSpatialCandidate(candidates, placements, placement, usedLodIndices);
    if (!Number.isInteger(target) || score > MAX_FALLBACK_PAIR_DISTANCE_SQ) continue;
    mapping.set(i, target);
    usedLodIndices.add(target);
  }

  return { mapping, usedLodIndices };
}
