import * as THREE from 'three';
import { RenderTarget, WebGPURenderer } from 'three/webgpu';
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

    if (this.backend === 'WebGPU' && !WebGPU.isAvailable()) {
      this.onLog?.('warn', 'WebGPU is not supported in this browser. Falling back to WebGL.');
      this.onBackendFallback?.('WebGL');
      this.backend = 'WebGL';
    }

    let renderer = null;
    try {
      renderer = await this.createRenderer(this.backend);
      await this.verifyRenderer(renderer);
    } catch (error) {
      renderer?.dispose?.();
      renderer = null;
      if (this.backend === 'WebGPU') {
        this.onLog?.('warn', `WebGPU self-check failed: ${error?.message || error}. Falling back to WebGL.`);
        this.onBackendFallback?.('WebGL');
        this.backend = 'WebGL';
        renderer = await this.createRenderer(this.backend);
        await this.verifyRenderer(renderer);
      } else {
        throw error;
      }
    }

    this.renderer = renderer;
    return renderer;
  }

  async createRenderer(backend) {
    const normalizedBackend = String(backend || 'WebGL');
    const useWebGPU = normalizedBackend === 'WebGPU';
    const renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: useWebGPU ? false : true,
      samples: useWebGPU ? 0 : 4,
      alpha: false,
      powerPreference: 'high-performance',
      outputBufferType: useWebGPU ? THREE.UnsignedByteType : undefined,
      forceWebGL: !useWebGPU,
    });
    await renderer.init();
    this.configureRenderer(renderer);
    return renderer;
  }

  async verifyRenderer(renderer) {
    if (!renderer) throw new Error('Renderer creation returned no renderer');
    const previousTarget = renderer.getRenderTarget?.() || null;
    const previousAutoClear = renderer.autoClear;
    const previousClearColor = new THREE.Color();
    const previousClearAlpha = renderer.getClearAlpha?.() ?? 1;
    renderer.getClearColor?.(previousClearColor);

    const target = new RenderTarget(4, 4, {
      depthBuffer: true,
      colorSpace: THREE.NoColorSpace,
    });
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
    camera.position.z = 1;
    const offscreenScene = new THREE.Scene();
    const offscreenQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    );
    offscreenQuad.frustumCulled = false;
    offscreenScene.add(offscreenQuad);

    const presentScene = new THREE.Scene();
    const presentQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: target.texture, toneMapped: false }),
    );
    presentQuad.frustumCulled = false;
    presentScene.add(presentQuad);

    try {
      renderer.autoClear = true;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, true);
      renderer.render(offscreenScene, camera);
      renderer.setRenderTarget(null);
      renderer.clear(true, true, true);
      renderer.render(presentScene, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousClearColor, previousClearAlpha);
      renderer.autoClear = previousAutoClear;
      offscreenQuad.geometry.dispose();
      offscreenQuad.material.dispose();
      presentQuad.geometry.dispose();
      presentQuad.material.dispose();
      target.dispose();
    }
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

  getRuntimeInfo() {
    const renderer = this.renderer;
    if (!renderer) {
      return {
        backend: String(this.backend || 'UNKNOWN').toUpperCase(),
        actualBackend: 'unknown',
        currentSamples: 0,
        outputBufferType: 'unknown',
      };
    }
    const context = renderer.getContext?.() || null;
    const actualBackend = typeof context?.configure === 'function'
      ? 'webgpu'
      : (typeof context?.drawingBufferWidth === 'number' ? 'webgl2' : 'unknown');
    return {
      backend: String(this.backend || 'UNKNOWN').toUpperCase(),
      actualBackend,
      currentSamples: Number(renderer.currentSamples) || 0,
      outputBufferType: this.getTypeLabel(renderer.getOutputBufferType?.()),
    };
  }

  getTypeLabel(type) {
    switch (type) {
      case THREE.UnsignedByteType: return 'UnsignedByteType';
      case THREE.HalfFloatType: return 'HalfFloatType';
      case THREE.FloatType: return 'FloatType';
      default: return String(type ?? 'unknown');
    }
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
