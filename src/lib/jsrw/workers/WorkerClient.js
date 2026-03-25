import {
  WORKER_MESSAGE_KIND,
  createWorkerRequestMessage,
  deserializeWorkerError,
} from './protocol.js';

export class WorkerClient {
  constructor(options = {}) {
    this.channel = String(options.channel || '');
    this.worker = typeof options.workerFactory === 'function'
      ? options.workerFactory()
      : null;
    this.pending = new Map();
    this.disposed = false;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    this.worker?.addEventListener?.('message', this.handleMessage);
    this.worker?.addEventListener?.('error', this.handleError);
  }

  handleMessage = (event) => {
    const message = event?.data || null;
    if (!message || message.channel !== this.channel) return;
    if (message.kind === WORKER_MESSAGE_KIND.EVENT) {
      this.onEvent?.(message.type, message.payload);
      return;
    }
    if (message.kind !== WORKER_MESSAGE_KIND.RESPONSE || !message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(deserializeWorkerError(message.error));
      return;
    }
    pending.resolve(message.payload);
  };

  handleError = (event) => {
    const error = event?.error || event?.message || new Error('Worker error');
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  };

  request(type, payload = null, transfer = []) {
    if (this.disposed || !this.worker) {
      return Promise.reject(new Error(`Worker channel "${this.channel}" is not available`));
    }
    const message = createWorkerRequestMessage(this.channel, type, payload);
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject });
      this.worker.postMessage(message, transfer);
    });
  }

  notify(type, payload = null, transfer = []) {
    if (this.disposed || !this.worker) return;
    const message = createWorkerRequestMessage(this.channel, type, payload);
    this.worker.postMessage(message, transfer);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error(`Worker channel "${this.channel}" disposed`));
    }
    this.pending.clear();
    this.worker?.removeEventListener?.('message', this.handleMessage);
    this.worker?.removeEventListener?.('error', this.handleError);
    this.worker?.terminate?.();
    this.worker = null;
  }
}

export default WorkerClient;
