import { WorkerClient } from '../WorkerClient.js';
import { WORKER_CHANNEL } from '../protocol.js';

function createRenderWorker() {
  if (typeof Worker !== 'function') return null;
  return new Worker(new URL('./RenderWorker.js', import.meta.url), { type: 'module' });
}

export function supportsRenderWorkerCanvas(canvas) {
  return Boolean(
    canvas
    && typeof canvas.transferControlToOffscreen === 'function'
    && typeof Worker === 'function',
  );
}

export class RenderWorkerClient extends WorkerClient {
  constructor(options = {}) {
    super({
      channel: WORKER_CHANNEL.RENDER,
      workerFactory: options.workerFactory || createRenderWorker,
    });
  }

  async initialize({ canvas, backend = 'WebGL' } = {}) {
    if (!supportsRenderWorkerCanvas(canvas)) {
      throw new Error('Render worker requires OffscreenCanvas support');
    }
    const offscreenCanvas = canvas.transferControlToOffscreen();
    return this.request('init', {
      backend,
      canvas: offscreenCanvas,
    }, [offscreenCanvas]);
  }

  resize(payload = {}) {
    return this.request('resize', payload);
  }

  getRuntimeInfo() {
    return this.request('getRuntimeInfo');
  }

  disposeRenderer() {
    return this.request('dispose');
  }
}

export default RenderWorkerClient;
