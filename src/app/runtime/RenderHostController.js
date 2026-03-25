import { RenderWorkerClient, supportsRenderWorkerCanvas, ThreeRendererHost } from '../../lib/jsrw/index.js';

export class RenderHostController {
  constructor(options = {}) {
    this.backend = String(options.backend || 'WebGL');
    this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
    this.onBackendFallback = typeof options.onBackendFallback === 'function'
      ? options.onBackendFallback
      : null;
    this.preferWorker = options.preferWorker === true;
    this.canvas = null;
    this.host = null;
    this.renderWorkerClient = null;
    this.mode = 'main';
    this.runtimeInfo = null;
  }

  async initialize({ canvas, backend = this.backend, preferWorker = this.preferWorker } = {}) {
    this.dispose();
    this.canvas = canvas || null;
    this.backend = String(backend || this.backend || 'WebGL');
    this.preferWorker = preferWorker === true;

    if (this.preferWorker && supportsRenderWorkerCanvas(this.canvas)) {
      try {
        const workerClient = new RenderWorkerClient();
        const initResult = await workerClient.initialize({
          canvas: this.canvas,
          backend: this.backend,
        });
        this.renderWorkerClient = workerClient;
        this.mode = 'worker';
        this.backend = String(initResult?.backend || this.backend);
        this.runtimeInfo = initResult?.runtimeInfo || null;
        return null;
      } catch (error) {
        this.onLog?.('warn', `Render worker init failed: ${error?.message || error}. Falling back to main thread.`);
      }
    }

    this.host = new ThreeRendererHost({
      backend: this.backend,
      canvas: this.canvas,
      onLog: this.onLog,
      onBackendFallback: this.onBackendFallback,
    });
    const renderer = await this.host.initialize(this.backend);
    this.backend = String(this.host.backend || this.backend);
    this.mode = 'main';
    this.runtimeInfo = this.host.getRuntimeInfo();
    return renderer;
  }

  async resize(payload = {}) {
    if (this.mode === 'worker' && this.renderWorkerClient) {
      this.runtimeInfo = await this.renderWorkerClient.resize(payload);
      return;
    }
    this.host?.resize?.(payload);
    this.runtimeInfo = this.host?.getRuntimeInfo?.() || this.runtimeInfo;
  }

  getRenderer() {
    if (this.mode !== 'main') return null;
    return this.host?.getRenderer?.() || null;
  }

  getRuntimeInfo() {
    if (this.mode === 'worker') return this.runtimeInfo;
    return this.host?.getRuntimeInfo?.() || this.runtimeInfo;
  }

  dispose() {
    this.runtimeInfo = null;
    this.renderWorkerClient?.disposeRenderer?.().catch?.(() => {});
    this.renderWorkerClient?.dispose?.();
    this.renderWorkerClient = null;
    this.host?.dispose?.();
    this.host = null;
    this.mode = 'main';
  }
}

export default RenderHostController;
