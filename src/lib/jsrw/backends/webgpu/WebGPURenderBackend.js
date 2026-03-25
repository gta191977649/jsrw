import * as THREE from 'three';
import { RenderTarget } from 'three/webgpu';
import { RenderBackend } from '../common/RenderBackend.js';

export class WebGPURenderBackend extends RenderBackend {
  constructor(options = {}) {
    super({
      id: 'WEBGPU',
      capabilities: {
        supportsPatchedMaterials: false,
        supportsReadback: false,
        supportsNodeMaterials: true,
        supportsRenderTargets: true,
        supportsHistoryBuffers: true,
        supportsPostFxHistory: true,
        supportsDebugTargets: true,
        supportsCustomBlendConstants: false,
        supportsHalfFloatTargets: true,
        ...(options.capabilities || {}),
      },
    });
  }

  createRenderTarget(width, height, options = {}) {
    const target = new RenderTarget(width, height, {
      depthBuffer: options.depthBuffer === true,
      stencilBuffer: false,
      magFilter: options.magFilter || THREE.LinearFilter,
      minFilter: options.minFilter || THREE.LinearFilter,
      type: options.type || THREE.UnsignedByteType,
      colorSpace: options.colorSpace || THREE.NoColorSpace,
    });
    target.texture.generateMipmaps = options.generateMipmaps === true;
    target.texture.userData = {
      ...(target.texture.userData || {}),
      rwRenderTarget: target,
    };
    return target;
  }
}

export default WebGPURenderBackend;
