import { createRenderCapabilities } from './RenderCapabilities.js';

export class RenderBackend {
  constructor(options = {}) {
    this.id = String(options.id || 'DEFAULT').toUpperCase();
    this.capabilities = createRenderCapabilities(options.capabilities);
  }

  getCapabilities() {
    return this.capabilities;
  }

  createRenderTarget() {
    throw new Error(`RenderBackend(${this.id}): createRenderTarget() not implemented`);
  }
}
