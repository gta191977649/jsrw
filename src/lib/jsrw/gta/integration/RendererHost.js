export class RendererHost {
  constructor(options = {}) {
    this.backend = String(options.backend || 'WebGL');
  }

  async initialize() {
    throw new Error('RendererHost.initialize() not implemented');
  }

  resize() {
    throw new Error('RendererHost.resize() not implemented');
  }

  getRenderer() {
    throw new Error('RendererHost.getRenderer() not implemented');
  }

  async setBackend(nextBackend) {
    this.backend = String(nextBackend || this.backend || 'WebGL');
    return this.initialize();
  }

  dispose() {}
}

export default RendererHost;
