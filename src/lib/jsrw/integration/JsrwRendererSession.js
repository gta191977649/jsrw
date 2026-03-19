import RWPipelineController from '../core/pipeline/controller.js';
import { WaterRuntime } from '../renderer/water/WaterRuntime.js';
import WebGLRenderBackend from '../backends/webgl/WebGLRenderBackend.js';
import WebGPURenderBackend from '../backends/webgpu/WebGPURenderBackend.js';
import { RWRenderQueue } from './three/RWRenderQueue.js';

function createBackend(activeBackend) {
  const normalized = String(activeBackend || 'WebGL').toUpperCase();
  if (normalized === 'WEBGPU') return new WebGPURenderBackend();
  return new WebGLRenderBackend();
}

export class JsrwRendererSession {
  constructor(options = {}) {
    this.pipelineController = options.pipelineController || new RWPipelineController();
    this.waterRuntime = null;
    this.backend = createBackend(options.activeBackend || 'WebGL');
    this.renderQueue = null;
  }

  setBackend(activeBackend) {
    this.backend = createBackend(activeBackend);
    return this.backend;
  }

  getBackend() {
    return this.backend;
  }

  getPipelineController() {
    return this.pipelineController;
  }

  setRoot(root) {
    this.pipelineController.setRoot(root);
    if (!this.renderQueue) {
      this.renderQueue = new RWRenderQueue(root);
    } else {
      this.renderQueue.setRoot(root);
    }
  }

  createRenderQueue(root) {
    this.renderQueue = new RWRenderQueue(root);
    return this.renderQueue;
  }

  getRenderQueue() {
    return this.renderQueue;
  }

  applyToRoot(root, runtimeContext = {}) {
    this.pipelineController.applyToRoot(root, {
      ...runtimeContext,
      backend: this.backend,
    });
  }

  applyToObject(object3D, runtimeContext = {}) {
    this.pipelineController.applyToObject(object3D, {
      ...runtimeContext,
      backend: this.backend,
    });
  }

  updateRuntime(runtimeContext = {}) {
    this.pipelineController.updateRuntime({
      ...runtimeContext,
      backend: this.backend,
    });
  }

  beginPostFxSceneCapture(runtimeContext = {}) {
    return this.pipelineController.beginPostFxSceneCapture({
      ...runtimeContext,
      backend: this.backend,
    });
  }

  renderPostFx(renderer, runtimeContext = {}) {
    this.pipelineController.renderPostFx(renderer, {
      ...runtimeContext,
      backend: this.backend,
    });
  }

  getActiveEffect(category) {
    return this.pipelineController.getActiveEffect(category);
  }

  setSelection(selection) {
    this.pipelineController.setSelection(selection);
  }

  createWaterRuntime(options) {
    this.waterRuntime?.dispose();
    this.waterRuntime = new WaterRuntime({
      ...options,
      backend: this.backend,
    });
    return this.waterRuntime;
  }

  getWaterRuntime() {
    return this.waterRuntime;
  }

  setWaterRuntime(runtime) {
    if (this.waterRuntime === runtime) return this.waterRuntime;
    this.disposeWaterRuntime();
    this.waterRuntime = runtime || null;
    return this.waterRuntime;
  }

  disposeWaterRuntime() {
    this.waterRuntime?.dispose();
    this.waterRuntime = null;
  }

  dispose() {
    this.disposeWaterRuntime();
  }
}

export default JsrwRendererSession;
