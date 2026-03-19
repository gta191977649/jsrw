import { RenderBackend } from '../common/RenderBackend.js';

export class WebGPURenderBackend extends RenderBackend {
  constructor(options = {}) {
    super({
      id: 'WEBGPU',
      capabilities: {
        supportsPatchedMaterials: false,
        supportsReadback: false,
        supportsPostFxHistory: false,
        supportsDebugTargets: false,
        supportsCustomBlendConstants: false,
        supportsHalfFloatTargets: false,
        ...(options.capabilities || {}),
      },
    });
  }

  createRenderTarget() {
    throw new Error('WebGPURenderBackend: render targets are not implemented yet');
  }
}

export default WebGPURenderBackend;
