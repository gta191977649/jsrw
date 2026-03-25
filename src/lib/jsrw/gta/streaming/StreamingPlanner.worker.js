import {
  WORKER_CHANNEL,
  createWorkerResponseMessage,
  serializeWorkerError,
} from '../../workers/protocol.js';
import {
  getCameraForwardPlanarWeight,
  isBoxVisibleInCameraRuntime,
  isSphereVisibleInCameraRuntime,
} from '../../core/camera/CameraRuntime.js';

const CHANNEL = WORKER_CHANNEL.STREAMING;
const chunkState = {
  chunks: [],
};

function planFrame(payload = {}) {
  const camera = payload.camera || null;
  const renderDistance = Math.max(0, Number(payload.renderDistance) || 0);
  const priorityDistance = Math.max(0, Number(payload.priorityDistance) || 0);
  const chunkActiveMargin = Math.max(0, Number(payload.chunkActiveMargin) || 0);
  const candidateEntries = [];
  const frustumChunkKeys = [];

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
    if (inFrustum) frustumChunkKeys.push(chunk.key);
  }

  candidateEntries.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority ? -1 : 1;
    if (Math.abs(left.forwardWeight - right.forwardWeight) > 1e-4) return right.forwardWeight - left.forwardWeight;
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
