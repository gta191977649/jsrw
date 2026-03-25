import { ThreeRendererHost } from '../../adapters/three/ThreeRendererHost.js';
import {
  WORKER_CHANNEL,
  createWorkerResponseMessage,
  serializeWorkerError,
} from '../protocol.js';

const CHANNEL = WORKER_CHANNEL.RENDER;
let rendererHost = null;

async function handleRequest(type, payload = null) {
  switch (type) {
    case 'init': {
      rendererHost?.dispose?.();
      rendererHost = new ThreeRendererHost({
        backend: payload?.backend || 'WebGL',
        canvas: payload?.canvas || null,
      });
      await rendererHost.initialize(payload?.backend || 'WebGL');
      return {
        backend: rendererHost.backend,
        runtimeInfo: rendererHost.getRuntimeInfo(),
      };
    }
    case 'resize':
      rendererHost?.resize?.(payload || {});
      return rendererHost?.getRuntimeInfo?.() || null;
    case 'getRuntimeInfo':
      return rendererHost?.getRuntimeInfo?.() || null;
    case 'dispose':
      rendererHost?.dispose?.();
      rendererHost = null;
      return { disposed: true };
    default:
      throw new Error(`Unsupported render worker request: ${type}`);
  }
}

self.addEventListener('message', async (event) => {
  const message = event?.data || null;
  if (!message || message.channel !== CHANNEL || message.kind !== 'request') return;
  try {
    const payload = await handleRequest(message.type, message.payload);
    self.postMessage(createWorkerResponseMessage(CHANNEL, message.type, message.id, payload));
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
