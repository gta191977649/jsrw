import * as THREE from 'three';
import { RenderBackend } from '../common/RenderBackend.js';

export class WebGLRenderBackend extends RenderBackend {
  constructor(options = {}) {
    super({
      id: 'WEBGL',
      capabilities: {
        supportsPatchedMaterials: true,
        supportsReadback: true,
        supportsPostFxHistory: true,
        supportsDebugTargets: true,
        supportsCustomBlendConstants: true,
        supportsHalfFloatTargets: true,
        ...(options.capabilities || {}),
      },
    });
  }

  createRenderTarget(width, height, options = {}) {
    const target = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: options.depthBuffer === true,
      stencilBuffer: false,
      magFilter: options.magFilter || THREE.LinearFilter,
      minFilter: options.minFilter || THREE.LinearFilter,
      type: options.type || THREE.UnsignedByteType,
    });
    target.texture.colorSpace = options.colorSpace || THREE.NoColorSpace;
    target.texture.generateMipmaps = options.generateMipmaps === true;
    target.texture.userData = {
      ...(target.texture.userData || {}),
      rwRenderTarget: target,
    };
    return target;
  }
}

export default WebGLRenderBackend;
