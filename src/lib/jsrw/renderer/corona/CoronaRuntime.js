import { RWCoronaPipeline } from './RWCoronaPipeline.js';

export class CoronaRuntime {
  constructor(options = {}) {
    this.backend = options.backend || null;
    this.pipeline = new RWCoronaPipeline(options);
  }

  setRoot(root) {
    this.pipeline.setRoot(root);
  }

  setEnabled(enabled) {
    this.pipeline.setEnabled(enabled);
  }

  setDebugShowAll(enabled) {
    this.pipeline.setDebugShowAll(enabled);
  }

  setViewport(width, height) {
    this.pipeline.setViewport(width, height);
  }

  setEmitters(emitters) {
    this.pipeline.setEmitters(emitters);
  }

  setTextureDictionary(textureDictionary) {
    this.pipeline.setTextureDictionary(textureDictionary);
  }

  update(camera, runtimeContext = {}) {
    this.pipeline.update(camera, runtimeContext);
  }

  render(renderer) {
    this.pipeline.render(renderer);
  }

  dispose() {
    this.pipeline.dispose();
  }

  get raw() {
    return this.pipeline;
  }
}

export default CoronaRuntime;
