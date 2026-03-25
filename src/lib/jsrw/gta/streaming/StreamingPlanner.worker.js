import {
  WORKER_CHANNEL,
  createWorkerResponseMessage,
  serializeWorkerError,
} from '../../workers/protocol.js';

const CHANNEL = WORKER_CHANNEL.STREAMING;
const chunkState = {
  chunks: [],
};

function extractFrustumPlanes(elements) {
  const planes = [];
  if (!Array.isArray(elements) && !(elements instanceof Float32Array)) return planes;
  const m = elements;
  const rawPlanes = [
    [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
    [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
    [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
    [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
    [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
    [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
  ];
  for (const [x, y, z, w] of rawPlanes) {
    const length = Math.hypot(x, y, z) || 1;
    planes.push([x / length, y / length, z / length, w / length]);
  }
  return planes;
}

function intersectsFrustumAabb(planes, min, max) {
  if (!Array.isArray(planes) || planes.length === 0) return true;
  for (const plane of planes) {
    const px = plane[0] >= 0 ? max[0] : min[0];
    const py = plane[1] >= 0 ? max[1] : min[1];
    const pz = plane[2] >= 0 ? max[2] : min[2];
    if (((plane[0] * px) + (plane[1] * py) + (plane[2] * pz) + plane[3]) < 0) {
      return false;
    }
  }
  return true;
}

function planFrame(payload = {}) {
  const camera = payload.camera || {};
  const cameraPos = camera.position || [0, 0, 0];
  const renderDistance = Math.max(0, Number(payload.renderDistance) || 0);
  const priorityDistance = Math.max(0, Number(payload.priorityDistance) || 0);
  const chunkActiveMargin = Math.max(0, Number(payload.chunkActiveMargin) || 0);
  const planes = extractFrustumPlanes(payload.projScreenMatrix || []);
  const candidateEntries = [];
  const frustumChunkKeys = [];

  for (const chunk of chunkState.chunks) {
    const dx = chunk.center[0] - cameraPos[0];
    const dz = chunk.center[2] - cameraPos[2];
    const distance = Math.hypot(dx, dz);
    if (distance > renderDistance + chunk.radius + chunkActiveMargin) continue;
    const priority = distance <= priorityDistance + chunk.radius;
    const inFrustum = intersectsFrustumAabb(planes, chunk.boundsMin, chunk.boundsMax);
    candidateEntries.push({
      key: chunk.key,
      distance,
      priority,
    });
    if (inFrustum) frustumChunkKeys.push(chunk.key);
  }

  candidateEntries.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority ? -1 : 1;
    return left.distance - right.distance;
  });

  return {
    candidateChunkKeys: candidateEntries.map((entry) => entry.key),
    frustumChunkKeys,
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
