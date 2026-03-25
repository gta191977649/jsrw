import { RWShadowPipeline } from './RWShadowPipeline.js';

export class ShadowRuntime {
  constructor(options = {}) {
    this.backend = options.backend || null;
    this.pipeline = new RWShadowPipeline(options);
  }

  setBackend(backend) {
    this.backend = backend || null;
  }

  setRoot(root) {
    this.pipeline.setRoot(root);
  }

  setEnabled(enabled) {
    this.pipeline.setEnabled(enabled);
  }

  setEmitters(emitters) {
    this.pipeline.setEmitters(emitters);
  }

  setTextureDictionary(textureDictionary) {
    this.pipeline.setTextureDictionary(textureDictionary);
  }

  markSceneMeshesDirty() {
    this.pipeline.markSceneMeshesDirty();
  }

  update(camera, runtimeContext = {}) {
    this.pipeline.update(camera, runtimeContext);
  }

  render(renderer, camera) {
    this.pipeline.render(renderer, camera);
  }

  dispose() {
    this.pipeline.dispose();
  }

  get raw() {
    return this.pipeline;
  }
}

export default ShadowRuntime;
