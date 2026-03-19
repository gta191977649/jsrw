import { RWMoonPipeline } from './RWMoonPipeline.js';
import { RWStarsPipeline } from './RWStarsPipeline.js';
import { RWSunPipeline } from './RWSunPipeline.js';

export class SkyRendererBundle {
  constructor() {
    this.moon = new RWMoonPipeline();
    this.stars = new RWStarsPipeline();
    this.sun = new RWSunPipeline();
  }

  setViewport(width, height) {
    this.moon.setViewport(width, height);
    this.stars.setViewport(width, height);
    this.sun.setViewport(width, height);
  }

  setParticleTextures({ moonTexture = null, starTexture = null, sunTextures = null } = {}) {
    this.moon.setTexture(moonTexture);
    this.stars.setTexture(starTexture);
    this.sun.setTextureSet(sunTextures || {});
  }

  prepareFrame(camera, timecycleSample, settings = {}) {
    const moon = this.moon.update(camera, timecycleSample, settings.moon);
    const stars = this.stars.update(camera, timecycleSample, settings.stars);
    const sunMetrics = this.sun.updateSunMetrics(camera, timecycleSample, settings.sun);
    return { moon, stars, sunMetrics };
  }

  finalizeSunFrame({
    camera,
    worldRoot,
    timecycleSample,
    settings,
    dt = 0,
    timeMs = 0,
    sunBlockedByClouds = false,
    sunMetrics = null,
    enableBigBloom = true,
  }) {
    return this.sun.update(
      camera,
      worldRoot,
      timecycleSample,
      settings?.sun,
      dt,
      timeMs,
      sunBlockedByClouds,
      sunMetrics,
      enableBigBloom,
    );
  }

  renderBackground(renderer) {
    this.moon.render(renderer);
    this.stars.render(renderer);
  }

  renderSun(renderer, options = {}) {
    this.sun.render(renderer, options);
  }

  dispose() {
    this.moon.dispose();
    this.stars.dispose();
    this.sun.dispose();
  }
}

export default SkyRendererBundle;
