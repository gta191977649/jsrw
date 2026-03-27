import * as THREE from 'three';
import {
  TIMECYCLE_FIELD_GROUPS,
} from '../../utils/Timecycle.js';
import { RW_PIPELINE_CATEGORY } from '../../core/pipeline/constants.js';

const TIMECYCLE_FIELD_MAP = new Map(TIMECYCLE_FIELD_GROUPS.map((field) => [field.key, field]));

export const RW_DFF_LIGHT_TYPE = Object.freeze({
  DIRECTIONAL: 0x01,
  AMBIENT: 0x02,
  POINT: 0x80,
  SPOT: 0x81,
  SPOTSOFT: 0x82,
});

export function createResourceCacheState() {
  return {
    rawAssetCache: new Map(),
    parsedTxdCache: new Map(),
    modelTemplateCache: new Map(),
    missingDff: new Set(),
    missingTxd: new Set(),
  };
}

export function toPlainVector(vector) {
  return {
    x: Number(vector?.x) || 0,
    y: Number(vector?.y) || 0,
    z: Number(vector?.z) || 0,
  };
}

export function map2dfxVisibilityMode(lightType, IDE_LIGHT_TYPE) {
  switch (Number(lightType)) {
    case IDE_LIGHT_TYPE.ON_NIGHT: return 'night';
    case IDE_LIGHT_TYPE.FLICKER: return 'flicker';
    case IDE_LIGHT_TYPE.FLICKER_NIGHT: return 'flicker-night';
    case IDE_LIGHT_TYPE.FLASH1: return 'flash1';
    case IDE_LIGHT_TYPE.FLASH1_NIGHT: return 'flash1-night';
    case IDE_LIGHT_TYPE.FLASH2: return 'flash2';
    case IDE_LIGHT_TYPE.FLASH2_NIGHT: return 'flash2-night';
    case IDE_LIGHT_TYPE.FLASH3: return 'flash3';
    case IDE_LIGHT_TYPE.FLASH3_NIGHT: return 'flash3-night';
    case IDE_LIGHT_TYPE.RANDOM_FLICKER: return 'random-flicker';
    case IDE_LIGHT_TYPE.RANDOM_FLICKER_NIGHT: return 'random-flicker-night';
    case IDE_LIGHT_TYPE.BRIDGE_FLASH1: return 'bridge-flash1';
    case IDE_LIGHT_TYPE.BRIDGE_FLASH2: return 'bridge-flash2';
    default: return 'always';
  }
}

export function mapDffLightKind(lightType) {
  switch (Number(lightType)) {
    case RW_DFF_LIGHT_TYPE.AMBIENT: return 'ambient';
    case RW_DFF_LIGHT_TYPE.DIRECTIONAL: return 'directional';
    case RW_DFF_LIGHT_TYPE.POINT: return 'point';
    case RW_DFF_LIGHT_TYPE.SPOT: return 'spot';
    case RW_DFF_LIGHT_TYPE.SPOTSOFT: return 'spotsoft';
    default: return '';
  }
}

export function cloneTimecycleValue(value, type) {
  if (type === 'rgb' || type === 'rgba') return { ...(value || {}) };
  return Number.isFinite(Number(value)) ? Number(value) : value;
}

export function toThreeColorFromTimecycleValue(value) {
  return new THREE.Color().setRGB(
    THREE.MathUtils.clamp((Number(value?.r) || 0) / 255, 0, 1),
    THREE.MathUtils.clamp((Number(value?.g) || 0) / 255, 0, 1),
    THREE.MathUtils.clamp((Number(value?.b) || 0) / 255, 0, 1),
    THREE.SRGBColorSpace,
  );
}

export function applyTimecycleOverrides(sampled, overrides) {
  if (!sampled || !overrides || Object.keys(overrides).length === 0) return sampled;
  const next = {
    ...sampled,
    values: { ...sampled.values },
    three: { ...sampled.three },
  };
  for (const [key, overrideValue] of Object.entries(overrides)) {
    const field = TIMECYCLE_FIELD_MAP.get(key);
    if (!field) continue;
    next.values[key] = cloneTimecycleValue(overrideValue, field.type);
  }
  if (next.values.blur) {
    const blurAlpha = Number.isFinite(Number(next.values.blurAlpha)) ? Number(next.values.blurAlpha) : 0;
    next.values.postfx1 = {
      r: next.values.blur.r,
      g: next.values.blur.g,
      b: next.values.blur.b,
      a: blurAlpha,
    };
    next.values.postfx2 = {
      r: next.values.blur.r,
      g: next.values.blur.g,
      b: next.values.blur.b,
      a: blurAlpha,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'fogColor') && next.values.skyTop && next.values.skyBottom) {
    next.values.fogColor = {
      r: (next.values.skyTop.r + (2 * next.values.skyBottom.r)) / 3,
      g: (next.values.skyTop.g + (2 * next.values.skyBottom.g)) / 3,
      b: (next.values.skyTop.b + (2 * next.values.skyBottom.b)) / 3,
    };
  }
  if (next.values.skyTop) next.three.skyTop = toThreeColorFromTimecycleValue(next.values.skyTop);
  if (next.values.skyBottom) next.three.skyBottom = toThreeColorFromTimecycleValue(next.values.skyBottom);
  if (next.values.fogColor) next.three.fogColor = toThreeColorFromTimecycleValue(next.values.fogColor);
  else if (sampled.three.fogColor?.isColor) next.three.fogColor = sampled.three.fogColor.clone();
  if (next.values.water) next.three.waterColor = toThreeColorFromTimecycleValue(next.values.water);
  return next;
}

export function getTimecyclePostFxControlValues(values) {
  if (!values?.blur) return null;
  return {
    trailsLimit: Math.round(THREE.MathUtils.clamp(Number(values.radiosityLimit) || 0, 0, 255)),
    trailsIntensity: Math.round(THREE.MathUtils.clamp(Number(values.radiosityIntensity) || 0, 0, 63)),
    blurOffset: THREE.MathUtils.clamp(Number(values.blurOffset) || 0, 0, 32),
    blurIntensity: THREE.MathUtils.clamp(((Number(values.postfx1?.a ?? values.blurAlpha) || 0) * 0.8) / 255, 0, 1),
  };
}

export function getTimecyclePostFxControlSignature(values) {
  const postFx = getTimecyclePostFxControlValues(values);
  if (!postFx) return 'none';
  return JSON.stringify(postFx);
}

export function createRwPipelineTarget(gameVersion, isTobj) {
  return {
    category: RW_PIPELINE_CATEGORY.BUILDING,
    game: String(gameVersion || '').toUpperCase(),
    isTobj: Boolean(isTobj),
  };
}
