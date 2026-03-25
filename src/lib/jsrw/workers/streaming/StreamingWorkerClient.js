import { WorkerClient } from '../WorkerClient.js';
import { WORKER_CHANNEL } from '../protocol.js';

function createStreamingWorker() {
  if (typeof Worker !== 'function') return null;
  return new Worker(new URL('../../gta/streaming/StreamingPlanner.worker.js', import.meta.url), { type: 'module' });
}

export class StreamingWorkerClient extends WorkerClient {
  constructor(options = {}) {
    super({
      channel: WORKER_CHANNEL.STREAMING,
      workerFactory: options.workerFactory || createStreamingWorker,
    });
  }

  async initialize(chunks = []) {
    await this.request('init', { chunks });
  }

  async plan(payload = {}) {
    return this.request('plan', payload);
  }

  reset() {
    this.notify('init', { chunks: [] });
  }
}

export default StreamingWorkerClient;
