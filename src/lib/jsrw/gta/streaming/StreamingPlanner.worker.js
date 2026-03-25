import {
  WORKER_CHANNEL,
  createWorkerResponseMessage,
  serializeWorkerError,
} from '../../workers/protocol.js';
import {
  getCameraForwardPlanarWeight,
  isBoxVisibleInCameraRuntime,
  projectPointToCameraViewport,
  isSphereVisibleInCameraRuntime,
} from '../../core/camera/CameraRuntime.js';

const CHANNEL = WORKER_CHANNEL.STREAMING;
const SCREEN_RECT_EPSILON = 0.015;
const DEPTH_EPSILON = 4.0;
const MIN_OCCLUDER_WIDTH = 0.14;
const MIN_OCCLUDER_HEIGHT = 0.14;
const MIN_OCCLUDER_AREA = 0.03;
const chunkState = {
  chunks: [],
};

function projectChunkOcclusionData(camera, chunk) {
  if (!camera || !Array.isArray(chunk?.boundsMin) || !Array.isArray(chunk?.boundsMax)) return null;
  const [minX, minY, minZ] = chunk.boundsMin;
  const [maxX, maxY, maxZ] = chunk.boundsMax;
  const corners = [
    { x: minX, y: minY, z: minZ },
    { x: maxX, y: minY, z: minZ },
    { x: minX, y: maxY, z: minZ },
    { x: maxX, y: maxY, z: minZ },
    { x: minX, y: minY, z: maxZ },
    { x: maxX, y: minY, z: maxZ },
    { x: minX, y: maxY, z: maxZ },
    { x: maxX, y: maxY, z: maxZ },
  ];
  const center = {
    x: (minX + maxX) * 0.5,
    y: (minY + maxY) * 0.5,
    z: (minZ + maxZ) * 0.5,
  };
  const centerProjection = projectPointToCameraViewport(camera, center);
  if (!centerProjection) return null;

  let outMinX = Number.POSITIVE_INFINITY;
  let outMinY = Number.POSITIVE_INFINITY;
  let outMaxX = Number.NEGATIVE_INFINITY;
  let outMaxY = Number.NEGATIVE_INFINITY;
  let outMinDepth = Number.POSITIVE_INFINITY;
  let outMaxDepth = Number.NEGATIVE_INFINITY;
  let projectedCount = 0;
  const testPoints = [];

  for (let index = 0; index < corners.length; index += 1) {
    const projection = projectPointToCameraViewport(camera, corners[index]);
    if (index === 0 || index === 3 || index === 5 || index === 6) testPoints.push(projection);
    if (!projection) continue;
    outMinX = Math.min(outMinX, projection.x);
    outMinY = Math.min(outMinY, projection.y);
    outMaxX = Math.max(outMaxX, projection.x);
    outMaxY = Math.max(outMaxY, projection.y);
    outMinDepth = Math.min(outMinDepth, projection.depth);
    outMaxDepth = Math.max(outMaxDepth, projection.depth);
    projectedCount += 1;
  }
  if (projectedCount === 0) return null;
  return {
    center: centerProjection,
    testPoints,
    minX: outMinX,
    minY: outMinY,
    maxX: outMaxX,
    maxY: outMaxY,
    minDepth: outMinDepth,
    maxDepth: outMaxDepth,
    width: Math.max(0, outMaxX - outMinX),
    height: Math.max(0, outMaxY - outMinY),
  };
}

function canRegisterOccluder(data) {
  if (!data?.center) return false;
  if (data.center.x < 0 || data.center.y < 0 || data.center.x > 1 || data.center.y > 1) return false;
  if (data.minX < 0 || data.minY < 0 || data.maxX > 1 || data.maxY > 1) return false;
  if (!Number.isFinite(data.minDepth) || !Number.isFinite(data.maxDepth) || data.maxDepth <= 0) return false;
  if (data.width < MIN_OCCLUDER_WIDTH || data.height < MIN_OCCLUDER_HEIGHT) return false;
  if ((data.width * data.height) < MIN_OCCLUDER_AREA) return false;
  return true;
}

function isPointWithinRect(point, rect, epsilon = 0) {
  if (!point || !rect) return false;
  return point.x >= (rect.minX - epsilon)
    && point.x <= (rect.maxX + epsilon)
    && point.y >= (rect.minY - epsilon)
    && point.y <= (rect.maxY + epsilon);
}

