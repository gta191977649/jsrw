import { RWWaterPipeline } from './RWWaterPipeline.js';

export class WaterRuntime {
  constructor(options = {}) {
    this.backend = options.backend || null;
    this.pipeline = new RWWaterPipeline(options);
  }

  setBackend(backend) {
    this.backend = backend || null;
  }

  applySettings(settings) {
    this.pipeline.applySettings(settings);
  }

  setTexture(texture) {
    this.pipeline.setTexture(texture);
  }

  setEnabled(enabled) {
    this.pipeline.setEnabled(enabled);
  }

  setWireframe(enabled) {
    this.pipeline.setWireframe(enabled);
  }

  setTimecycleProvider(provider) {
    this.pipeline.setTimecycleProvider(provider);
  }

  hasRenderableWater() {
    return this.pipeline.hasRenderableWater();
  }

  getWaterCellCount() {
    return this.pipeline.getWaterCellCount();
  }

  update(camera, timeMs, dt) {
    this.pipeline.update(camera, timeMs, dt);
  }

  renderFar(renderer, camera, background) {
    this.pipeline.renderFar(renderer, camera, background);
  }

  renderNear(renderer, camera) {
    this.pipeline.renderNear(renderer, camera);
  }

  renderWavy(renderer, camera) {
    this.pipeline.renderWavy(renderer, camera);
  }

  renderWake(renderer, camera) {
    this.pipeline.renderWake(renderer, camera);
  }

  dispose() {
    this.pipeline.dispose();
  }

  get raw() {
    return this.pipeline;
  }
}

export default WaterRuntime;
