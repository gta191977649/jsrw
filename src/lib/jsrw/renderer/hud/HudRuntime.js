import { HudPipeline } from './HudPipeline.js';

export class HudRuntime {
  constructor(options = {}) {
    this.backend = options.backend || null;
    this.pipeline = new HudPipeline(options);
  }

  setViewport(width, height) {
    this.pipeline.setViewport(width, height);
  }

  setIconTextures(iconTextures) {
    this.pipeline.setIconTextures(iconTextures);
  }

  setGameVersion(gameVersion) {
    this.pipeline.setGameVersion(gameVersion);
  }

  setShowGameIcon(showGameIcon) {
    this.pipeline.setShowGameIcon(showGameIcon);
  }

  setSubtitleCue(cue) {
    this.pipeline.setSubtitleCue(cue);
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

export default HudRuntime;
