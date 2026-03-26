import * as THREE from 'three';

const WORLD_CHUNK_SIZE = 50;
const CHUNK_ACTIVE_MARGIN = 384;
const SCREEN_RECT_EPSILON = 0.015;
const DEPTH_EPSILON = 0.02;
const MIN_OCCLUDER_WIDTH = 0.14;
const MIN_OCCLUDER_HEIGHT = 0.14;
const MIN_OCCLUDER_AREA = 0.03;

let chunkEntries = [];
const tempMatrix = new THREE.Matrix4();
const tempFrustum = new THREE.Frustum();
const tempBox = new THREE.Box3();
const tempSphere = new THREE.Sphere();
const clipPoint = new THREE.Vector4();
const boxCenter = new THREE.Vector3();
const boxCorners = Array.from({ length: 8 }, () => new THREE.Vector3());
const TEST_CORNER_INDICES = [0, 3, 5, 6];

function buildChunkEntries(chunks = []) {
  chunkEntries = Array.isArray(chunks)
    ? chunks.map((chunk) => ({
      key: String(chunk?.key || ''),
      center: new THREE.Vector3(...(Array.isArray(chunk?.center) ? chunk.center : [0, 0, 0])),
      radius: Math.max(WORLD_CHUNK_SIZE, Number(chunk?.radius) || 0),
      boundsMin: Array.isArray(chunk?.boundsMin) ? chunk.boundsMin : [0, 0, 0],
      boundsMax: Array.isArray(chunk?.boundsMax) ? chunk.boundsMax : [0, 0, 0],
    })).filter((chunk) => chunk.key)
    : [];
}

function fillBoxCorners(boundsMin, boundsMax) {
  const minX = Number(boundsMin?.[0]) || 0;
  const minY = Number(boundsMin?.[1]) || 0;
  const minZ = Number(boundsMin?.[2]) || 0;
  const maxX = Number(boundsMax?.[0]) || 0;
  const maxY = Number(boundsMax?.[1]) || 0;
  const maxZ = Number(boundsMax?.[2]) || 0;
  boxCorners[0].set(minX, minY, minZ);
  boxCorners[1].set(maxX, minY, minZ);
  boxCorners[2].set(minX, maxY, minZ);
  boxCorners[3].set(maxX, maxY, minZ);
  boxCorners[4].set(minX, minY, maxZ);
  boxCorners[5].set(maxX, minY, maxZ);
  boxCorners[6].set(minX, maxY, maxZ);
  boxCorners[7].set(maxX, maxY, maxZ);
  return boxCorners;
}

function projectPointToViewport(point) {
  if (!point?.isVector3) return null;
  clipPoint.set(point.x, point.y, point.z, 1);
  clipPoint.applyMatrix4(tempMatrix);
  if (!Number.isFinite(clipPoint.x) || !Number.isFinite(clipPoint.y) || !Number.isFinite(clipPoint.z) || !Number.isFinite(clipPoint.w)) {
    return null;
  }
  if (clipPoint.w <= 1e-6) return null;
  const invW = 1 / clipPoint.w;
  const ndcX = clipPoint.x * invW;
  const ndcY = clipPoint.y * invW;
  const ndcZ = clipPoint.z * invW;
  if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY) || !Number.isFinite(ndcZ)) return null;
  return {
    ndcX,
    ndcY,
    depth: ndcZ,
    x: (ndcX * 0.5) + 0.5,
    y: (ndcY * -0.5) + 0.5,
  };
}

function projectChunkOcclusionData(chunk) {
  fillBoxCorners(chunk.boundsMin, chunk.boundsMax);
  const minX = Number(chunk.boundsMin?.[0]) || 0;
  const minY = Number(chunk.boundsMin?.[1]) || 0;
  const minZ = Number(chunk.boundsMin?.[2]) || 0;
  const maxX = Number(chunk.boundsMax?.[0]) || 0;
  const maxY = Number(chunk.boundsMax?.[1]) || 0;
  const maxZ = Number(chunk.boundsMax?.[2]) || 0;
  boxCenter.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
  const centerProjection = projectPointToViewport(boxCenter);
  if (!centerProjection) return null;

  let rectMinX = Number.POSITIVE_INFINITY;
  let rectMinY = Number.POSITIVE_INFINITY;
  let rectMaxX = Number.NEGATIVE_INFINITY;
  let rectMaxY = Number.NEGATIVE_INFINITY;
  let minDepth = Number.POSITIVE_INFINITY;
  let maxDepth = Number.NEGATIVE_INFINITY;
  let projectedCount = 0;
  const testPoints = [];

  for (let index = 0; index < boxCorners.length; index += 1) {
    const projection = projectPointToViewport(boxCorners[index]);
    if (TEST_CORNER_INDICES.includes(index)) testPoints.push(projection);
    if (!projection) continue;
    rectMinX = Math.min(rectMinX, projection.x);
    rectMinY = Math.min(rectMinY, projection.y);
    rectMaxX = Math.max(rectMaxX, projection.x);
    rectMaxY = Math.max(rectMaxY, projection.y);
    minDepth = Math.min(minDepth, projection.depth);
    maxDepth = Math.max(maxDepth, projection.depth);
    projectedCount += 1;
  }

  if (projectedCount === 0) return null;
  return {
    center: centerProjection,
    testPoints,
    minX: rectMinX,
    minY: rectMinY,
    maxX: rectMaxX,
    maxY: rectMaxY,
    minDepth,
    maxDepth,
    width: Math.max(0, rectMaxX - rectMinX),
    height: Math.max(0, rectMaxY - rectMinY),
  };
}

