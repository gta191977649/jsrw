import * as THREE from 'three';
import { gtaPositionToThree } from './gtaTransforms';
import { RW_SUN_DEBUG_DEFAULTS, RW_SUN_FLARE_DEFS } from './RWSunConstants';
import { getRWMaterialDescriptor } from './RWRender';
import {
  calcScreenCoorsLikeRw,
  createRwSpriteMaterial,
  prepareRwSpriteTexture,
  rwScreenFromNdc,
  setRwSpriteScreenPosition,
} from './RWSkySpriteUtils';

const SCREEN_HIDDEN = 1_000_000;
const TMP_NDC = new THREE.Vector3();
const TMP_GTA_SUN_DIR = new THREE.Vector3();
const TMP_THREE_SUN_DIR = new THREE.Vector3();
const TMP_CAMERA_DIR = new THREE.Vector3();

function clamp01(value) {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function createCanvasTexture(size, drawFn) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  drawFn(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function drawRadialSprite(ctx, size, stops) {
  const gradient = ctx.createRadialGradient(size * 0.5, size * 0.5, 0, size * 0.5, size * 0.5, size * 0.5);
  for (const stop of stops) {
    gradient.addColorStop(stop.offset, stop.color);
  }
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
}

function createStarTexture() {
  return createCanvasTexture(256, (ctx, size) => {
    drawRadialSprite(ctx, size, [
      { offset: 0.0, color: 'rgba(255,255,255,1)' },
      { offset: 0.12, color: 'rgba(255,255,255,0.95)' },
      { offset: 0.3, color: 'rgba(255,240,200,0.55)' },
      { offset: 0.6, color: 'rgba(255,220,160,0.12)' },
      { offset: 1.0, color: 'rgba(255,220,160,0)' },
    ]);
    ctx.save();
    ctx.translate(size * 0.5, size * 0.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = size * 0.03;
    for (const angle of [0, Math.PI * 0.25, Math.PI * 0.5, Math.PI * 0.75]) {
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * size * 0.08, Math.sin(angle) * size * 0.08);
      ctx.lineTo(Math.cos(angle) * size * 0.42, Math.sin(angle) * size * 0.42);
      ctx.stroke();
    }
    ctx.restore();
  });
}

function createHexTexture() {
  return createCanvasTexture(192, (ctx, size) => {
    drawRadialSprite(ctx, size, [
      { offset: 0.0, color: 'rgba(255,220,180,0.45)' },
      { offset: 0.6, color: 'rgba(255,150,80,0.12)' },
      { offset: 1.0, color: 'rgba(255,120,20,0)' },
    ]);
    ctx.save();
    ctx.translate(size * 0.5, size * 0.5);
    ctx.beginPath();
    for (let index = 0; index < 6; index += 1) {
      const angle = (Math.PI / 3) * index - (Math.PI / 6);
      const x = Math.cos(angle) * size * 0.34;
      const y = Math.sin(angle) * size * 0.34;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = size * 0.035;
    ctx.stroke();
    ctx.restore();
  });
}

function createCircleTexture() {
  return createCanvasTexture(192, (ctx, size) => {
    drawRadialSprite(ctx, size, [
      { offset: 0.0, color: 'rgba(255,255,255,0.7)' },
      { offset: 0.5, color: 'rgba(255,210,160,0.18)' },
      { offset: 1.0, color: 'rgba(255,180,120,0)' },
    ]);
  });
}

function createRingTexture() {
  return createCanvasTexture(192, (ctx, size) => {
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size * 0.5, size * 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.28, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = size * 0.06;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.38, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,180,90,0.18)';
    ctx.lineWidth = size * 0.03;
    ctx.stroke();
    ctx.restore();
  });
}

function computeRwSunDirection(timecycleSample) {
  const hour = Number(timecycleSample?.hour) || 0;
  const minute = Number(timecycleSample?.minute) || 0;
  const sunAngle = Math.PI * 2 * ((hour * 60) + minute) / (24 * 60);
  TMP_GTA_SUN_DIR.set(
    Math.sin(sunAngle),
    1,
    0.2 - Math.cos(sunAngle),
  ).normalize();
  TMP_THREE_SUN_DIR.copy(gtaPositionToThree(TMP_GTA_SUN_DIR.x, TMP_GTA_SUN_DIR.y, TMP_GTA_SUN_DIR.z)).normalize();
  return {
    gta: TMP_GTA_SUN_DIR.clone(),
    three: TMP_THREE_SUN_DIR.clone(),
  };
}

function findOcclusionFlags(object, stopAt) {
  let cursor = object;
  while (cursor) {
    const flags = cursor.userData?.rwIdeFlagsDecoded;
    if (flags) return flags;
    if (cursor === stopAt) break;
    cursor = cursor.parent;
  }
  return null;
}

function shouldIgnoreOcclusionHit(object, stopAt) {
  if (!object?.visible || !object?.isMesh) return true;
  if (object.userData?.rwInstanceSelectionProxy) return true;

  const flags = findOcclusionFlags(object, stopAt);
  if (flags?.isTree || flags?.isPalm || flags?.isGlass) return true;

  const materials = Array.isArray(object.material) ? object.material : [object.material];
  let hasEligibleMaterial = false;
  for (const material of materials) {
    if (!material) continue;
    const descriptor = getRWMaterialDescriptor(material);
    const bucket = descriptor?.renderBucket || 'opaque';
    const alphaMode = descriptor?.alphaMode || 'opaque';
    const alphaTest = Number(material.alphaTest) || 0;

    if (bucket === 'transparent' || bucket === 'additive' || bucket === 'overlay') continue;
    if (alphaMode === 'blend' || alphaMode === 'additive') continue;
    if (alphaTest > 0) continue;

    hasEligibleMaterial = true;
    break;
  }
  return !hasEligibleMaterial;
}

export class RWSunPipeline {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    this.camera.position.set(0, 0, 1);

    this.textures = {
      star: createStarTexture(),
      hex: createHexTexture(),
      circle: createCircleTexture(),
      ring: createRingTexture(),
    };

    this.coreSprite = new THREE.Sprite(createRwSpriteMaterial(this.textures.star));
    this.coronaSprite = new THREE.Sprite(createRwSpriteMaterial(this.textures.star));
    this.coreSprite.renderOrder = 80;
    this.coronaSprite.renderOrder = 79;
    this.scene.add(this.coronaSprite, this.coreSprite);

    this.flareSprites = RW_SUN_FLARE_DEFS.map((definition) => {
      const sprite = new THREE.Sprite(createRwSpriteMaterial(this.textures[definition.texture]));
      sprite.renderOrder = 78;
      this.scene.add(sprite);
      return sprite;
    });

    this.viewportWidth = 1;
    this.viewportHeight = 1;
    this.coreFadeAlpha = 0;
    this.coronaFadeAlpha = 0;
    this.occlusionAlpha = 1;
    this.occludedByWorld = false;
    this.sunVisible = false;
    this.sunAboveHorizon = false;
    this.sunCoronaVisible = false;
    this.sunWorldPosition = new THREE.Vector3();
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.sunScreen = { x: SCREEN_HIDDEN, y: SCREEN_HIDDEN };
    this.sunRwScreen = null;
    this.lastOcclusionCheckAt = -Infinity;
    this.occlusionRaycaster = new THREE.Raycaster();
    this.occlusionRaycaster.firstHitOnly = false;
    this.setVisible(false);
  }

  setTextureSet(textures = {}) {
    const star = prepareRwSpriteTexture(textures.star) || this.textures.star;
    const hex = prepareRwSpriteTexture(textures.hex) || this.textures.hex;
    const circle = prepareRwSpriteTexture(textures.circle) || this.textures.circle;
    const ring = prepareRwSpriteTexture(textures.ring) || this.textures.ring;

    this.coreSprite.material.map = star;
    this.coronaSprite.material.map = star;
    this.coreSprite.material.needsUpdate = true;
    this.coronaSprite.material.needsUpdate = true;

    for (let index = 0; index < this.flareSprites.length; index += 1) {
      const sprite = this.flareSprites[index];
      const definition = RW_SUN_FLARE_DEFS[index];
      if (definition.texture === 'hex') sprite.material.map = hex;
      if (definition.texture === 'circle') sprite.material.map = circle;
      if (definition.texture === 'ring') sprite.material.map = ring;
      sprite.material.needsUpdate = true;
    }
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

  setVisible(visible) {
    this.coreSprite.visible = visible;
    this.coronaSprite.visible = visible;
    for (const sprite of this.flareSprites) {
      sprite.visible = visible;
    }
  }

  updateSunMetrics(camera, timecycleSample, settings = RW_SUN_DEBUG_DEFAULTS) {
    const direction = computeRwSunDirection(timecycleSample);
    this.sunDirection.copy(direction.three);
    this.sunAboveHorizon = direction.gta.z > -0.2;
    this.sunCoronaVisible = direction.gta.z > 0;
    this.sunWorldPosition.copy(camera.position).addScaledVector(this.sunDirection, settings.distance);

    TMP_NDC.copy(this.sunWorldPosition).project(camera);
    const inClipSpace = TMP_NDC.z >= -1 && TMP_NDC.z <= 1;
    const onScreen = (
      TMP_NDC.x >= -1 && TMP_NDC.x <= 1
      && TMP_NDC.y >= -1 && TMP_NDC.y <= 1
    );
    this.sunVisible = this.sunAboveHorizon && inClipSpace && onScreen;
    if (this.sunVisible) {
      this.sunScreen = rwScreenFromNdc(TMP_NDC, this.viewportWidth, this.viewportHeight);
      this.sunRwScreen = calcScreenCoorsLikeRw(camera, this.sunWorldPosition, this.viewportWidth, this.viewportHeight);
    } else {
      this.sunScreen = { x: SCREEN_HIDDEN, y: SCREEN_HIDDEN };
      this.sunRwScreen = null;
    }
    return {
      visible: this.sunVisible,
      aboveHorizon: this.sunAboveHorizon,
      coronaVisible: this.sunCoronaVisible,
      screenX: this.sunScreen.x,
      screenY: this.sunScreen.y,
      rwScreen: this.sunRwScreen,
      worldPosition: this.sunWorldPosition,
      direction: this.sunDirection,
      gtaDirection: direction.gta,
    };
  }

  update(camera, worldRoot, timecycleSample, settings = RW_SUN_DEBUG_DEFAULTS, dt = 0, timeMs = 0, sunBlockedByClouds = false) {
    const metrics = this.updateSunMetrics(camera, timecycleSample, settings);
    const shouldCheckOcclusion = (
      settings.useWorldOcclusion
      && metrics.visible
      && (timeMs - this.lastOcclusionCheckAt) >= settings.occlusionCheckIntervalMs
    );

    if (shouldCheckOcclusion) {
      this.lastOcclusionCheckAt = timeMs;
      this.occludedByWorld = this.computeWorldOcclusion(camera, worldRoot);
      this.occlusionAlpha = this.occludedByWorld ? 0 : 1;
    } else if (!settings.useWorldOcclusion) {
      this.occludedByWorld = false;
      this.occlusionAlpha = 1;
    }

    const blockedByClouds = settings.useCloudOcclusion && sunBlockedByClouds;
    const coreTargetAlpha = (
      settings.enabled
      && metrics.aboveHorizon
      && metrics.visible
      && metrics.rwScreen
      && this.occlusionAlpha > 0.5
    ) ? 255 : 0;
    const coronaTargetAlpha = (
      settings.enabled
      && metrics.coronaVisible
      && metrics.visible
      && metrics.rwScreen
      && this.occlusionAlpha > 0.5
      && !blockedByClouds
    ) ? 255 : 0;
    const fadeStep = Math.max(0, settings.fadeSpeed) * Math.max(0, dt) * 30;
    if (settings.debugBypassFade) {
      this.coreFadeAlpha = coreTargetAlpha;
      this.coronaFadeAlpha = coronaTargetAlpha;
    } else {
      if (this.coreFadeAlpha < coreTargetAlpha) this.coreFadeAlpha = Math.min(this.coreFadeAlpha + fadeStep, coreTargetAlpha);
      else if (this.coreFadeAlpha > coreTargetAlpha) this.coreFadeAlpha = Math.max(this.coreFadeAlpha - fadeStep, coreTargetAlpha);

      if (this.coronaFadeAlpha < coronaTargetAlpha) this.coronaFadeAlpha = Math.min(this.coronaFadeAlpha + fadeStep, coronaTargetAlpha);
      else if (this.coronaFadeAlpha > coronaTargetAlpha) this.coronaFadeAlpha = Math.max(this.coronaFadeAlpha - fadeStep, coronaTargetAlpha);
    }

    this.applySpriteState(camera, timecycleSample, settings, timeMs);

    return {
      ...metrics,
      blockedByClouds,
      occludedByWorld: this.occludedByWorld,
      fadeAlpha: this.coronaFadeAlpha / 255,
      coreFadeAlpha: this.coreFadeAlpha / 255,
    };
  }

  computeWorldOcclusion(camera, worldRoot) {
    if (!worldRoot) return false;
    TMP_CAMERA_DIR.copy(this.sunDirection).normalize();
    if (TMP_CAMERA_DIR.lengthSq() <= 0.0001) return false;
    this.occlusionRaycaster.layers.enableAll();
    this.occlusionRaycaster.set(camera.position, TMP_CAMERA_DIR);
    this.occlusionRaycaster.far = camera.far;
    const hits = this.occlusionRaycaster.intersectObject(worldRoot, true);
    for (const hit of hits) {
      const object = hit?.object;
      if (shouldIgnoreOcclusionHit(object, worldRoot)) continue;
      return true;
    }
    return false;
  }

  applySpriteState(camera, timecycleSample, settings, timeMs) {
    if (!settings.enabled || !this.sunVisible || !this.sunRwScreen) {
      this.setVisible(false);
      return;
    }

    const showCore = this.coreFadeAlpha > 0.001 && this.sunAboveHorizon;
    const showCorona = this.coronaFadeAlpha > 0.001 && this.sunCoronaVisible;
    this.coreSprite.visible = showCore;
    this.coronaSprite.visible = showCorona;
    for (const sprite of this.flareSprites) {
      sprite.visible = showCorona;
    }

    if (!showCore && !showCorona) return;

    const values = timecycleSample?.values || {};
    const coreColor = values.sunCore || { r: 255, g: 255, b: 255 };
    const coronaColor = values.sunCorona || { r: 255, g: 255, b: 255 };
    const screen = this.sunRwScreen;
    const randomTerm = (((Math.floor(timeMs / (1000 / 30)) * 1103515245) + 12345) >>> 16) & 0xFF;
    const jitter = randomTerm * 0.005 * settings.coreJitterAmplitude;
    const coreWorldSize = (settings.coreSizeBias + jitter) * (values.sunSize || 1) * settings.coreSizeScale;
    const coronaWorldSize = settings.coronaSizeScale * (values.sunSize || 1);
    const fogScale = 1;
    const rotation = 20.0 * screen.recipZ;
    const coreWidthPx = Math.max(1, screen.spriteW * coreWorldSize * fogScale * 2);
    const coreHeightPx = Math.max(1, screen.spriteH * coreWorldSize * fogScale * 2);
    const coronaWidthPx = Math.max(1, screen.spriteW * coronaWorldSize * fogScale * 2);
    const coronaHeightPx = Math.max(1, screen.spriteH * coronaWorldSize * fogScale * 2);

    this.coreSprite.material.color.setRGB(coreColor.r / 255, coreColor.g / 255, coreColor.b / 255, THREE.SRGBColorSpace);
    this.coronaSprite.material.color.setRGB(coronaColor.r / 255, coronaColor.g / 255, coronaColor.b / 255, THREE.SRGBColorSpace);
    this.coreSprite.material.rotation = rotation;
    this.coronaSprite.material.rotation = rotation;
    this.coreSprite.material.opacity = clamp01((this.coreFadeAlpha / 255) * settings.coreAlpha);
    this.coronaSprite.material.opacity = clamp01((this.coronaFadeAlpha / 255) * settings.coronaAlpha);

    setRwSpriteScreenPosition(this.coreSprite, screen.x, screen.y, this.viewportWidth, this.viewportHeight, coreWidthPx, coreHeightPx);
    setRwSpriteScreenPosition(this.coronaSprite, screen.x, screen.y, this.viewportWidth, this.viewportHeight, coronaWidthPx, coronaHeightPx);

    const centerX = this.viewportWidth * 0.5;
    const centerY = this.viewportHeight * 0.5;
    for (let index = 0; index < this.flareSprites.length; index += 1) {
      const sprite = this.flareSprites[index];
      const definition = RW_SUN_FLARE_DEFS[index];
      const flareHalfWidthPx = Math.max(1, 4 * definition.size * (screen.spriteW / screen.spriteH) * settings.flareScale);
      const flareHalfHeightPx = Math.max(1, 4 * definition.size * settings.flareScale);
      const flareX = centerX + ((screen.x - centerX) * definition.position * settings.flareOffsetScale);
      const flareY = centerY + ((screen.y - centerY) * definition.position * settings.flareOffsetScale);
      sprite.material.color.setRGB(
        ((definition.color.r * coronaColor.r) / 255) / 255,
        ((definition.color.g * coronaColor.g) / 255) / 255,
        ((definition.color.b * coronaColor.b) / 255) / 255,
        THREE.SRGBColorSpace,
      );
      sprite.material.rotation = 0;
      sprite.material.opacity = clamp01((this.coronaFadeAlpha / 255) * (definition.alpha / 255) * settings.flareAlphaScale);
      setRwSpriteScreenPosition(sprite, flareX, flareY, this.viewportWidth, this.viewportHeight, flareHalfWidthPx * 2, flareHalfHeightPx * 2);
    }
  }

  render(renderer) {
    if (this.coreFadeAlpha <= 0.0001 && this.coronaFadeAlpha <= 0.0001) return;
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = previousAutoClear;
  }

  dispose() {
    this.coreSprite.material.dispose();
    this.coronaSprite.material.dispose();
    for (const sprite of this.flareSprites) {
      sprite.material.dispose();
    }
    Object.values(this.textures).forEach((texture) => texture.dispose());
  }
}
