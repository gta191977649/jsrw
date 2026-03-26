export class StreamingPlannerClient {
  constructor() {
    this.worker = null;
    this.nextRequestId = 1;
    this.pending = new Map();
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./StreamingPlanner.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const data = event?.data || {};
      const requestId = Number(data.requestId) || 0;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      if (data.ok === false) {
        pending.reject(new Error(data.error || 'Streaming planner worker failed'));
        return;
      }
      pending.resolve(data.payload ?? null);
    };
    worker.onerror = (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  post(type, payload = null) {
    const worker = this.ensureWorker();
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage({ requestId, type, payload });
    });
  }

  init(payload = {}) {
    return this.post('init', payload);
  }

  plan(payload = {}) {
    return this.post('plan', payload);
  }

  reset() {
    if (!this.worker) return Promise.resolve(null);
    return this.post('reset', null);
  }

  dispose() {
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Streaming planner disposed'));
    }
    this.pending.clear();
    this.worker?.terminate?.();
    this.worker = null;
  }
}

export default StreamingPlannerClient;
