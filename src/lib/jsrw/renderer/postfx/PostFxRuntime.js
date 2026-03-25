import RWPostFxPipeline from './RWPostFxPipeline.js';

export class PostFxRuntime {
  constructor(options = {}) {
    this.backend = options.backend || null;
    this.pipeline = new RWPostFxPipeline({
      backend: this.backend,
      config: options.config || {},
    });
  }

  setBackend(backend) {
    this.backend = backend || null;
    this.pipeline.setBackend?.(this.backend);
  }

  setConfig(config) {
    this.pipeline.setConfig(config);
  }

  updateRuntime(runtimeContext) {
    this.pipeline.updateRuntime(runtimeContext);
  }

  beginSceneCapture(runtimeContext) {
    return this.pipeline.beginSceneCapture(runtimeContext);
  }

  render(renderer, runtimeContext) {
    this.pipeline.render(renderer, runtimeContext);
  }

  getDebugPreviewTextures() {
    if (this.backend?.getCapabilities && !this.backend.getCapabilities().supportsDebugTargets) return [];
    return this.pipeline.getDebugPreviewTextures();
  }

  dispose() {
    this.pipeline.dispose();
  }
}

export default PostFxRuntime;
