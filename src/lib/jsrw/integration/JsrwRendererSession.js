import RWPipelineController from '../core/pipeline/controller.js';
import { WaterRuntime } from '../renderer/water/WaterRuntime.js';
import { CoronaRuntime } from '../renderer/corona/CoronaRuntime.js';
import { ShadowRuntime } from '../renderer/shadows/ShadowRuntime.js';
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
    this.coronaRuntime = null;
    this.shadowRuntime = null;
    this.backend = createBackend(options.activeBackend || 'WebGL');
    this.renderQueue = null;
  }

  setBackend(activeBackend) {
    this.backend = createBackend(activeBackend);
    this.waterRuntime?.setBackend?.(this.backend);
    this.coronaRuntime?.setBackend?.(this.backend);
    this.shadowRuntime?.setBackend?.(this.backend);
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
    this.coronaRuntime?.setRoot?.(root);
    this.shadowRuntime?.setRoot?.(root);
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

  getStats() {
    return {
      pipeline: this.pipelineController?.getStats?.() || {
        activeMaterialCount: 0,
        cachedMaterialCount: 0,
      },
      renderQueue: {
        ...(this.renderQueue?.debugStats || {}),
      },
      corona: {
        ...(this.coronaRuntime?.getDebugStats?.() || {}),
      },
      water: {
        ...(this.waterRuntime?.getDebugStats?.() || {}),
      },
    };
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

  createCoronaRuntime(options) {
    this.coronaRuntime?.dispose();
    this.coronaRuntime = new CoronaRuntime({
      ...options,
      root: options?.root || this.pipelineController.root || null,
      backend: this.backend,
    });
    return this.coronaRuntime;
  }

  getCoronaRuntime() {
    return this.coronaRuntime;
  }

  createShadowRuntime(options) {
    this.shadowRuntime?.dispose();
    this.shadowRuntime = new ShadowRuntime({
      ...options,
      root: options?.root || this.pipelineController.root || null,
      backend: this.backend,
    });
    return this.shadowRuntime;
  }

  getShadowRuntime() {
    return this.shadowRuntime;
  }

  setShadowRuntime(runtime) {
    if (this.shadowRuntime === runtime) return this.shadowRuntime;
    this.disposeShadowRuntime();
    this.shadowRuntime = runtime || null;
    this.shadowRuntime?.setRoot?.(this.pipelineController.root || null);
    return this.shadowRuntime;
  }

  disposeShadowRuntime() {
    this.shadowRuntime?.dispose();
    this.shadowRuntime = null;
  }

  setCoronaRuntime(runtime) {
    if (this.coronaRuntime === runtime) return this.coronaRuntime;
    this.disposeCoronaRuntime();
    this.coronaRuntime = runtime || null;
    this.coronaRuntime?.setRoot?.(this.pipelineController.root || null);
    return this.coronaRuntime;
  }

  disposeCoronaRuntime() {
    this.coronaRuntime?.dispose();
    this.coronaRuntime = null;
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
    this.disposeCoronaRuntime();
    this.disposeShadowRuntime();
  }
}

export default JsrwRendererSession;