function isProjectedChunkOccluded(data, occluders) {
  if (!data?.center || !Array.isArray(occluders) || occluders.length === 0) return false;
  for (const occluder of occluders) {
    if (!isPointWithinRect(data.center, occluder, SCREEN_RECT_EPSILON)) continue;
    if (data.center.depth <= (occluder.maxDepth + DEPTH_EPSILON)) continue;
    let testedPointCount = 0;
    let allInside = true;
    for (const point of data.testPoints) {
      if (!point) continue;
      testedPointCount += 1;
      if (!isPointWithinRect(point, occluder, 0)) {
        allInside = false;
        break;
      }
    }
    if (testedPointCount > 0 && allInside) return true;
  }
  return false;
}

function planFrame(payload = {}) {
  const camera = payload.camera || null;
  const renderDistance = Math.max(0, Number(payload.renderDistance) || 0);
  const priorityDistance = Math.max(0, Number(payload.priorityDistance) || 0);
  const chunkActiveMargin = Math.max(0, Number(payload.chunkActiveMargin) || 0);
  const candidateEntries = [];
  const frustumChunkKeys = [];
  const visibleChunkKeys = [];
  const occluders = [];
  const frustumChunkKeySet = new Set();
  const candidateChunkByKey = new Map();

  for (const chunk of chunkState.chunks) {
    const dx = chunk.center[0] - (camera?.position?.x || 0);
    const dz = chunk.center[2] - (camera?.position?.z || 0);
    const distance = Math.hypot(dx, dz);
    if (distance > renderDistance + chunk.radius + chunkActiveMargin) continue;
    const forwardWeight = getCameraForwardPlanarWeight(camera, {
      x: chunk.center[0],
      y: chunk.center[1],
      z: chunk.center[2],
    });
    const priority = forwardWeight >= -(chunk.radius * 0.5) || distance <= priorityDistance + chunk.radius;
    const inFrustum = isSphereVisibleInCameraRuntime(camera, {
      x: chunk.center[0],
      y: chunk.center[1],
      z: chunk.center[2],
    }, chunk.radius) || isBoxVisibleInCameraRuntime(camera, {
      min: { x: chunk.boundsMin[0], y: chunk.boundsMin[1], z: chunk.boundsMin[2] },
      max: { x: chunk.boundsMax[0], y: chunk.boundsMax[1], z: chunk.boundsMax[2] },
    });
    candidateEntries.push({
      key: chunk.key,
      distance,
      priority,
      forwardWeight,
    });
    candidateChunkByKey.set(chunk.key, chunk);
    if (inFrustum) {
      frustumChunkKeys.push(chunk.key);
      frustumChunkKeySet.add(chunk.key);
    }
  }

  candidateEntries.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority ? -1 : 1;
    if (Math.abs(left.forwardWeight - right.forwardWeight) > 1e-4) return right.forwardWeight - left.forwardWeight;
    return left.distance - right.distance;
  });

  for (const entry of candidateEntries) {
    if (!frustumChunkKeySet.has(entry.key)) continue;
    const chunk = candidateChunkByKey.get(entry.key);
    if (!chunk) continue;
    const occlusionData = projectChunkOcclusionData(camera, chunk);
    if (!occlusionData) {
      visibleChunkKeys.push(entry.key);
      continue;
    }
    if (isProjectedChunkOccluded(occlusionData, occluders)) continue;
    visibleChunkKeys.push(entry.key);
    if (canRegisterOccluder(occlusionData)) occluders.push(occlusionData);
  }

  return {
    candidateChunkKeys: candidateEntries.map((entry) => entry.key),
    frustumChunkKeys,
    visibleChunkKeys,
  };
}

self.addEventListener('message', (event) => {
  const message = event?.data || null;
  if (!message || message.channel !== CHANNEL || message.kind !== 'request') return;

  try {
    if (message.type === 'init') {
      chunkState.chunks = Array.isArray(message.payload?.chunks) ? message.payload.chunks : [];
      self.postMessage(createWorkerResponseMessage(CHANNEL, message.type, message.id, {
        chunkCount: chunkState.chunks.length,
      }));
      return;
    }

    if (message.type === 'plan') {
      self.postMessage(createWorkerResponseMessage(
        CHANNEL,
        message.type,
        message.id,
        planFrame(message.payload || {}),
      ));
      return;
    }

    throw new Error(`Unsupported streaming worker request: ${message.type}`);
  } catch (error) {
    self.postMessage(createWorkerResponseMessage(
      CHANNEL,
      message.type,
      message.id,
      null,
      serializeWorkerError(error),
    ));
  }
});
