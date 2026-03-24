function clearArray(array) {
  array.length = 0;
}

function clearSet(set) {
  set.clear();
}

function ensurePrivateState(result) {
  if (!result._chunkSet) result._chunkSet = new Set();
  if (!result._itemSet) result._itemSet = new Set();
  if (!result._queueMeshSet) result._queueMeshSet = new Set();
  if (!result._coronaSet) result._coronaSet = new Set();
  if (!result._shadowSet) result._shadowSet = new Set();
  return result;
}

export function createFrameVisibilityResult() {
  const result = {
    computed: false,
    visibleChunks: [],
    visibleItems: [],
    visibleQueueMeshes: [],
    coronaCandidates: [],
    shadowCandidates: [],
    _chunkSet: new Set(),
    _itemSet: new Set(),
    _queueMeshSet: new Set(),
    _coronaSet: new Set(),
    _shadowSet: new Set(),
  };
  return result;
}

export function resetFrameVisibilityResult(result = createFrameVisibilityResult()) {
  ensurePrivateState(result);
  result.computed = false;
  clearArray(result.visibleChunks);
  clearArray(result.visibleItems);
  clearArray(result.visibleQueueMeshes);
  clearArray(result.coronaCandidates);
  clearArray(result.shadowCandidates);
  clearSet(result._chunkSet);
  clearSet(result._itemSet);
  clearSet(result._queueMeshSet);
  clearSet(result._coronaSet);
  clearSet(result._shadowSet);
  return result;
}

function pushUnique(array, set, value) {
  if (!value || set.has(value)) return false;
  set.add(value);
  array.push(value);
  return true;
}

export function addVisibleChunk(result, chunk) {
  ensurePrivateState(result);
  return pushUnique(result.visibleChunks, result._chunkSet, chunk);
}

export function addVisibleItem(result, item) {
  ensurePrivateState(result);
  return pushUnique(result.visibleItems, result._itemSet, item);
}

export function addVisibleQueueMesh(result, mesh) {
  ensurePrivateState(result);
  return pushUnique(result.visibleQueueMeshes, result._queueMeshSet, mesh);
}

export function addCoronaCandidate(result, entry) {
  ensurePrivateState(result);
  return pushUnique(result.coronaCandidates, result._coronaSet, entry);
}

export function addShadowCandidate(result, entry) {
  ensurePrivateState(result);
  return pushUnique(result.shadowCandidates, result._shadowSet, entry);
}