function canRegisterOccluder(data) {
  if (!data?.center) return false;
  if (data.center.x < 0 || data.center.y < 0 || data.center.x > 1 || data.center.y > 1) return false;
  if (data.minX < 0 || data.minY < 0 || data.maxX > 1 || data.maxY > 1) return false;
  if (data.minDepth < -1 || data.maxDepth > 1) return false;
  if (data.width < MIN_OCCLUDER_WIDTH || data.height < MIN_OCCLUDER_HEIGHT) return false;
  if ((data.width * data.height) < MIN_OCCLUDER_AREA) return false;
  return true;
}

function isPointWithinRect(point, rect, epsilon = 0) {
  if (!point || !rect) return false;
  return (
    point.x >= (rect.minX - epsilon)
    && point.x <= (rect.maxX + epsilon)
    && point.y >= (rect.minY - epsilon)
    && point.y <= (rect.maxY + epsilon)
  );
}

function isChunkOccludedByOccluders(chunkData, occluders) {
  if (!chunkData?.center || !Array.isArray(occluders) || occluders.length === 0) return false;
  for (const occluder of occluders) {
    if (!isPointWithinRect(chunkData.center, occluder, SCREEN_RECT_EPSILON)) continue;
    if (chunkData.center.depth <= (occluder.maxDepth + DEPTH_EPSILON)) continue;
    let allTestPointsInside = true;
    let testedPointCount = 0;
    for (const point of chunkData.testPoints) {
      if (!point) continue;
      testedPointCount += 1;
      if (!isPointWithinRect(point, occluder, 0)) {
        allTestPointsInside = false;
        break;
      }
    }
    if (testedPointCount === 0 || !allTestPointsInside) continue;
    return true;
  }
  return false;
}

function planVisibility(payload = {}) {
  const camera = payload?.camera || {};
  const renderDistance = Math.max(WORLD_CHUNK_SIZE, Number(payload?.renderDistance) || WORLD_CHUNK_SIZE);
  const priorityDistance = Math.max(
    WORLD_CHUNK_SIZE,
    Math.min(renderDistance, Number(payload?.priorityDistance) || Math.min(renderDistance, renderDistance * 0.2)),
  );
  const chunkActiveMargin = Math.max(0, Number(payload?.chunkActiveMargin) || CHUNK_ACTIVE_MARGIN);
  const enableOcclusion = payload?.enableOcclusion === true;
  const cameraPosition = new THREE.Vector3(...(Array.isArray(camera?.position) ? camera.position : [0, 0, 0]));
  tempMatrix.fromArray(Array.isArray(camera?.projScreenMatrix) ? camera.projScreenMatrix : new THREE.Matrix4().identity().toArray());
  tempFrustum.setFromProjectionMatrix(tempMatrix);

  const candidates = [];
  for (const chunk of chunkEntries) {
    const dx = chunk.center.x - cameraPosition.x;
    const dz = chunk.center.z - cameraPosition.z;
    const distance = Math.hypot(dx, dz);
    if (distance > renderDistance + chunk.radius + chunkActiveMargin) continue;
    candidates.push({
      chunk,
      distance,
      priority: distance <= priorityDistance + chunk.radius,
    });
  }

  candidates.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority ? -1 : 1;
    return left.distance - right.distance;
  });

  const candidateChunkKeys = [];
  const frustumChunkKeys = [];
  const visibleChunkKeys = [];
  const occluders = [];
  for (const entry of candidates) {
    const chunk = entry.chunk;
    candidateChunkKeys.push(chunk.key);
    tempBox.min.set(...chunk.boundsMin);
    tempBox.max.set(...chunk.boundsMax);
    const inFrustum = tempFrustum.intersectsBox(tempBox)
      || tempFrustum.intersectsSphere(tempSphere.set(chunk.center, chunk.radius));
    if (!inFrustum) continue;
    frustumChunkKeys.push(chunk.key);
    if (!enableOcclusion) {
      visibleChunkKeys.push(chunk.key);
      continue;
    }
    const occlusionData = projectChunkOcclusionData(chunk);
    if (isChunkOccludedByOccluders(occlusionData, occluders)) continue;
    visibleChunkKeys.push(chunk.key);
    if (canRegisterOccluder(occlusionData)) occluders.push(occlusionData);
  }

  return {
    candidateChunkKeys,
    frustumChunkKeys,
    visibleChunkKeys,
  };
}

self.onmessage = (event) => {
  const data = event?.data || {};
  const requestId = Number(data.requestId) || 0;
  try {
    if (data.type === 'init') {
      buildChunkEntries(data.payload?.chunks || []);
      self.postMessage({ requestId, ok: true, payload: { chunkCount: chunkEntries.length } });
      return;
    }
    if (data.type === 'reset') {
      chunkEntries = [];
      self.postMessage({ requestId, ok: true, payload: null });
      return;
    }
    if (data.type === 'plan') {
      const payload = planVisibility(data.payload || {});
      self.postMessage({ requestId, ok: true, payload });
      return;
    }
    self.postMessage({ requestId, ok: false, error: `Unknown worker message type: ${String(data.type || '')}` });
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: error?.message || String(error) });
  }
};
