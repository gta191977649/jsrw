import * as THREE from 'three';

export const DISTANCE_FADE_DEFAULTS = Object.freeze({
  window: 20,
  streamAlphaPerSecond: 7.5,
  epsilon: 0.001,
});

export function resolveDistanceFadeConfig(config = null) {
  return {
    window: Math.max(0, Number(config?.window) || DISTANCE_FADE_DEFAULTS.window),
    streamAlphaPerSecond: Math.max(0, Number(config?.streamAlphaPerSecond) || DISTANCE_FADE_DEFAULTS.streamAlphaPerSecond),
    epsilon: THREE.MathUtils.clamp(Number(config?.epsilon) || DISTANCE_FADE_DEFAULTS.epsilon, 1e-6, 0.1),
  };
}

export function approachValue(current, target, delta) {
  if (current < target) return Math.min(current + delta, target);
  if (current > target) return Math.max(current - delta, target);
  return current;
}

export function resolveRenderableDistance(value, fallback) {
  if (Number.isFinite(value) && value > 0) return value;
  return fallback;
}

export function isDistanceWithinFadeWindow(distance, endDistance, config = null) {
  if (!Number.isFinite(endDistance) || endDistance <= 0) return true;
  const fadeConfig = resolveDistanceFadeConfig(config);
  return distance <= (endDistance + fadeConfig.window);
}

export function computeDistanceFadeAlpha(distance, endDistance, config = null) {
  if (!Number.isFinite(endDistance) || endDistance <= 0) return 1;
  const fadeConfig = resolveDistanceFadeConfig(config);
  if (distance <= endDistance) return 1;
  if (fadeConfig.window <= 0) return 0;
  return THREE.MathUtils.clamp((endDistance + fadeConfig.window - distance) / fadeConfig.window, 0, 1);
}
