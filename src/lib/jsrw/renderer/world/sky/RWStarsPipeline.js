import * as THREE from 'three';
import {
  RW_STAR_COORDS_X,
  RW_STAR_COORDS_Y,
  RW_STAR_SIZES,
  RW_STARS_DEBUG_DEFAULTS,
} from './constants/RWStarsConstants.js';
import {
  calcScreenCoorsLikeRw,
  createRwSpriteMaterial,
  prepareRwSpriteTexture,
  setRwSpriteScreenPosition,
} from './RWSpriteUtils.js';
import { gtaPositionToThree } from '../../../utils/gtaTransforms.js';

function createFallbackStarTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 2, 64, 64, 48);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,220,0.95)');
  gradient.addColorStop(0.6, 'rgba(255,235,180,0.45)');
  gradient.addColorStop(1, 'rgba(255,230,160,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function computeRwStarIntensity(hour, minute) {
  if (hour < 22 && hour > 5) return 0;
  if (hour > 22 || hour < 5) return 255;
  if (hour === 22) return 255 * (minute / 60);
  if (hour === 5) return 255 * ((60 - minute) / 60);
  return 0;
}

export class RWStarsPipeline {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    this.camera.position.set(0, 0, 1);
    this.viewportWidth = 1;
    this.viewportHeight = 1;
    this.fallbackTexture = createFallbackStarTexture();
    this.logoSprites = Array.from({ length: 11 }, () => {
      const sprite = new THREE.Sprite(createRwSpriteMaterial(this.fallbackTexture));
      sprite.renderOrder = 60;
      sprite.visible = false;
      this.scene.add(sprite);
      return sprite;
    });
    this.sparkleSprite = new THREE.Sprite(createRwSpriteMaterial(this.fallbackTexture));
    this.sparkleSprite.renderOrder = 61;
    this.sparkleSprite.visible = false;
    this.scene.add(this.sparkleSprite);
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
    const nextTexture = prepareRwSpriteTexture(texture) || this.fallbackTexture;
    for (const sprite of this.logoSprites) {
      sprite.material.map = nextTexture;
      sprite.material.needsUpdate = true;
    }
    this.sparkleSprite.material.map = nextTexture;
    this.sparkleSprite.material.needsUpdate = true;
  }

  hideAll() {
    for (const sprite of this.logoSprites) sprite.visible = false;
    this.sparkleSprite.visible = false;
  }

  update(camera, timecycleSample, settings = RW_STARS_DEBUG_DEFAULTS) {
    if (!settings.enabled) {
      this.hideAll();
      return { visible: false, brightness: 0, starIntensity: 0 };
    }

    const hour = Number(timecycleSample?.hour) || 0;
    const minute = Number(timecycleSample?.minute) || 0;
    const starIntensity = computeRwStarIntensity(hour, minute);
    if (starIntensity <= 0) {
      this.hideAll();
      return { visible: false, brightness: 0, starIntensity };
    }

    const foggyness = THREE.MathUtils.clamp(timecycleSample?.foggyness ?? 0, 0, 1);
    const cloudCoverage = THREE.MathUtils.clamp(timecycleSample?.cloudCoverage ?? 0, 0, 1);
    const coverage = settings.coverageDimming ? Math.max(foggyness, cloudCoverage) : 0;
    const brightness = THREE.MathUtils.clamp((1 - coverage) * starIntensity * settings.brightnessScale, 0, 255);
    if (brightness <= 0.001) {
      this.hideAll();
      return { visible: false, brightness: 0, starIntensity };
    }

    const colorScalar = brightness / 255;
    let visibleCount = 0;
    for (let index = 0; index < this.logoSprites.length; index += 1) {
      const sprite = this.logoSprites[index];
      const coordIndex = index % RW_STAR_COORDS_X.length;
      const offsetX = index >= 9 ? -settings.logoOffsetX : settings.logoOffsetX;
      const offsetY = settings.logoOffsetY - (settings.logoSpanY * RW_STAR_COORDS_X[coordIndex]);
      const offsetZ = settings.logoOffsetZ + (settings.logoSpanZ * RW_STAR_COORDS_Y[coordIndex]);
      const worldPosition = camera.position.clone().add(gtaPositionToThree(offsetX, offsetY, offsetZ));
      const screen = calcScreenCoorsLikeRw(camera, worldPosition, this.viewportWidth, this.viewportHeight, false);
      if (!screen) {
        sprite.visible = false;
        continue;
      }

      const spriteScale = settings.starScale * RW_STAR_SIZES[coordIndex];
      const widthPx = Math.max(1, screen.spriteW * spriteScale * 2);
      const heightPx = Math.max(1, screen.spriteH * spriteScale * 2);
      sprite.visible = true;
      sprite.material.color.setRGB(colorScalar, colorScalar, colorScalar, THREE.SRGBColorSpace);
      sprite.material.opacity = 1;
      setRwSpriteScreenPosition(
        sprite,
        screen.x,
        screen.y,
        this.viewportWidth,
        this.viewportHeight,
        widthPx,
        heightPx,
      );
      visibleCount += 1;
    }

    const sparkleWorldPosition = camera.position.clone().add(
      gtaPositionToThree(
        settings.logoOffsetX,
        settings.logoOffsetY + settings.sparkleOffsetY,
        settings.logoOffsetZ,
      ),
    );
    const sparkleScreen = calcScreenCoorsLikeRw(
      camera,
      sparkleWorldPosition,
      this.viewportWidth,
      this.viewportHeight,
      false,
    );
    if (sparkleScreen) {
      const sparkleFactor = settings.sparkleMinFlicker + (Math.random() * settings.sparkleFlickerRange);
      const sparkleScalar = THREE.MathUtils.clamp((brightness * sparkleFactor) / 255, 0, 1);
      this.sparkleSprite.visible = true;
      this.sparkleSprite.material.color.setRGB(
        sparkleScalar,
        sparkleScalar,
        sparkleScalar,
        THREE.SRGBColorSpace,
      );
      this.sparkleSprite.material.opacity = 1;
      setRwSpriteScreenPosition(
        this.sparkleSprite,
        sparkleScreen.x,
        sparkleScreen.y,
        this.viewportWidth,
        this.viewportHeight,
        Math.max(1, sparkleScreen.spriteW * settings.sparkleScale * 2),
        Math.max(1, sparkleScreen.spriteH * settings.sparkleScale * 2),
      );
      visibleCount += 1;
    } else {
      this.sparkleSprite.visible = false;
    }

    return {
      visible: visibleCount > 0,
      visibleCount,
      brightness,
      starIntensity,
    };
  }

  render(renderer) {
    if (!this.logoSprites.some((sprite) => sprite.visible) && !this.sparkleSprite.visible) return;
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    for (const sprite of this.logoSprites) {
      sprite.material.dispose();
    }
    this.sparkleSprite.material.dispose();
    this.fallbackTexture.dispose();
  }
}
