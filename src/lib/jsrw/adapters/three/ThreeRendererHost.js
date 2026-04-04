import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { RendererHost } from '../../gta/integration/RendererHost.js';

export class ThreeRendererHost extends RendererHost {
  constructor(options = {}) {
    super(options);
    this.canvas = options.canvas || null;
    this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
    this.onBackendFallback = typeof options.onBackendFallback === 'function'
      ? options.onBackendFallback
      : null;
    this.renderer = null;
  }

  async initialize(backend = this.backend) {
    this.dispose();
    this.backend = String(backend || 'WebGL');

    if (this.backend === 'WebGPU') {
      if (!WebGPU.isAvailable()) {
        this.onLog?.('warn', 'WebGPU is not supported in this browser. Falling back to WebGL.');
        this.onBackendFallback?.('WebGL');
        this.backend = 'WebGL';
      } else {
        const renderer = new WebGPURenderer({
          canvas: this.canvas,
          antialias: true,
          alpha: false,
        });
        await renderer.init();
        this.renderer = renderer;
        this.configureRenderer(renderer);
        return renderer;
      }
    }

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
    });
    this.renderer = renderer;
    this.configureRenderer(renderer);
    return renderer;
  }

  configureRenderer(renderer) {
    if (!renderer) return renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    if (renderer.info) {
      renderer.info.autoReset = false;
    }
    return renderer;
  }

  resize({
    width,
    height,
    dpr = 1,
  } = {}) {
    if (!this.renderer) return;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
  }

  getRenderer() {
    return this.renderer;
  }

  getTextureLoadingOptions() {
    const renderer = this.renderer;
    const supportsCompressedTextures = Boolean(
      renderer?.isWebGLRenderer
      && (
        renderer.extensions?.has?.('WEBGL_compressed_texture_s3tc')
        || renderer.extensions?.has?.('WEBKIT_WEBGL_compressed_texture_s3tc')
        || renderer.extensions?.has?.('MOZ_WEBGL_compressed_texture_s3tc')
      ),
    );
    return {
      preferCompressedTextures: supportsCompressedTextures,
      supportsCompressedTextures,
      allowCompressedFallbackDecode: true,
    };
  }

  dispose() {
    if (!this.renderer) return;
    if (typeof this.renderer.dispose === 'function') {
      this.renderer.dispose();
    }
    this.renderer = null;
  }
}

export default ThreeRendererHost;
