function clearArray(array) {
  array.length = 0;
}

function clearSet(set) {
  set.clear();
}

function ensurePrivateState(result) {
  if (!result._chunkSet) result._chunkSet = new Set();
  if (!result._itemSet) result._itemSet = new Set();
  if (!result._queueEntrySet) result._queueEntrySet = new Set();
  if (!result._queueMeshSet) result._queueMeshSet = new Set();
  if (!result._coronaSet) result._coronaSet = new Set();
  if (!result._shadowSet) result._shadowSet = new Set();
  if (!Number.isFinite(result._queueHash)) result._queueHash = 2166136261;
  if (!Number.isFinite(result._queueCount)) result._queueCount = 0;
  return result;
}

function createQueueBuckets() {
  return {
    opaque: [],
    cutout: [],
    transparent: [],
    additive: [],
    overlay: [],
  };
}

export function createFrameVisibilityResult() {
  const result = {
    computed: false,
    version: 0,
    queueVersion: 0,
    queueSignature: 0,
    lastQueueSignature: 0,
    lastQueueCount: 0,
    visibleChunks: [],
    visibleItems: [],
    visibleQueueEntries: [],
    visibleQueueMeshes: [],
    queueBuckets: createQueueBuckets(),
    coronaCandidates: [],
    shadowCandidates: [],
    _chunkSet: new Set(),
    _itemSet: new Set(),
    _queueEntrySet: new Set(),
    _queueMeshSet: new Set(),
    _coronaSet: new Set(),
    _shadowSet: new Set(),
    _queueHash: 2166136261,
    _queueCount: 0,
  };
  return result;
}

export function resetFrameVisibilityResult(result = createFrameVisibilityResult()) {
  ensurePrivateState(result);
  result.computed = false;
  clearArray(result.visibleChunks);
  clearArray(result.visibleItems);
  clearArray(result.visibleQueueEntries);
  clearArray(result.visibleQueueMeshes);
  clearArray(result.queueBuckets.opaque);
  clearArray(result.queueBuckets.cutout);
  clearArray(result.queueBuckets.transparent);
  clearArray(result.queueBuckets.additive);
  clearArray(result.queueBuckets.overlay);
  clearArray(result.coronaCandidates);
  clearArray(result.shadowCandidates);
  clearSet(result._chunkSet);
  clearSet(result._itemSet);
  clearSet(result._queueEntrySet);
  clearSet(result._queueMeshSet);
  clearSet(result._coronaSet);
  clearSet(result._shadowSet);
  result._queueHash = 2166136261;
  result._queueCount = 0;
  return result;
}

function compareQueueEntries(left, right) {
  if ((left?.renderClassOrder ?? 0) !== (right?.renderClassOrder ?? 0)) {
    return (left?.renderClassOrder ?? 0) - (right?.renderClassOrder ?? 0);
  }
  return (right?.frameDistanceSq ?? 0) - (left?.frameDistanceSq ?? 0);
}

function insertSorted(array, value, compare) {
  let index = array.length;
  while (index > 0 && compare(value, array[index - 1]) < 0) {
    index -= 1;
  }
  array.splice(index, 0, value);
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

export function addVisibleQueueEntry(result, entry, distanceSq = null) {
  ensurePrivateState(result);
  if (Number.isFinite(distanceSq)) entry.frameDistanceSq = distanceSq;
  const added = pushUnique(result.visibleQueueEntries, result._queueEntrySet, entry);
  if (!added) return false;
  const bucket = String(entry?.bucket || 'opaque').toLowerCase();
  const targetBucket = result.queueBuckets?.[bucket];
  if (Array.isArray(targetBucket)) {
    if (bucket === 'transparent' || bucket === 'additive' || bucket === 'overlay') {
      insertSorted(targetBucket, entry, compareQueueEntries);
    } else {
      targetBucket.push(entry);
    }
  }
  const stableId = Number(entry?.queueStableId) || 0;
  result._queueHash = (((result._queueHash * 16777619) >>> 0) ^ stableId) >>> 0;
  result._queueCount += 1;
  return true;
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
