import * as THREE from 'three';
import { RW_MOON_DEBUG_DEFAULTS } from './RWMoonConstants';
import {
  calcScreenCoorsLikeRw,
  createRwSpriteMaterial,
  prepareRwSpriteTexture,
  setRwSpriteScreenPosition,
} from './RWSkySpriteUtils';
import { gtaPositionToThree } from './gtaTransforms';

function createFallbackMoonTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(128, 128, 8, 128, 128, 110);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.65, 'rgba(245,245,230,0.85)');
  gradient.addColorStop(1, 'rgba(220,220,210,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function resolveMoonScale(settings) {
  const moonSizeIndex = Number(settings?.moonSizeIndex);
  if (Number.isFinite(moonSizeIndex)) {
    return (THREE.MathUtils.clamp(moonSizeIndex, 0, 7) * 2) + 4;
  }
  return settings.smallMoon ? settings.smallMoonScale : settings.baseScale;
}

export class RWMoonPipeline {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    this.camera.position.set(0, 0, 1);
    this.fallbackTexture = createFallbackMoonTexture();
    this.sprite = new THREE.Sprite(createRwSpriteMaterial(this.fallbackTexture));
    this.sprite.renderOrder = 70;
    this.sprite.frustumCulled = false;
    this.scene.add(this.sprite);
    this.viewportWidth = 1;
    this.viewportHeight = 1;
    this.sprite.visible = false;
  }

  setViewport(width, height) {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
    this.camera.left = -this.viewportWidth * 0.5;
    this.camera.right = this.viewportWidth * 0.5;
    this.camera.top = this.viewportHeight * 0.5;
    this.camera.bottom = -this.viewportHeight * 0.5;
    this.camera.updateProjectionMatrix();
  }

  setTexture(texture) {
    this.sprite.material.map = prepareRwSpriteTexture(texture) || this.fallbackTexture;
    this.sprite.material.needsUpdate = true;
  }

  update(camera, timecycleSample, settings = RW_MOON_DEBUG_DEFAULTS) {
    if (!settings.enabled) {
      this.sprite.visible = false;
      return { visible: false, brightness: 0 };
    }

    const hour = Number(timecycleSample?.hour) || 0;
    const minuteOfHour = Number(timecycleSample?.minute) || 0;
    const totalMinutes = (hour * 60) + minuteOfHour;

    const NIGHT_START = 18 * 60;
    const NIGHT_END = 6 * 60;
    const FADE_DURATION = 180;

    const isEveningNight = totalMinutes >= NIGHT_START;
    const isMorningNight = totalMinutes < NIGHT_END;
    const isNight = isEveningNight || isMorningNight;

    if (!isNight) {
      this.sprite.visible = false;
      return { visible: false, brightness: 0 };
    }

    let fadeFactor = 1;
    if (isEveningNight) {
      const minutesIntoNight = totalMinutes - NIGHT_START;
      fadeFactor = minutesIntoNight < FADE_DURATION
        ? minutesIntoNight / FADE_DURATION
        : 1;
    } else {
      const minutesUntilDawn = NIGHT_END - totalMinutes;
      fadeFactor = minutesUntilDawn < FADE_DURATION
        ? minutesUntilDawn / FADE_DURATION
        : 1;
    }

    const foggyness = THREE.MathUtils.clamp(timecycleSample?.foggyness ?? 0, 0, 1);
    const cloudCoverage = THREE.MathUtils.clamp(timecycleSample?.cloudCoverage ?? 0, 0, 1);
    const coverage = settings.coverageDimming ? Math.max(foggyness, cloudCoverage) : 0;
    const brightness = THREE.MathUtils.clamp(
      (1 - coverage) * fadeFactor * 255 * settings.brightnessScale,
      0,
      255,
    );
    if (brightness <= 0.001) {
      this.sprite.visible = false;
      return { visible: false, brightness: 0 };
    }

    const offset = gtaPositionToThree(settings.offsetX, settings.offsetY, settings.offsetZ);
    const worldPosition = camera.position.clone().add(offset);
    const screen = calcScreenCoorsLikeRw(camera, worldPosition, this.viewportWidth, this.viewportHeight, false);
    if (!screen) {
      this.sprite.visible = false;
      return { visible: false, brightness: 0 };
    }

    const scale = resolveMoonScale(settings);
    const widthPx = Math.max(1, screen.spriteW * scale * 2);
    const heightPx = Math.max(1, screen.spriteH * scale * 2);
    this.sprite.visible = true;
    this.sprite.material.color.setRGB(brightness / 255, brightness / 255, brightness / 255, THREE.SRGBColorSpace);
    this.sprite.material.opacity = 1;
    setRwSpriteScreenPosition(this.sprite, screen.x, screen.y, this.viewportWidth, this.viewportHeight, widthPx, heightPx);
    return {
      visible: true,
      brightness,
      screenX: screen.x,
      screenY: screen.y,
    };
  }

  render(renderer) {
    if (!this.sprite.visible) return;
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.sprite.material.dispose();
    this.fallbackTexture.dispose();
  }
}
