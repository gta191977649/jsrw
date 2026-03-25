import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { playerController as createExternalPlayerController } from 'three-player-controller';
import {
  createAppSessionController,
  createResourceCacheState,
  pushLoadedFileEntry,
} from './app/runtime/AppSessionController.js';
import { formatConsoleArg } from './lib/console';
import {
  DISTANCE_FADE_DEFAULTS,
} from './lib/jsrw/gta/core/DistanceFade.js';
import { createFrameVisibilityResult } from './lib/jsrw/gta/core/FrameVisibility.js';
import {
  createChunkOcclusionState,
} from './lib/jsrw/gta/core/Occlusion.js';
import { createDefaultTimecycleState } from './lib/jsrw/core/TimecycleState.js';
import { WORLD_UP } from './lib/jsrw/utils/gtaTransforms.js';
import { IDE_LIGHT_FLAG, IDE_LIGHT_TYPE, normalizePath } from './lib/jsrw/gta/loaders/SectionLoader.js';
import { TIMECYCLE_FIELD_GROUPS, VCS_WEATHER_NAMES } from './lib/jsrw/utils/Timecycle.js';
import { PlayerControllerAdapter } from './lib/playerControllerAdapter';
import { APP_MODE_EDITOR, APP_MODE_TEST, PlayerModeManager } from './lib/PlayerModeManager';
import {
  calcScreenCoorsLikeRw,
  cloneRWPipelineSelections,
  createJsrwGtaSession,
  getRWPipelineGameOptions,
  getRWPipelinePlatformOptions,
  RW_MOON_DEBUG_DEFAULTS,
  RW_PIPELINE_CATEGORY,
  RW_PIPELINE_PLATFORM,
  RW_PIPELINE_SELECTION_DEFAULTS,
  RW_STARS_DEBUG_DEFAULTS,
  RW_SUN_DEBUG_DEFAULTS,
  SkyRendererBundle,
  ThreeRendererHost,
} from './lib/jsrw';
import { prepareRwSpriteTexture } from './lib/jsrw/renderer/world/sky/RWSpriteUtils.js';
import {
  disposeWorld,
  WORLD_CHUNK_SIZE,
} from './lib/jsrw/utils/worldUtils.js';
import { WINDOW_DEFS } from './ui/windows';
import {
  applyObjectSelectionHighlight,
  clearObjectSelectionHighlight,
  getSelectableRootFromObject,
} from './lib/selection';
import saIcon from './assets/sa.png';
import vcsIcon from './assets/vcs.png';
import vcsDefaultMapUrl from './assets/maps/vcs.zip?url';
import { createSkyNodeMaterial } from './shaders/sky.node.js';
import './App.css';

const MAX_CONSOLE_LINES = 500;
const MAX_FAILED_MODELS = 5000;
const DEFAULT_SCENE_BACKGROUND = new THREE.Color(0x8ea9b5);
const CHUNK_ACTIVE_MARGIN = 384;
const CHUNK_SPHERE_PADDING = WORLD_CHUNK_SIZE * 0.75;
const CHUNK_CULL_MARGIN_XZ = WORLD_CHUNK_SIZE * 1.0;
const CHUNK_CULL_MARGIN_Y = WORLD_CHUNK_SIZE * 1.5;
const BIG_BUILDING_MIN_HEIGHT = WORLD_CHUNK_SIZE * 1.5;
const BIG_BUILDING_MIN_SPAN = WORLD_CHUNK_SIZE * 1.25;
const BIG_BUILDING_MIN_AREA = WORLD_CHUNK_SIZE * WORLD_CHUNK_SIZE * 0.75;
const BIG_BUILDING_MIN_LOD_DISTANCE = 400;
const ENABLE_WORLD_INSTANCING = true;
const STREAMING_BUILD_PLACEMENT_BUDGET = 8;
const STREAMING_BUILD_FRAME_BUDGET_MS = 8;
const RW_DISTANCE_FADE_WINDOW = DISTANCE_FADE_DEFAULTS.window;
const RW_STREAM_ALPHA_PER_SECOND = DISTANCE_FADE_DEFAULTS.streamAlphaPerSecond;
const RW_FADE_EPSILON = DISTANCE_FADE_DEFAULTS.epsilon;
const SKY_SMALL_STRIP_HEIGHT = 4 / 400;
const SKY_HORIZON_STRIP_HEIGHT = 48 / 400;
const SKY_DEFAULT_TOP = DEFAULT_SCENE_BACKGROUND.clone().offsetHSL(0, 0, -0.08);
const SKY_DEFAULT_BOTTOM = DEFAULT_SCENE_BACKGROUND.clone();
const SKY_DEFAULT_FOG = DEFAULT_SCENE_BACKGROUND.clone();
const RW_PIPELINE_FALLBACK_AMBIENT = new THREE.Color(1, 1, 1);
const RW_PIPELINE_FALLBACK_EMISSIVE = new THREE.Color(0, 0, 0);
const TRAFFIC_LIGHT_DEBUG_DEFAULTS = Object.freeze({
  enabled: true,
  ignoreFacing: false,
  forcePhase: 'auto',
  windBlinking: false,
  windStrength: 0,
  brightnessScale: 0.7,
  sizeScale: 1,
});
const TWO_DFX_DEBUG_DEFAULTS = Object.freeze({
  maxActiveCoronas: 96,
});
const SHADOW_DEBUG_DEFAULTS = Object.freeze({
  enabled: true,
  wireframe: false,
  rebuildEveryFrame: false,
  intensityScale: 1,
  sizeScale: 1,
  zDistanceScale: 1,
  drawDistanceScale: 1,
  heightBias: 0.03,
  maxActiveShadows: 48,
});
const FRAME_STAGE_DEBUG_DEFAULTS = Object.freeze({
  skyDome: true,
  skyBackdrop: true,
  skyClouds: true,
  sceneOpaque: true,
  waterFar: true,
  waterNear: true,
  waterWavy: true,
  waterWake: true,
  sceneTransparent: true,
  sceneBlend: true,
  sceneAdditive: true,
  sceneOverlay: true,
  coronas: true,
  postFx: true,
  sunBloom: true,
  sunFinal: true,
  hud: true,
});
const STATS_WINDOW_DEFAULT_POS = Object.freeze({ x: 460, y: 270 });
const STATS_WINDOW_DEFAULT_SIZE = Object.freeze({ x: 360, y: 250 });
const STATS_WINDOW_MIN_SIZE = Object.freeze({ x: 260, y: 200 });
const STATS_WINDOW_MAX_SIZE = Object.freeze({ x: 960, y: 720 });
const STATS_WINDOW_PADDING = Object.freeze({ x: 14, y: 12 });
const STATS_WINDOW_ITEM_SPACING = Object.freeze({ x: 6, y: 4 });
const STATS_COLOR_WINDOW_BG = Object.freeze({ x: 0.02, y: 0.02, z: 0.02, w: 0.92 });
const STATS_COLOR_BORDER = Object.freeze({ x: 0.92, y: 0.92, z: 0.92, w: 0.95 });
const STATS_COLOR_FRAME_BG = Object.freeze({ x: 0.05, y: 0.05, z: 0.05, w: 1.0 });
const STATS_COLOR_PLOT_LINE = Object.freeze({ x: 0.56, y: 0.72, z: 1.0, w: 1.0 });
const STATS_COLOR_PLOT_LINE_HOVER = Object.freeze({ x: 0.88, y: 0.92, z: 1.0, w: 1.0 });
const STATS_COLOR_HEADER = Object.freeze({ x: 0.08, y: 0.08, z: 0.08, w: 1.0 });
const STATS_COLOR_HEADER_HOVER = Object.freeze({ x: 0.12, y: 0.12, z: 0.12, w: 1.0 });
const STATS_COLOR_HEADER_ACTIVE = Object.freeze({ x: 0.16, y: 0.16, z: 0.16, w: 1.0 });
const STATS_COLOR_TEXT = Object.freeze({ x: 1.0, y: 1.0, z: 1.0, w: 1.0 });
const STATS_COLOR_FPS = Object.freeze({ x: 0.94, y: 0.78, z: 0.34, w: 1.0 });
const STATS_COLOR_FRAME = Object.freeze({ x: 0.48, y: 0.80, z: 1.0, w: 1.0 });
const STATS_COLOR_TRIANGLES = Object.freeze({ x: 0.58, y: 0.90, z: 0.55, w: 1.0 });
const STATS_COLOR_GRID = Object.freeze({ x: 0.85, y: 0.92, z: 1.0, w: 0.22 });
const STATS_COLOR_GRAPH_BORDER = Object.freeze({ x: 0.92, y: 0.92, z: 0.92, w: 0.55 });
const RW_DFF_LIGHT_TYPE = Object.freeze({
  DIRECTIONAL: 0x01,
  AMBIENT: 0x02,
  POINT: 0x80,
  SPOT: 0x81,
  SPOTSOFT: 0x82,
});
const TIMECYCLE_FIELD_MAP = new Map(TIMECYCLE_FIELD_GROUPS.map((field) => [field.key, field]));
const LOW_CLOUD_OFFSETS_X = [1.0, 0.7, 0.0, -0.7, -1.0, -0.7, 0.0, 0.7, 0.8, -0.8, 0.4, -0.4];
const LOW_CLOUD_OFFSETS_Z = [0.0, -0.7, -1.0, -0.7, 0.0, 0.7, 1.0, 0.7, 0.4, 0.4, -0.8, -0.8];
const LOW_CLOUD_HEIGHTS = [0.0, 1.0, 0.5, 0.0, 1.0, 0.3, 0.9, 0.4, 1.3, 1.4, 1.2, 1.7];
const FLUFFY_OFFSETS_X = [
  0.0, 60.0, 72.0, 48.0, 21.0, 12.0, 9.0, -3.0, -8.4, -18.0, -15.0, -36.0,
  -40.0, -48.0, -60.0, -24.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0,
  100.0, 100.0, -30.0, -20.0, 10.0, 30.0, 0.0, -100.0, -100.0, -100.0, -100.0, -100.0, -100.0,
];
const FLUFFY_OFFSETS_Z = [
  100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0,
  100.0, 100.0, 100.0, 100.0, -30.0, 10.0, -25.0, -5.0, 28.0, -10.0, 10.0, 0.0,
  15.0, 40.0, -100.0, -100.0, -100.0, -100.0, -100.0, -40.0, -20.0, 0.0, 10.0, 30.0, 35.0,
];
const FLUFFY_HEIGHTS = [
  2.0, 1.0, 0.0, 0.3, 0.7, 1.4, 1.7, 0.24, 0.7, 1.3, 1.6, 1.0,
  1.2, 0.3, 0.7, 1.4, 0.0, 0.1, 0.5, 0.4, 0.55, 0.75, 1.0, 1.4,
  1.7, 2.0, 2.0, 2.3, 1.9, 2.4, 2.0, 2.0, 1.5, 1.2, 1.7, 1.5, 2.1,
];
const INSTANCE_SELECTION_MATERIAL = new THREE.MeshBasicMaterial({
  color: new THREE.Color(1, 0.1, 0.1),
  transparent: true,
  opacity: 0.45,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
  fog: false,
  toneMapped: false,
});

function _toPlainVector(vector) {
  return {
    x: Number(vector?.x) || 0,
    y: Number(vector?.y) || 0,
    z: Number(vector?.z) || 0,
  };
}

function _map2dfxVisibilityMode(lightType) {
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
    default: return 'always';
  }
}

function _mapDffLightKind(lightType) {
  switch (Number(lightType)) {
    case RW_DFF_LIGHT_TYPE.AMBIENT: return 'ambient';
    case RW_DFF_LIGHT_TYPE.DIRECTIONAL: return 'directional';
    case RW_DFF_LIGHT_TYPE.POINT: return 'point';
    case RW_DFF_LIGHT_TYPE.SPOT: return 'spot';
    case RW_DFF_LIGHT_TYPE.SPOTSOFT: return 'spotsoft';
    default: return '';
  }
}

function clamp01(value) {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function runImguiSlider(ImGui, {
  type = 'float',
  id,
  value,
  setValue,
  min,
  max,
  format,
}) {
  let sliderValue = value;
  const onChange = (nextValue = sliderValue) => {
    sliderValue = nextValue;
    return nextValue;
  };
  const changed = type === 'int'
    ? ImGui.SliderInt(id, onChange, min, max, format)
    : ImGui.SliderFloat(id, onChange, min, max, format);
  if (changed) setValue(sliderValue);
  return changed;
}

function renderImguiSliderRow(ImGui, {
  id,
  rowPrefix,
  label,
  value,
  setValue,
  min,
  max,
  format,
  type = 'float',
}) {
  ImGui.PushID(id);
  ImGui.Columns(2, `${rowPrefix}-${id}`, false);
  ImGui.SetColumnWidth(0, 170);
  ImGui.PushItemWidth(-1);
  runImguiSlider(ImGui, {
    type,
    id: '##value',
    value,
    setValue,
    min,
    max,
    format: format ?? (type === 'int' ? '%d' : '%.2f'),
  });
  ImGui.PopItemWidth();
  ImGui.NextColumn();
  ImGui.AlignTextToFramePadding();
  ImGui.TextUnformatted(label);
  ImGui.Columns(1);
  ImGui.PopID();
}

function computeSunLightIntensityFromState(sunState) {
  const sunElevation = Number(sunState?.gtaDirection?.z);
  if (!Number.isFinite(sunElevation)) return 0.8;
  const daylight = Math.sqrt(clamp01((sunElevation + 0.2) / 0.8));
  return THREE.MathUtils.lerp(0.15, 0.8, daylight);
}

function computeSunLightsMultFromState(sunState) {
  const coronaAlpha = clamp01(Number(sunState?.fadeAlpha) || 0);
  return THREE.MathUtils.lerp(1.0, 0.6, coronaAlpha);
}

function computeSkyLightMultFromLightsMult(lightsMult) {
  const safeLightsMult = Math.max(0.35, Number(lightsMult) || 1);
  return (1 / safeLightsMult + 3) * 0.25;
}

function getTimecyclePostFxControlValues(values) {
  if (!values?.blur) return null;
  return {
    trailsLimit: Math.round(THREE.MathUtils.clamp(Number(values.radiosityLimit) || 0, 0, 255)),
    trailsIntensity: Math.round(THREE.MathUtils.clamp(Number(values.radiosityIntensity) || 0, 0, 63)),
    blurOffset: THREE.MathUtils.clamp(Number(values.blurOffset) || 0, 0, 32),
    blurIntensity: THREE.MathUtils.clamp(((Number(values.postfx1?.a ?? values.blurAlpha) || 0) * 0.8) / 255, 0, 1),
  };
}

function getTimecyclePostFxControlSignature(values) {
  const postFx = getTimecyclePostFxControlValues(values);
  if (!postFx) return 'none';
  return JSON.stringify(postFx);
}

// #region agent log helpers
function _dbgLog(payload) {
  fetch('http://127.0.0.1:7300/ingest/657c7c95-cd7f-40f5-879d-537e6099f3dd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '6d1737' },
    body: JSON.stringify({ sessionId: '6d1737', timestamp: Date.now(), ...payload }),
  }).catch(() => {});
}
// #endregion

function cloneTimecycleValue(value, type) {
  if (type === 'rgb') return { r: value.r, g: value.g, b: value.b };
  if (type === 'rgba') return { r: value.r, g: value.g, b: value.b, a: value.a };
  return value;
}

function toTimecycleColorArray(value, type) {
  const alpha = type === 'rgba' ? value.a : 255;
  return [
    (value.r || 0) / 255,
    (value.g || 0) / 255,
    (value.b || 0) / 255,
    alpha / 255,
  ];
}

function fromTimecycleColorArray(array, type) {
  const base = {
    r: THREE.MathUtils.clamp(Math.round((array[0] || 0) * 255), 0, 255),
    g: THREE.MathUtils.clamp(Math.round((array[1] || 0) * 255), 0, 255),
    b: THREE.MathUtils.clamp(Math.round((array[2] || 0) * 255), 0, 255),
  };
  if (type === 'rgba') {
    return {
      ...base,
      a: THREE.MathUtils.clamp(Math.round((array[3] ?? 1) * 255), 0, 255),
    };
  }
  return base;
}

function toThreeColorFromTimecycleValue(value) {
  return new THREE.Color().setRGB(
    (value.r || 0) / 255,
    (value.g || 0) / 255,
    (value.b || 0) / 255,
    THREE.SRGBColorSpace,
  );
}

function computeProjectedHorizonUvY(camera, scratch = {}) {
  const cameraForward = scratch.cameraForward || new THREE.Vector3();
  const flatForward = scratch.flatForward || new THREE.Vector3();
  const horizonPoint = scratch.horizonPoint || new THREE.Vector3();

  camera.getWorldDirection(cameraForward);
  flatForward.set(cameraForward.x, 0, cameraForward.z);
  const flatLengthSq = flatForward.lengthSq();
  if (flatLengthSq < 1e-8) {
    return cameraForward.y >= 0 ? -1 : 2;
  }

  flatForward.normalize();
  horizonPoint.copy(camera.position).addScaledVector(flatForward, 3000);
  horizonPoint.y = 0;
  horizonPoint.project(camera);
  return (horizonPoint.y * 0.5) + 0.5;
}

function createLowCloudTexture(seed = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const baseGradient = ctx.createLinearGradient(0, canvas.height * 0.5, 0, canvas.height);
  baseGradient.addColorStop(0, 'rgba(255,255,255,0.0)');
  baseGradient.addColorStop(0.45, 'rgba(255,255,255,0.7)');
  baseGradient.addColorStop(1, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = baseGradient;
  ctx.fillRect(0, canvas.height * 0.18, canvas.width, canvas.height * 0.64);

  ctx.globalCompositeOperation = 'destination-in';
  const blobs = [
    [0.14, 0.52, 0.24, 0.18],
    [0.34, 0.47, 0.28, 0.20],
    [0.56, 0.50, 0.30, 0.18],
    [0.77, 0.48, 0.24, 0.16],
    [0.90, 0.50, 0.12, 0.10],
  ];
  for (let i = 0; i < blobs.length; i += 1) {
    const [x, y, rx, ry] = blobs[(i + seed) % blobs.length];
    const gradient = ctx.createRadialGradient(
      canvas.width * x,
      canvas.height * y,
      0,
      canvas.width * x,
      canvas.height * y,
      canvas.width * rx,
    );
    gradient.addColorStop(0, 'rgba(255,255,255,0.96)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.72)');
    gradient.addColorStop(0.8, 'rgba(255,255,255,0.22)');
    gradient.addColorStop(1, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(
      canvas.width * x,
      canvas.height * y,
      canvas.width * rx,
      canvas.height * ry,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipMapLinearFilter;
  return texture;
}

function createFluffyCloudTexture(topColor, bottomColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  updateFluffyCloudTexture(canvas, topColor, bottomColor);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.premultiplyAlpha = true;
  texture.needsUpdate = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function createFluffyHighlightTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 96);
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.3, 'rgba(255,210,210,0.5)');
  gradient.addColorStop(0.7, 'rgba(255,120,120,0.12)');
  gradient.addColorStop(1, 'rgba(255,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.premultiplyAlpha = true;
  texture.needsUpdate = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function _configureFluffyCloudTexture(texture) {
  if (!texture?.isTexture) return null;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.premultiplyAlpha = true;
  texture.needsUpdate = true;
  return texture;
}

function _configureFluffyHighlightTexture(texture) {
  if (!texture?.isTexture) return null;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.premultiplyAlpha = true;
  texture.needsUpdate = true;
  return texture;
}

function updateFluffyCloudTexture(canvas, topColor, bottomColor) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, `rgb(${Math.round(topColor.r * 255)}, ${Math.round(topColor.g * 255)}, ${Math.round(topColor.b * 255)})`);
  gradient.addColorStop(1, `rgb(${Math.round(bottomColor.r * 255)}, ${Math.round(bottomColor.g * 255)}, ${Math.round(bottomColor.b * 255)})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalCompositeOperation = 'destination-in';
  const puffs = [
    [0.50, 0.48, 0.28],
    [0.33, 0.58, 0.20],
    [0.67, 0.56, 0.18],
    [0.50, 0.67, 0.22],
    [0.46, 0.34, 0.16],
  ];
  for (const [x, y, r] of puffs) {
    const maskGradient = ctx.createRadialGradient(
      canvas.width * x,
      canvas.height * y,
      0,
      canvas.width * x,
      canvas.height * y,
      canvas.width * r,
    );
    maskGradient.addColorStop(0, 'rgba(255,255,255,0.92)');
    maskGradient.addColorStop(0.7, 'rgba(255,255,255,0.42)');
    maskGradient.addColorStop(1, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = maskGradient;
    ctx.beginPath();
    ctx.arc(canvas.width * x, canvas.height * y, canvas.width * r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function _applyTimecycleOverrides(sampled, overrides) {
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

function App() {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const imguiCanvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const zipInputRef = useRef(null);

  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const skySceneRef = useRef(null);
  const skyCameraRef = useRef(null);
  const skyMaterialRef = useRef(null);
  const skyCloudSceneRef = useRef(null);
  const lowCloudSpritesRef = useRef([]);
  const fluffyCloudSpritesRef = useRef([]);
  const fluffyCloudTextureRef = useRef(null);
  const fluffyHighlightSpritesRef = useRef([]);
  const fluffyHighlightTextureRef = useRef(null);
  const skyFeatureRef = useRef(null);
  const sunLightRef = useRef(null);
  const hemiLightRef = useRef(null);
  const worldRootRef = useRef(new THREE.Group());
  const rwRenderQueueRef = useRef(null);
  const gtaSessionRef = useRef(createJsrwGtaSession());
  const jsrwSessionRef = useRef(gtaSessionRef.current.getRendererSession());
  const rendererHostRef = useRef(null);
  const renderItemsRef = useRef([]);
  const bigBuildingItemsRef = useRef([]);
  const renderChunksRef = useRef([]);
  const renderChunkLookupRef = useRef(new Map());
  const activeRenderChunksRef = useRef(new Set());
  const frameVisibilityRef = useRef(createFrameVisibilityResult());
  const chunkOcclusionStateRef = useRef(createChunkOcclusionState());
  const renderMetricsRef = useRef({
    activeChunks: 0,
    frustumChunks: 0,
    activeItems: 0,
    visibleNear: 0,
    visibleLod: 0,
    visibleQueueMeshes: 0,
    coronaCandidates: 0,
    shadowCandidates: 0,
    fadeProxyCount: 0,
    activeFadeCount: 0,
    rendererBackend: 'UNKNOWN',
    rendererActualBackend: 'unknown',
    rendererCurrentSamples: 0,
    rendererOutputBufferType: 'unknown',
    pipelineActiveMaterials: 0,
    pipelineCachedMaterials: 0,
    opaqueQueue: 0,
    cutoutQueue: 0,
    transparentQueue: 0,
    additiveQueue: 0,
    overlayQueue: 0,
    drawCalls: 0,
    triangles: 0,
    worldDrawCalls: 0,
    worldTriangles: 0,
    waterDrawCalls: 0,
    waterTriangles: 0,
    skyDrawCalls: 0,
    skyTriangles: 0,
    skyCloudsPassInvoked: false,
    skyCloudsPassDrawCalls: 0,
    skyCloudsPassTriangles: 0,
  });
  const selectedObjectRootRef = useRef(null);
  const selectedInstanceHighlightRef = useRef(null);
  const selectedObjectRef = useRef(null);
  const selectedTextureDetailRef = useRef(null);
  const timecycleDataRef = useRef(null);
  const timecycleStateRef = useRef(createDefaultTimecycleState());
  const cloudMotionRef = useRef({
    cloudRotation: 0,
    individualRotation: 0,
  });
  const chunkFrustumRef = useRef(new THREE.Frustum());
  const chunkProjScreenMatrixRef = useRef(new THREE.Matrix4());
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerNdcRef = useRef(new THREE.Vector2());
  const imguiGlRef = useRef(null);
  const imguiTextureCacheRef = useRef(new WeakMap());
  const imguiTextureListRef = useRef([]);
  const pointerStateRef = useRef({
    down: false,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const gridRef = useRef(null);
  const axesRef = useRef(null);
  const totalObjectsRef = useRef(0);
  const frameTimeRef = useRef(0);
  const fpsHistoryRef = useRef(Array.from({ length: 120 }, () => 0));
  const fpsHistoryIndexRef = useRef(0);
  const fpsSampleCountRef = useRef(0);
  const statsWindowSizeRef = useRef({ x: 0, y: 0 });
  const statsGraphRectMinRef = useRef({ x: 0, y: 0 });
  const statsGraphRectMaxRef = useRef({ x: 0, y: 0 });
  const lodUpdateAccumulatorRef = useRef(0);
  const activeFadeCountRef = useRef(0);
  const lookStateRef = useRef({
    active: false,
    yaw: 0,
    pitch: 0,
    lastX: 0,
    lastY: 0,
  });
  const moveStateRef = useRef({
    forward: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false,
    boost: false,
  });

  const fileIndexRef = useRef(null);
  const worldGameVersionRef = useRef('VCS');
  const buildTokenRef = useRef(0);
  const buildActiveRef = useRef(false);
  const renderResourcesReadyRef = useRef(false);
  const resourceCacheRef = useRef(createResourceCacheState());
  const skyParticleTexturesRef = useRef({
    moonTexture: null,
    starTexture: null,
    sunTextures: null,
    lowCloudTextures: null,
    cloudMaskedTexture: null,
    cloudHilitTexture: null,
  });
  const streamingBuildRef = useRef({
    token: 0,
    running: false,
    queue: [],
    queuedKeys: new Set(),
    context: null,
    startedAt: 0,
    firstChunkReadyAt: 0,
  });
  const lastPipelineSelectionSignatureRef = useRef('');

  const applyResolvedParticleTextures = useCallback((textures) => {
    const nextTextures = textures && typeof textures === 'object'
      ? {
        moonTexture: textures.moonTexture || null,
        starTexture: textures.starTexture || null,
        sunTextures: textures.sunTextures || null,
        lowCloudTextures: Array.isArray(textures.lowCloudTextures) ? textures.lowCloudTextures : null,
        cloudMaskedTexture: textures.cloudMaskedTexture || null,
        cloudHilitTexture: textures.cloudHilitTexture || null,
      }
      : {
        moonTexture: null,
        starTexture: null,
        sunTextures: null,
        lowCloudTextures: null,
        cloudMaskedTexture: null,
        cloudHilitTexture: null,
      };
    skyParticleTexturesRef.current = nextTextures;
    skyFeatureRef.current?.setParticleTextures(nextTextures);

    const lowArr = nextTextures.lowCloudTextures;
    const lowSprites = lowCloudSpritesRef.current;
    if (Array.isArray(lowSprites) && lowSprites.length > 0 && Array.isArray(lowArr)) {
      const fallback = prepareRwSpriteTexture(lowArr[0] || lowArr[1] || lowArr[2]);
      for (let i = 0; i < lowSprites.length; i += 1) {
        const raw = lowArr[i % 3] || lowArr[0];
        const tex = prepareRwSpriteTexture(raw) || fallback;
        if (tex && lowSprites[i]?.material) {
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          lowSprites[i].material.map = tex;
          lowSprites[i].material.needsUpdate = true;
        }
      }
    }

    const masked = nextTextures.cloudMaskedTexture;
    if (masked) {
      const tex = prepareRwSpriteTexture(masked);
      if (tex) {
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        // TXD textures are straight-alpha (see normalizeTextureDictionary / premultiplyAlpha: false).
        // Procedural canvas used premultipliedAlpha + premultiplied canvas; mismatch → white fringes.
        tex.premultiplyAlpha = false;
        for (const sprite of fluffyCloudSpritesRef.current) {
          if (sprite?.material) {
            sprite.material.map = tex;
            sprite.material.premultipliedAlpha = false;
            sprite.material.needsUpdate = true;
          }
        }
      }
    }

    const hilit = nextTextures.cloudHilitTexture;
    if (hilit) {
      const tex = prepareRwSpriteTexture(hilit);
      if (tex) {
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.premultiplyAlpha = false;
        for (const sprite of fluffyHighlightSpritesRef.current) {
          if (sprite?.material) {
            sprite.material.map = tex;
            sprite.material.premultipliedAlpha = false;
            sprite.material.needsUpdate = true;
          }
        }
      }
    }
  }, []);

  const imguiRef = useRef({ ImGui: null, ImGui_Impl: null, ready: false });
  const imguiCaptureRef = useRef({ mouse: false, keyboard: false });
  const backendSwitchingRef = useRef(false);
  const appUnmountingRef = useRef(false);
  const lodUpdateStateRef = useRef({
    needsRefresh: true,
    lastCameraPos: new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN),
    lastCameraQuat: new THREE.Quaternion(Number.NaN, Number.NaN, Number.NaN, Number.NaN),
    lastDrawDistance: 300,
    lastRenderingDistance: 5000,
    lastShowLods: true,
    lastForceLodOnly: false,
    lastShowTobjs: false,
    lastEnableOcclusion: false,
    lastCameraAspect: Number.NaN,
    lastCameraFov: Number.NaN,
    lastCameraNear: Number.NaN,
    lastCameraFar: Number.NaN,
  });

  const uiStateRef = useRef({
    gameVersion: 'VCS',
    quaternionOrder: 'XYZW',
    drawDistance: 300,
    renderingDistance: 5000,
    lodDistMultiplier: 1,
    showLods: true,
    forceLodOnly: false,
    showTobjs: false,
    render2dfx: true,
    debug2dfx: false,
    forceRender2dfx: false,
    twoDfx: { ...TWO_DFX_DEBUG_DEFAULTS },
    trafficLights: { ...TRAFFIC_LIGHT_DEBUG_DEFAULTS },
    shadows: { ...SHADOW_DEBUG_DEFAULTS },
    streamingBuild: true,
    backgroundPreloadRadius: 1.5,
    showGrid: true,
    showAxes: false,
    wireframe: false,
    disableVertexColor: false,
    disableBackfaceCulling: true,
    enableOcclusion: true,
    renderWater: true,
    waterUvSpeed: 1,
    waterWaveHeight: 35,
    waterAlpha: 0.72,
    moon: { ...RW_MOON_DEBUG_DEFAULTS },
    stars: { ...RW_STARS_DEBUG_DEFAULTS },
    sun: { ...RW_SUN_DEBUG_DEFAULTS },
    renderStages: { ...FRAME_STAGE_DEBUG_DEFAULTS },
    pipelineDebug: cloneRWPipelineSelections(RW_PIPELINE_SELECTION_DEFAULTS),
    appMode: APP_MODE_EDITOR,
    backendSelection: 'WebGPU',
    windows: Object.fromEntries(WINDOW_DEFS.map((item) => [item.key, item.defaultVisible])),
  });
  const lastWireframeRef = useRef(false);
  const lastDisableVertexColorRef = useRef(false);
  const lastDisableBackfaceCullingRef = useRef(true);
  const lastRenderWaterRef = useRef(true);
  const sunRuntimeDebugRef = useRef({
    enableBigBloom: true,
    bigSunBloom: false,
    bloomEligible: false,
    screenCenterBloomFactor: 0,
    facingBloomFactor: 0,
    viewAlignment: 0,
    centerBloomFactor: 0,
    brightnessBloomFactor: 0,
    bloomBrightnessScale: 0.35,
    bigBloomFadeAlpha: 0,
    bigBloomScale: 1,
    sunOnScreen: false,
    coronaFadeAlpha: 0,
    sunLightsMult: 1,
  });
  const postFxTimecycleSyncSignatureRef = useRef('');

  const [status, setStatus] = useState('Select an extracted GTA folder or zip archive to begin.');
  const [activeBackend, setActiveBackend] = useState('WebGPU');
  const [buildProgress, setBuildProgress] = useState({ active: false, current: 0, total: 0 });
  const [showGameIcon, setShowGameIcon] = useState(false);
  const [stats, setStats] = useState({
    files: 0,
    ideFiles: 0,
    iplFiles: 0,
    ideDefs: 0,
    ideEffects: 0,
    iplInst: 0,
    loaded: 0,
    failed: 0,
    unresolved: 0,
    nearOnly: 0,
    totalChunks: 0,
    instancedBatches: 0,
    instancedItems: 0,
    lightObjects: 0,
    lightEmitters: 0,
    queuedChunks: 0,
    readyChunks: 0,
  });
  const [consoleLines, setConsoleLines] = useState([]);
  const [failedModels, setFailedModels] = useState([]);
  const [loadedFiles, setLoadedFiles] = useState([]);
  const [selectedObject, setSelectedObject] = useState(null);
  const [selectedTextureDetail, setSelectedTextureDetail] = useState(null);
  const [showMapPickerFallback, setShowMapPickerFallback] = useState(false);
  const statusRef = useRef(status);
  const statsRef = useRef(stats);
  const buildProgressRef = useRef(buildProgress);
  const showGameIconRef = useRef(showGameIcon);
  const consoleLinesRef = useRef(consoleLines);
  const failedModelsRef = useRef(failedModels);
  const loadedFilesRef = useRef(loadedFiles);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    statsRef.current = stats;
  }, [stats]);

  useEffect(() => {
    buildProgressRef.current = buildProgress;
  }, [buildProgress]);

  useEffect(() => {
    showGameIconRef.current = showGameIcon;
  }, [showGameIcon]);

  useEffect(() => {
    uiStateRef.current.backendSelection = activeBackend;
  }, [activeBackend]);

  useEffect(() => {
    consoleLinesRef.current = consoleLines;
  }, [consoleLines]);

  useEffect(() => {
    failedModelsRef.current = failedModels;
  }, [failedModels]);

  useEffect(() => {
    loadedFilesRef.current = loadedFiles;
  }, [loadedFiles]);
  useEffect(() => {
    selectedObjectRef.current = selectedObject;
  }, [selectedObject]);
  useEffect(() => {
    selectedTextureDetailRef.current = selectedTextureDetail;
  }, [selectedTextureDetail]);

  useEffect(() => () => {
    appUnmountingRef.current = true;
  }, []);

  const pushConsoleLine = useCallback((level, message, source = 'app') => {
    setConsoleLines((prev) => {
      const next = [...prev, {
        ts: new Date().toLocaleTimeString(),
        level,
        source,
        message,
      }];
      return next.length > MAX_CONSOLE_LINES ? next.slice(next.length - MAX_CONSOLE_LINES) : next;
    });
  }, []);

  const pushLoadedFile = useCallback((kind, path, detail = '') => {
    setLoadedFiles((prev) => pushLoadedFileEntry(prev, kind, path, detail));
  }, []);

  const pushLoadedFileConsoleEvent = useCallback((kind, path, detail = '') => {
    const normalizedKind = String(kind || '').trim().toUpperCase();
    const rawPath = String(path || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
    const normalizedPath = normalizePath(rawPath);
    const normalizedDetail = String(detail || '').trim().toLowerCase();
    if (!normalizedKind || !normalizedPath) return;
    if (normalizedDetail === 'declared' || normalizedDetail === 'optional') return;

    const isMissing = normalizedDetail.includes('missing');
    const level = isMissing ? 'warn' : 'info';
    const detailLabel = detail ? ` (${detail})` : '';
    pushConsoleLine(level, `File ${normalizedKind}: ${rawPath}${detailLabel}`, 'files');
  }, [pushConsoleLine]);

  const pushFailedModel = useCallback((text) => {
    const line = String(text || '').trim();
    if (!line) return;
    setFailedModels((prev) => {
      const next = [...prev, line];
      return next.length > MAX_FAILED_MODELS ? next.slice(next.length - MAX_FAILED_MODELS) : next;
    });
  }, []);

  const isWindowOpen = useCallback((key) => Boolean(uiStateRef.current.windows[key]), []);
  const setWindowOpen = useCallback((key, value) => {
    const next = Boolean(value);
    uiStateRef.current.windows[key] = next;
    return next;
  }, []);

  useEffect(() => {
    const originalLog = console.log.bind(console);
    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);

    console.log = (...args) => {
      pushConsoleLine('info', args.map(formatConsoleArg).join(' '), 'console');
      originalLog(...args);
    };
    console.warn = (...args) => {
      pushConsoleLine('warn', args.map(formatConsoleArg).join(' '), 'console');
      originalWarn(...args);
    };
    console.error = (...args) => {
      pushConsoleLine('error', args.map(formatConsoleArg).join(' '), 'console');
      originalError(...args);
    };

    const onWindowError = (event) => {
      const message = event?.error ? formatConsoleArg(event.error) : event.message;
      pushConsoleLine('error', message || 'Unknown window error', 'window');
    };
    const onUnhandledRejection = (event) => {
      pushConsoleLine('error', formatConsoleArg(event.reason), 'promise');
    };

    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, [pushConsoleLine]);

  const resetImguiTextureCache = useCallback(() => {
    const gl = imguiGlRef.current;
    if (gl) {
      for (const texture of imguiTextureListRef.current) {
        if (texture) gl.deleteTexture(texture);
      }
    }
    imguiTextureCacheRef.current = new WeakMap();
    imguiTextureListRef.current = [];
  }, []);

  const {
    clearWorld,
    loadDefaultMap,
    onPickFolder,
    onPickZip,
    openMapPicker,
    openZipPicker,
    rebuildWorld,
  } = useMemo(() => createAppSessionController({
    activeBackend,
    clearObjectSelectionHighlight,
    fileInputRef,
    zipInputRef,
    gtaSessionRef,
    refs: {
      activeFadeCountRef,
      activeRenderChunksRef,
      bigBuildingItemsRef,
      buildActiveRef,
      buildTokenRef,
      cameraRef,
      chunkOcclusionStateRef,
      fileIndexRef,
      frameVisibilityRef,
      lastPipelineSelectionSignatureRef,
      lodUpdateStateRef,
      renderChunkLookupRef,
      renderChunksRef,
      renderItemsRef,
      renderMetricsRef,
      renderResourcesReadyRef,
      resourceCacheRef,
      rwRenderQueueRef,
      selectedInstanceHighlightRef,
      selectedObjectRef,
      selectedObjectRootRef,
      selectedTextureDetailRef,
      streamingBuildRef,
      timecycleDataRef,
      timecycleStateRef,
      totalObjectsRef,
      uiStateRef,
      worldGameVersionRef,
      worldRootRef,
    },
    setters: {
      setBuildProgress,
      setFailedModels,
      setLoadedFiles,
      setSelectedObject,
      setSelectedTextureDetail,
      setShowGameIcon,
      setShowMapPickerFallback,
      setStats,
      setStatus,
    },
    callbacks: {
      pushConsoleLine,
      pushFailedModel,
      pushLoadedFile,
      pushLoadedFileConsoleEvent,
      resetImguiTextureCache,
      setResolvedParticleTextures: applyResolvedParticleTextures,
    },
  }), [
    activeBackend,
    applyResolvedParticleTextures,
    pushConsoleLine,
    pushFailedModel,
    pushLoadedFile,
    pushLoadedFileConsoleEvent,
    resetImguiTextureCache,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const imguiCanvas = imguiCanvasRef.current;
    if (!container || !canvas || !imguiCanvas) return undefined;

    let renderer = null;
    let cancelled = false;
    let rendererReady = false;
    const rendererHost = new ThreeRendererHost({
      backend: activeBackend,
      canvas,
      onLog: (level, message) => pushConsoleLine(level, message),
      onBackendFallback: (nextBackend) => {
        uiStateRef.current.backendSelection = nextBackend;
        if (nextBackend !== activeBackend) {
          setStatus(`${activeBackend} not available. Switched to ${nextBackend}.`);
          backendSwitchingRef.current = true;
          setActiveBackend(nextBackend);
        }
      },
    });
    rendererHostRef.current = rendererHost;
    rendererHost.initialize(activeBackend).then((nextRenderer) => {
      if (cancelled) {
        rendererHost.dispose();
        return;
      }
      renderer = nextRenderer;
      rendererRef.current = nextRenderer;
      if (activeBackend === 'WebGPU' && rendererHost.backend === 'WebGPU') {
        pushConsoleLine('info', 'WebGPU backend initialized');
      }
      rendererReady = true;
      resize();
      window.requestAnimationFrame(() => {
        if (!cancelled) resize();
      });
      backendSwitchingRef.current = false;
    }).catch((error) => {
      if (cancelled) return;
      pushConsoleLine('error', `Renderer init failed: ${formatConsoleArg(error)}`);
      setStatus(`Renderer init failed: ${formatConsoleArg(error)}`);
    });

    canvas.tabIndex = 1;

    const scene = new THREE.Scene();
    scene.background = null;
    const skyScene = new THREE.Scene();
    const skyCloudScene = new THREE.Scene();
    const skyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    const skyMaterial = createSkyNodeMaterial();
    const skyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), skyMaterial);
    skyQuad.frustumCulled = false;
    skyScene.add(skyQuad);
    const lowCloudTextures = [createLowCloudTexture(0), createLowCloudTexture(1), createLowCloudTexture(2)];
    const lowCloudSprites = LOW_CLOUD_OFFSETS_X.map((_, index) => {
      const material = new THREE.SpriteMaterial({
        map: lowCloudTextures[index % lowCloudTextures.length],
        color: SKY_DEFAULT_FOG.clone(),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(material);
      // RW draws these as screen-space billboards; world-space centers sit far off-axis and
      // would be frustum-culled even when the quad should cover the sky.
      sprite.frustumCulled = false;
      sprite.scale.set(900, 120, 1);
      sprite.renderOrder = -900;
      skyCloudScene.add(sprite);
      return sprite;
    });
    const fluffyCloudTexture = createFluffyCloudTexture(SKY_DEFAULT_TOP, SKY_DEFAULT_BOTTOM);
    const fluffyHighlightTexture = createFluffyHighlightTexture();
    const fluffyCloudSprites = FLUFFY_OFFSETS_X.map(() => {
      const material = new THREE.SpriteMaterial({
        map: fluffyCloudTexture,
        transparent: true,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
        blending: THREE.NormalBlending,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.frustumCulled = false;
      sprite.scale.set(110, 110, 1);
      sprite.renderOrder = -850;
      skyCloudScene.add(sprite);
      return sprite;
    });
    const fluffyHighlightSprites = FLUFFY_OFFSETS_X.map(() => {
      const material = new THREE.SpriteMaterial({
        map: fluffyHighlightTexture,
        transparent: true,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.frustumCulled = false;
      sprite.scale.set(60, 60, 1);
      sprite.renderOrder = -840;
      skyCloudScene.add(sprite);
      return sprite;
    });
    const hudScene = new THREE.Scene();
    const hudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    hudCamera.position.set(0, 0, 1);
    const skyFeature = new SkyRendererBundle();
    skyFeature.setParticleTextures(skyParticleTexturesRef.current);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 60000);
    camera.up.copy(WORLD_UP);
    camera.position.set(300, 300, 220);
    camera.lookAt(0, 0, 0);
    const orbitControls = new OrbitControls(camera, canvas);
    orbitControls.enabled = false;
    orbitControls.enableDamping = true;
    orbitControls.target.set(0, 0, 0);
    orbitControls.update();

    const updateLookFromAngles = () => {
      const look = lookStateRef.current;
      const cp = Math.cos(look.pitch);
      const direction = new THREE.Vector3(
        Math.sin(look.yaw) * cp,
        Math.sin(look.pitch),
        Math.cos(look.yaw) * cp,
      );
      camera.lookAt(camera.position.clone().add(direction));
    };

    const syncAnglesFromCamera = () => {
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      lookStateRef.current.yaw = Math.atan2(direction.x, direction.z);
      lookStateRef.current.pitch = Math.asin(Math.max(-1, Math.min(1, direction.y)));
    };
    syncAnglesFromCamera();

    const playerController = new PlayerControllerAdapter({
      scene,
      camera,
      controls: orbitControls,
      externalFactory: createExternalPlayerController,
      getSpawnPosition: () => camera.position.clone(),
      playerModel: {
        url: '/glb/person.glb',
        scale: 0.01,
        idleAnim: 'idle1',
        walkAnim: 'walk',
        runAnim: 'run',
        jumpAnim: 'jump',
        flyAnim: 'flying',
        flyIdleAnim: 'flyidle',
        enterCarAnim: 'enterCar',
        exitCarAnim: 'exitCar',
        headObjName: 'mixamorigHead',
        rotateY: Math.PI,
      },
      minCamDistance: 80,
      maxCamDistance: 360,
      thirdMouseMode: 1,
      allowFallback: false,
      getMoveState: () => moveStateRef.current,
      getLookState: () => lookStateRef.current,
      worldUp: WORLD_UP,
    });
    const playerModeManager = new PlayerModeManager({
      playerController,
      getMode: () => uiStateRef.current.appMode,
      setMode: (nextMode) => {
        uiStateRef.current.appMode = nextMode;
      },
      onModeStatus: (nextMode, controllerMode, enableTest) => {
        setStatus(`Mode: ${nextMode}${enableTest ? ` (${controllerMode})` : ''}`);
      },
      onModeError: (error) => {
        pushConsoleLine('error', `Mode switch failed: ${formatConsoleArg(error)}`, 'mode');
        setStatus(`Mode switch failed: ${formatConsoleArg(error)}`);
      },
      onModeLog: (prevMode, nextMode, controllerMode) => {
        pushConsoleLine('info', `Mode switched: ${prevMode} -> ${nextMode}${nextMode === APP_MODE_TEST ? ` (${controllerMode})` : ''}`, 'mode');
      },
      onExitTestMode: () => {
        syncAnglesFromCamera();
      },
    });

    const hemi = new THREE.HemisphereLight(0xffffff, 0x677582, 0.8);
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(400, 250, 500);

    const grid = new THREE.GridHelper(5000, 140, 0x334455, 0x6e7f91);

    const axes = new THREE.AxesHelper(150);
    axes.visible = false;

    scene.add(hemi, sun, sun.target, grid, axes, worldRootRef.current);

    const textureLoader = new THREE.TextureLoader();
    const iconTextures = {
      SA: textureLoader.load(saIcon),
      VCS: textureLoader.load(vcsIcon),
    };
    const iconMaterial = new THREE.SpriteMaterial({
      map: iconTextures.VCS,
      transparent: true,
      alphaTest: 0.01,
      depthTest: false,
      depthWrite: false,
    });
    const gameIconSprite = new THREE.Sprite(iconMaterial);
    gameIconSprite.center.set(1, 1);
    gameIconSprite.visible = false;
    gameIconSprite.renderOrder = 9999;
    hudScene.add(gameIconSprite);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    skySceneRef.current = skyScene;
    skyCameraRef.current = skyCamera;
    skyMaterialRef.current = skyMaterial;
    skyCloudSceneRef.current = skyCloudScene;
    lowCloudSpritesRef.current = lowCloudSprites;
    fluffyCloudSpritesRef.current = fluffyCloudSprites;
    fluffyCloudTextureRef.current = fluffyCloudTexture;
    fluffyHighlightSpritesRef.current = fluffyHighlightSprites;
    fluffyHighlightTextureRef.current = fluffyHighlightTexture;
    skyFeatureRef.current = skyFeature;
    const jsrwSession = jsrwSessionRef.current;
    jsrwSession.setRoot(worldRootRef.current);
    rwRenderQueueRef.current = jsrwSession.getRenderQueue() || jsrwSession.createRenderQueue(worldRootRef.current);
    gridRef.current = grid;
    axesRef.current = axes;
    sunLightRef.current = sun;
    hemiLightRef.current = hemi;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(container.clientWidth));
      const height = Math.max(1, Math.floor(container.clientHeight));
      imguiCanvas.width = Math.max(1, Math.floor(width * dpr));
      imguiCanvas.height = Math.max(1, Math.floor(height * dpr));
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      hudCamera.updateProjectionMatrix();
      lodUpdateStateRef.current.needsRefresh = true;
      if (!rendererReady) return;
      rendererHost.resize({ width, height, dpr });
      skyFeature.setViewport(width * dpr, height * dpr);
    };

    resize();
    window.addEventListener('resize', resize);
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
        resize();
      })
      : null;
    resizeObserver?.observe(container);

    const setKeyState = (code, value) => {
      const move = moveStateRef.current;
      if (code === 'KeyW') move.forward = value;
      if (code === 'KeyS') move.back = value;
      if (code === 'KeyA') move.left = value;
      if (code === 'KeyD') move.right = value;
      if (code === 'KeyE') move.up = value;
      if (code === 'KeyQ') move.down = value;
      if (code === 'ShiftLeft' || code === 'ShiftRight') move.boost = value;
    };

    const onKeyDown = (event) => {
      setKeyState(event.code, true);
    };
    const onKeyUp = (event) => {
      setKeyState(event.code, false);
    };
    const clearSelectedVisual = () => {
      if (selectedInstanceHighlightRef.current?.parent) {
        selectedInstanceHighlightRef.current.parent.remove(selectedInstanceHighlightRef.current);
      }
      selectedInstanceHighlightRef.current = null;
      const previous = selectedObjectRootRef.current;
      if (previous) {
        clearObjectSelectionHighlight(previous);
        rwRenderQueueRef.current?.markDirty();
      }
    };
    const setSelectedObjectRoot = (nextRoot) => {
      const previous = selectedObjectRootRef.current;
      if (previous !== nextRoot || selectedInstanceHighlightRef.current) {
        clearSelectedVisual();
      }
      if (!nextRoot) {
        selectedObjectRootRef.current = null;
        selectedObjectRef.current = null;
        setSelectedObject(null);
        return;
      }
      applyObjectSelectionHighlight(nextRoot);
      rwRenderQueueRef.current?.markDirty();
      selectedObjectRootRef.current = nextRoot;
      selectedObjectRef.current = nextRoot.userData?.objectDetail || null;
      setSelectedObject(selectedObjectRef.current);
      setWindowOpen('objectDetail', true);
    };

    const buildInstanceSelectionHighlight = (entry) => {
      if (!entry?.selectionTemplate?.traverse || !entry?.placementMatrix) return null;
      const proxyRoot = new THREE.Group();
      proxyRoot.name = 'instance_selection_highlight';
      proxyRoot.userData = {
        ...(proxyRoot.userData || {}),
        rwInstanceSelectionProxy: true,
      };
      entry.selectionTemplate.traverse((node) => {
        if (!node.isMesh) return;
        const proxyMesh = new THREE.Mesh(node.geometry, INSTANCE_SELECTION_MATERIAL);
        proxyMesh.name = `${node.name || 'mesh'}__instance_selection`;
        proxyMesh.userData = {
          ...(proxyMesh.userData || {}),
          rwIsSelectionOverlay: true,
        };
        proxyMesh.matrixAutoUpdate = false;
        proxyMesh.matrixWorldAutoUpdate = false;
        proxyMesh.frustumCulled = false;
        proxyMesh.renderOrder = Math.max(node.renderOrder || 0, 9998);
        proxyMesh.raycast = () => {};
        proxyMesh.matrix.copy(entry.placementMatrix).multiply(node.matrixWorld);
        proxyMesh.matrixWorld.copy(proxyMesh.matrix);
        proxyRoot.add(proxyMesh);
      });
      return proxyRoot;
    };

    const setSelectedInstanceEntry = (entry) => {
      clearSelectedVisual();
      if (!entry?.objectDetail) {
        selectedObjectRootRef.current = null;
        selectedObjectRef.current = null;
        setSelectedObject(null);
        return;
      }
      const highlight = buildInstanceSelectionHighlight(entry);
      if (highlight) {
        worldRoot.add(highlight);
        selectedInstanceHighlightRef.current = highlight;
        rwRenderQueueRef.current?.markDirty();
      }
      selectedObjectRootRef.current = null;
      selectedObjectRef.current = entry.objectDetail;
      setSelectedObject(entry.objectDetail);
      setWindowOpen('objectDetail', true);
    };

    const trySelectObjectFromPointer = (event) => {
      if (playerModeManager.isTestMode()) return;
      if (imguiCaptureRef.current.mouse) return;
      const cameraObj = cameraRef.current;
      const worldRoot = worldRootRef.current;
      if (!cameraObj || !worldRoot) return;

      const rect = container.getBoundingClientRect();
      const nx = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ny = -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
      pointerNdcRef.current.set(nx, ny);

      const raycaster = raycasterRef.current;
      raycaster.layers.enableAll();
      raycaster.setFromCamera(pointerNdcRef.current, cameraObj);
      const intersections = raycaster.intersectObject(worldRoot, true);
      for (const hit of intersections) {
        if (hit.object?.isInstancedMesh && Number.isInteger(hit.instanceId)) {
          const entry = hit.object.userData?.rwInstanceEntries?.[hit.instanceId];
          if (!entry) continue;
          setSelectedInstanceEntry(entry);
          return;
        }
        const selectable = getSelectableRootFromObject(hit.object);
        if (!selectable || !selectable.visible) continue;
        setSelectedObjectRoot(selectable);
        return;
      }
      setSelectedObjectRoot(null);
    };

    const onMouseDown = (event) => {
      if (playerModeManager.isTestMode()) return;
      if (event.button !== 0 || imguiCaptureRef.current.mouse) return;
      pointerStateRef.current.down = true;
      pointerStateRef.current.startX = event.clientX;
      pointerStateRef.current.startY = event.clientY;
      pointerStateRef.current.moved = false;
      lookStateRef.current.active = true;
      lookStateRef.current.lastX = event.clientX;
      lookStateRef.current.lastY = event.clientY;
      event.preventDefault();
    };
    const onMouseUp = (event) => {
      if (event.button !== 0) return;
      const pointer = pointerStateRef.current;
      const treatAsClick = pointer.down && !pointer.moved;
      pointer.down = false;
      lookStateRef.current.active = false;
      if (treatAsClick) {
        trySelectObjectFromPointer(event);
      }
    };
    const onMouseMove = (event) => {
      if (playerModeManager.isTestMode()) return;
      if (pointerStateRef.current.down) {
        const dx = event.clientX - pointerStateRef.current.startX;
        const dy = event.clientY - pointerStateRef.current.startY;
        if ((dx * dx) + (dy * dy) > 9) {
          pointerStateRef.current.moved = true;
        }
      }
      if (!lookStateRef.current.active || imguiCaptureRef.current.mouse) return;
      const look = lookStateRef.current;
      const dx = event.clientX - look.lastX;
      const dy = event.clientY - look.lastY;
      look.lastX = event.clientX;
      look.lastY = event.clientY;

      const sensitivity = 0.003;
      look.yaw -= dx * sensitivity;
      look.pitch = Math.max(-1.55, Math.min(1.55, look.pitch - (dy * sensitivity)));
      updateLookFromAngles();
    };
    const switchAppMode = (nextModeRaw) => {
      lookStateRef.current.active = false;
      return playerModeManager.switchMode(nextModeRaw);
    };
    const getImguiTextureForImage = (textureSource) => {
      const gl = imguiGlRef.current;
      if (!gl || !textureSource) return null;

      const renderer = rendererRef.current;
      const renderTarget = textureSource?.userData?.rwRenderTarget || null;
      if (renderer?.isWebGLRenderer && renderTarget) {
        const image = textureSource?.image ?? textureSource;
        const width = image?.width ?? renderTarget.width ?? 0;
        const height = image?.height ?? renderTarget.height ?? 0;
        if (!width || !height) return null;

        let texture = imguiTextureCacheRef.current.get(textureSource) || null;
        if (!texture) {
          texture = gl.createTexture();
          if (!texture) return null;
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          imguiTextureCacheRef.current.set(textureSource, texture);
          imguiTextureListRef.current.push(texture);
        } else {
          gl.bindTexture(gl.TEXTURE_2D, texture);
        }

        const pixelCount = width * height * 4;
        const previousBuffer = textureSource.userData.rwImguiPreviewPixels;
        const previousFlipped = textureSource.userData.rwImguiPreviewPixelsFlipped;
        const pixels = previousBuffer instanceof Uint8Array && previousBuffer.length === pixelCount
          ? previousBuffer
          : new Uint8Array(pixelCount);
        const flipped = previousFlipped instanceof Uint8Array && previousFlipped.length === pixelCount
          ? previousFlipped
          : new Uint8Array(pixelCount);
        renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);
        const rowSize = width * 4;
        for (let y = 0; y < height; y += 1) {
          const srcOffset = y * rowSize;
          const dstOffset = (height - y - 1) * rowSize;
          flipped.set(pixels.subarray(srcOffset, srcOffset + rowSize), dstOffset);
        }
        textureSource.userData.rwImguiPreviewPixels = pixels;
        textureSource.userData.rwImguiPreviewPixelsFlipped = flipped;
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return texture;
      }

      const cached = imguiTextureCacheRef.current.get(textureSource);
      if (cached) return cached;

      const texture = gl.createTexture();
      if (!texture) return null;

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      try {
        const image = textureSource?.image ?? textureSource;
        const width = image?.videoWidth ?? image?.width ?? 0;
        const height = image?.videoHeight ?? image?.height ?? 0;
        if (!width || !height) throw new Error('invalid texture size');

        if (image?.data && ArrayBuffer.isView(image.data)) {
          const format = textureSource?.format === THREE.RGBFormat ? gl.RGB : gl.RGBA;
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            format,
            width,
            height,
            0,
            format,
            gl.UNSIGNED_BYTE,
            image.data,
          );
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        }
      } catch {
        gl.deleteTexture(texture);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return null;
      }
      gl.bindTexture(gl.TEXTURE_2D, null);

      imguiTextureCacheRef.current.set(textureSource, texture);
      imguiTextureListRef.current.push(texture);
      return texture;
    };
    const getTextureSize = (textureSource) => {
      const image = textureSource?.image ?? textureSource;
      const width = image?.videoWidth ?? image?.width ?? 0;
      const height = image?.videoHeight ?? image?.height ?? 0;
      return { width, height };
    };
    const openTextureDetail = (entry, detail) => {
      const textureSource = entry?.texture || null;
      if (!textureSource) return;
      const { width, height } = getTextureSize(textureSource);
      const compressionMethod = String(
        entry?.compressionMethod
        || textureSource?.userData?.rwCompressionMethod
        || 'UNKNOWN',
      );
      const pixelFormat = String(
        entry?.pixelFormat
        || textureSource?.userData?.rwPixelFormat
        || 'UNKNOWN',
      );
      const nextDetail = {
        name: String(entry?.name || ''),
        txdName: `${String(detail?.txdName || '')}.txd`,
        compressionMethod,
        pixelFormat,
        width,
        height,
        texture: textureSource,
      };
      selectedTextureDetailRef.current = nextDetail;
      setSelectedTextureDetail(nextDetail);
    };
    const onContextMenu = (event) => event.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('contextmenu', onContextMenu);

    let rafId = 0;
    let mounted = true;
    let backendRuntimeFailed = false;
    const drawingBufferSize = new THREE.Vector2();

    const animate = (time) => {
      if (!mounted) return;
      if (!rendererReady) {
        rafId = window.requestAnimationFrame(animate);
        return;
      }

      const dt = frameTimeRef.current > 0 ? Math.min(0.05, (time - frameTimeRef.current) / 1000) : 0;
      frameTimeRef.current = time;
      if (dt > 0) {
        const fps = Math.min(240, 1 / dt);
        fpsHistoryRef.current[fpsHistoryIndexRef.current] = fps;
        fpsHistoryIndexRef.current = (fpsHistoryIndexRef.current + 1) % fpsHistoryRef.current.length;
        fpsSampleCountRef.current = Math.min(fpsSampleCountRef.current + 1, fpsHistoryRef.current.length);
      }
      renderer.info?.reset?.();

      if (dt > 0) {
        if (playerModeManager.isTestMode()) {
          // In test mode, let three-player-controller fully drive character/camera.
          playerModeManager.update(dt);
        } else if (!imguiCaptureRef.current.keyboard) {
          const move = moveStateRef.current;
          const inputX = (move.right ? 1 : 0) - (move.left ? 1 : 0);
          const inputY = (move.forward ? 1 : 0) - (move.back ? 1 : 0);
          const inputZ = (move.up ? 1 : 0) - (move.down ? 1 : 0);
          if (inputX || inputY || inputZ) {
            const look = lookStateRef.current;
            const cp = Math.cos(look.pitch);
            const forward = new THREE.Vector3(
              Math.sin(look.yaw) * cp,
              Math.sin(look.pitch),
              Math.cos(look.yaw) * cp,
            ).normalize();
            const right = new THREE.Vector3().crossVectors(WORLD_UP, forward).normalize().negate();
            const velocity = move.boost ? 800 : 250;

            const delta = new THREE.Vector3();
            delta.addScaledVector(forward, inputY);
            delta.addScaledVector(right, inputX);
            delta.y += inputZ;
            if (delta.lengthSq() > 0) {
              delta.normalize().multiplyScalar(velocity * dt);
              camera.position.add(delta);
              updateLookFromAngles();
            }
          }
        }
      }

      const timecycleCurrent = gtaSessionRef.current.sampleTimecycle({
        timecycleDataRef,
        timecycleStateRef,
      });
      const livePostFxControlValues = getTimecyclePostFxControlValues(timecycleCurrent?.values);
      const livePostFxControlSignature = getTimecyclePostFxControlSignature(timecycleCurrent?.values);
      const postFxDebugSelection = uiStateRef.current.pipelineDebug?.[RW_PIPELINE_CATEGORY.POSTFX];
      if (postFxDebugSelection) {
        postFxDebugSelection.config ||= {
          ...RW_PIPELINE_SELECTION_DEFAULTS[RW_PIPELINE_CATEGORY.POSTFX].config,
        };
        if (livePostFxControlValues && postFxTimecycleSyncSignatureRef.current !== livePostFxControlSignature) {
          postFxDebugSelection.config.trailsLimit = livePostFxControlValues.trailsLimit;
          postFxDebugSelection.config.trailsIntensity = livePostFxControlValues.trailsIntensity;
          postFxDebugSelection.config.blurOffset = livePostFxControlValues.blurOffset;
          postFxDebugSelection.config.blurIntensity = livePostFxControlValues.blurIntensity;
          postFxTimecycleSyncSignatureRef.current = livePostFxControlSignature;
        } else if (!livePostFxControlValues) {
          postFxTimecycleSyncSignatureRef.current = 'none';
        }
      }
      const effectiveFarClip = Number.isFinite(timecycleCurrent?.values?.farClip)
        ? timecycleCurrent.values.farClip
        : uiStateRef.current.renderingDistance;
      const targetFarClip = Math.max(camera.near + 1, effectiveFarClip);
      if (Math.abs(camera.far - targetFarClip) > 1e-6) {
        camera.far = targetFarClip;
        camera.updateProjectionMatrix();
      }
      const skyMaterial = skyMaterialRef.current;
      const baseSkyTopColor = timecycleCurrent?.three?.skyTop?.isColor
        ? timecycleCurrent.three.skyTop
        : SKY_DEFAULT_TOP;
      const baseSkyBottomColor = timecycleCurrent?.three?.skyBottom?.isColor
        ? timecycleCurrent.three.skyBottom
        : SKY_DEFAULT_BOTTOM;
      const skyTopColor = baseSkyTopColor.clone();
      const skyBottomColor = baseSkyBottomColor.clone();
      const fogColor = timecycleCurrent?.three?.fogColor?.isColor
        ? timecycleCurrent.three.fogColor
        : SKY_DEFAULT_FOG;
      const belowHorizonColor = timecycleCurrent?.three?.belowHorizonColor?.isColor
        ? timecycleCurrent.three.belowHorizonColor
        : new THREE.Color().setRGB(30 / 255, 30 / 255, 30 / 255, THREE.SRGBColorSpace);
      const lowCloudColor = timecycleCurrent?.values?.lowClouds
        ? toThreeColorFromTimecycleValue(timecycleCurrent.values.lowClouds)
        : fogColor;
      const fluffyTopColor = timecycleCurrent?.values?.fluffyCloudTop
        ? toThreeColorFromTimecycleValue(timecycleCurrent.values.fluffyCloudTop)
        : baseSkyTopColor;
      const fluffyBottomColor = timecycleCurrent?.values?.fluffyCloudBottom
        ? toThreeColorFromTimecycleValue(timecycleCurrent.values.fluffyCloudBottom)
        : baseSkyBottomColor;
      const cloudCoverage = THREE.MathUtils.clamp(timecycleCurrent?.cloudCoverage ?? 0, 0, 1);
      const foggyness = THREE.MathUtils.clamp(timecycleCurrent?.foggyness ?? 0, 0, 1);
      const extraSunnyness = THREE.MathUtils.clamp(timecycleCurrent?.extraSunnyness ?? 0, 0, 1);
      const lowCloudIntensity = THREE.MathUtils.clamp(1 - Math.max(cloudCoverage, foggyness, extraSunnyness), 0, 1);
      const lowCloudAlpha = 1;
      const fluffyCloudAlpha = THREE.MathUtils.clamp(1 - Math.max(foggyness, extraSunnyness), 0, 1) * (160 / 255);
      const skyFeature = skyFeatureRef.current;
      const _sunPipeline = skyFeature?.sun || null;
      const cloudMotion = cloudMotionRef.current;
      const skyUniforms = skyMaterial?.userData?.rwSkyUniforms || null;
      if (skyUniforms) {
        const cameraForward = new THREE.Vector3();
        const cameraRight = new THREE.Vector3();
        const cameraUp = new THREE.Vector3();
        const horizonScratch = {
          cameraForward: new THREE.Vector3(),
          flatForward: new THREE.Vector3(),
          horizonPoint: new THREE.Vector3(),
        };
        camera.getWorldDirection(cameraForward);
        cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
        cameraUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
        const projectedHorizonY = computeProjectedHorizonUvY(camera, horizonScratch);
        const lodDistMultiplier = Math.max(0, uiStateRef.current.lodDistMultiplier ?? 1);
        const horizonStripSpan = (
          SKY_HORIZON_STRIP_HEIGHT
          + (Math.max(camera.position.y, 0) / 300)
          + (cameraUp.y < 0 ? 1.0 : Math.abs(cameraRight.y))
        ) * lodDistMultiplier;
        const lowerBandEndY = THREE.MathUtils.clamp(projectedHorizonY - SKY_SMALL_STRIP_HEIGHT - horizonStripSpan, 0, 1);
        skyUniforms.uSkyTop.value.copy(skyTopColor);
        skyUniforms.uSkyBottom.value.copy(skyBottomColor);
        skyUniforms.uFogColor.value.copy(fogColor);
        skyUniforms.uBelowHorizonColor.value.copy(belowHorizonColor);
        skyUniforms.uCameraForward.value.copy(cameraForward);
        skyUniforms.uCameraRight.value.copy(cameraRight);
        skyUniforms.uCameraUp.value.copy(cameraUp);
        skyUniforms.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
        skyUniforms.uAspect.value = camera.aspect;
        skyUniforms.uBelowHorizonMix.value = THREE.MathUtils.clamp((camera.position.y - 25) / 80, 0, 1);
        skyUniforms.uHorizonY.value = projectedHorizonY;
        skyUniforms.uSmallStripHeight.value = SKY_SMALL_STRIP_HEIGHT;
        skyUniforms.uHorizonStrength.value = 1.0;
        skyUniforms.uLowerBandEndY.value = lowerBandEndY;
      }
      const fluffyCloudTexture = fluffyCloudTextureRef.current;
      if (fluffyCloudTexture?.image && typeof fluffyCloudTexture.image.getContext === 'function') {
        const topHex = fluffyTopColor.getHexString();
        const bottomHex = fluffyBottomColor.getHexString();
        if (fluffyCloudTexture.userData.topHex !== topHex || fluffyCloudTexture.userData.bottomHex !== bottomHex) {
          updateFluffyCloudTexture(fluffyCloudTexture.image, fluffyTopColor, fluffyBottomColor);
          fluffyCloudTexture.needsUpdate = true;
          fluffyCloudTexture.userData.topHex = topHex;
          fluffyCloudTexture.userData.bottomHex = bottomHex;
        }
      }
      const cameraForwardForClouds = new THREE.Vector3();
      camera.getWorldDirection(cameraForwardForClouds);
      const cloudTurnFactor = Math.sin(Math.atan2(cameraForwardForClouds.x, cameraForwardForClouds.z) - 0.85);
      const cloudWind = 1.0;
      if (dt > 0) {
        // Match VC's incremental update model instead of binding cloud motion to absolute wall time.
        cloudMotion.cloudRotation += cloudWind * cloudTurnFactor * 0.075 * dt;
        cloudMotion.individualRotation += ((cloudWind * 50) + 9) * (Math.PI / 65336) * dt;
      }
      const cloudRotSin = Math.sin(cloudMotion.cloudRotation);
      const cloudRotCos = Math.cos(cloudMotion.cloudRotation);
      renderer.getDrawingBufferSize(drawingBufferSize);
      const viewportWidth = Math.max(1, drawingBufferSize.x);
      const viewportHeight = Math.max(1, drawingBufferSize.y);
      skyFeature?.setViewport(viewportWidth, viewportHeight);
      const moonSettings = uiStateRef.current.moon;
      const starsSettings = uiStateRef.current.stars;
      const sunSettings = uiStateRef.current.sun;
      const skyFrame = skyFeature?.prepareFrame(camera, timecycleCurrent, {
        moon: moonSettings,
        stars: starsSettings,
        sun: sunSettings,
      }) || null;
      const sunMetrics = skyFrame?.sunMetrics || null;
      const lowCloudSprites = lowCloudSpritesRef.current;
      for (let index = 0; index < lowCloudSprites.length; index += 1) {
        const sprite = lowCloudSprites[index];
        if (!sprite) continue;
        sprite.visible = lowCloudAlpha > 0.001;
        sprite.position.set(
          camera.position.x + (800 * LOW_CLOUD_OFFSETS_X[index]),
          (60 * LOW_CLOUD_HEIGHTS[index]) + 40,
          camera.position.z + (800 * LOW_CLOUD_OFFSETS_Z[index]),
        );
        sprite.material.color.copy(lowCloudColor).multiplyScalar(lowCloudIntensity);
        sprite.material.opacity = lowCloudAlpha;
      }
      const fluffyCloudSprites = fluffyCloudSpritesRef.current;
      const fluffyHighlightSprites = fluffyHighlightSpritesRef.current;
      const postFxSelection = uiStateRef.current.pipelineDebug?.[RW_PIPELINE_CATEGORY.POSTFX];
      const postFxSunCoronaEnabled = (
        postFxSelection?.config?.enableBigBloomSunEffect
        ?? postFxSelection?.config?.enableSunCorona
        ?? true
      );
      const sunHighlightColor = new THREE.Color().setRGB(1, 190 / 255, 190 / 255, THREE.SRGBColorSpace);
      let sunBlockedByClouds = false;
      for (let index = 0; index < fluffyCloudSprites.length; index += 1) {
        const sprite = fluffyCloudSprites[index];
        const highlightSprite = fluffyHighlightSprites[index];
        if (!sprite) continue;
        const localX = 2 * FLUFFY_OFFSETS_X[index];
        const localZ = 2 * FLUFFY_OFFSETS_Z[index];
        sprite.visible = fluffyCloudAlpha > 0.001;
        if (highlightSprite) highlightSprite.visible = false;
        sprite.position.set(
          camera.position.x + (localX * cloudRotCos) + (localZ * cloudRotSin),
          (40 * FLUFFY_HEIGHTS[index]) + 40,
          camera.position.z + (localX * cloudRotSin) - (localZ * cloudRotCos),
        );
        sprite.material.color.copy(fluffyBottomColor).lerp(fluffyTopColor, 0.4);
        if (sunMetrics?.onScreen && sunSettings.enabled && sunMetrics.rwScreen) {
          const spriteRwScreen = calcScreenCoorsLikeRw(camera, sprite.position, viewportWidth, viewportHeight, false);
          if (spriteRwScreen) {
            const distanceToSun = Math.hypot(
              spriteRwScreen.x - sunMetrics.rwScreen.x,
              spriteRwScreen.y - sunMetrics.rwScreen.y,
            );
          const highlight = (
            (1 - Math.max(foggyness, cloudCoverage))
            * THREE.MathUtils.clamp(1 - (distanceToSun / (viewportWidth * sunSettings.cloudHighlightRadius)), 0, 1)
            * sunSettings.cloudHighlightStrength
          );
          if (highlight > 0) {
            sprite.material.color.lerp(sunHighlightColor, THREE.MathUtils.clamp(highlight, 0, 1));
            if (highlightSprite) {
              highlightSprite.visible = true;
              highlightSprite.position.copy(sprite.position);
              highlightSprite.material.color.setRGB((200 / 255) * highlight, 0, 0, THREE.SRGBColorSpace);
              highlightSprite.material.opacity = 1;
              highlightSprite.material.rotation = 1.7 - Math.atan2(
                spriteRwScreen.x - sunMetrics.rwScreen.x,
                spriteRwScreen.y - sunMetrics.rwScreen.y,
              );
            }
          }
          if (distanceToSun < viewportWidth * sunSettings.cloudBlockRadius) {
            sunBlockedByClouds = true;
          }
          }
        }
        sprite.material.opacity = fluffyCloudAlpha;
        sprite.material.rotation = cloudMotion.individualRotation;
        if (highlightSprite) {
          highlightSprite.scale.setScalar(sprite.scale.x * (30 / 55));
        }
      }
      const sunState = skyFeature?.finalizeSunFrame({
        camera,
        worldRoot: worldRootRef.current,
        timecycleSample: timecycleCurrent,
        settings: { sun: sunSettings },
        dt,
        timeMs: time,
        sunBlockedByClouds,
        sunMetrics,
        enableBigBloom: postFxSunCoronaEnabled,
      });
      const sunLightsMult = computeSunLightsMultFromState(sunState);
      sunRuntimeDebugRef.current = {
        enableBigBloom: postFxSunCoronaEnabled,
        bigSunBloom: Boolean(sunState?.bigSunBloom),
        bloomEligible: Boolean(sunState?.bloomEligible),
        screenCenterBloomFactor: Number(sunState?.screenCenterBloomFactor) || 0,
        facingBloomFactor: Number(sunState?.facingBloomFactor) || 0,
        viewAlignment: Number(sunState?.viewAlignment) || 0,
        centerBloomFactor: Number(sunState?.centerBloomFactor) || 0,
        brightnessBloomFactor: Number(sunState?.brightnessBloomFactor) || 0,
        bloomBrightnessScale: Number(sunState?.bloomBrightnessScale) || 0.35,
        bigBloomFadeAlpha: Number(sunState?.bigBloomFadeAlpha) || 0,
        bigBloomScale: Number(sunState?.bigBloomScale) || 1,
        sunOnScreen: Boolean(sunState?.onScreen),
        coronaFadeAlpha: Number(sunState?.fadeAlpha) || 0,
        sunLightsMult,
      };
      const skyLightMult = computeSkyLightMultFromLightsMult(sunLightsMult);
      skyTopColor.copy(baseSkyTopColor).multiplyScalar(skyLightMult);
      skyBottomColor.copy(baseSkyBottomColor).multiplyScalar(skyLightMult);
      if (skyUniforms) {
        skyUniforms.uSkyTop.value.copy(skyTopColor);
        skyUniforms.uSkyBottom.value.copy(skyBottomColor);
      }

      const sunLight = sunLightRef.current;
      const hemiLight = hemiLightRef.current;
      if (sunLight) {
        const directionalColor = timecycleCurrent?.values?.directional
          ? toThreeColorFromTimecycleValue(timecycleCurrent.values.directional)
          : new THREE.Color(1, 1, 1);
        sunLight.color.copy(directionalColor).multiplyScalar(sunLightsMult);
        sunLight.position.copy(camera.position).addScaledVector(sunState?.direction || new THREE.Vector3(0.5, 1, 0.3), 1200);
        sunLight.target.position.copy(camera.position);
        sunLight.target.updateMatrixWorld();
        sunLight.intensity = computeSunLightIntensityFromState(sunState) * sunLightsMult;
      }
      if (hemiLight) {
        if (timecycleCurrent?.values?.ambient) {
          hemiLight.color.copy(toThreeColorFromTimecycleValue(timecycleCurrent.values.ambient)).multiplyScalar(sunLightsMult);
        }
        hemiLight.intensity = 0.8 * sunLightsMult;
      }

      if (timecycleCurrent?.three?.fogColor?.isColor) {
        const fogNear = Math.max(camera.near, Math.min(timecycleCurrent.values.fogStart, timecycleCurrent.values.farClip - 1));
        const fogFar = Math.max(fogNear + 1, timecycleCurrent.values.farClip);
        if (!scene.fog || !scene.fog.isFog) {
          scene.fog = new THREE.Fog(timecycleCurrent.three.fogColor.clone(), fogNear, fogFar);
        } else {
          scene.fog.color.copy(timecycleCurrent.three.fogColor);
          scene.fog.near = fogNear;
          scene.fog.far = fogFar;
        }
      } else {
        scene.fog = null;
      }
      scene.background = null;

      gtaSessionRef.current.updateStreaming({
        activeBackend,
        activeFadeCountRef,
        activeRenderChunksRef,
        bigBuildingItemsRef,
        camera,
        chunkFrustumRef,
        chunkOcclusionStateRef,
        chunkProjScreenMatrixRef,
        dt,
        effectiveFarClip,
        frameVisibilityRef,
        lodUpdateAccumulatorRef,
        lodUpdateStateRef,
        renderChunkLookupRef,
        renderMetricsRef,
        rwRenderQueueRef,
        timecycleStateRef,
        uiStateRef,
        worldGameVersionRef,
        worldRootRef,
      });

      try {
        gtaSessionRef.current.renderFrame({
          activeBackend,
          camera,
          dt,
          frameVisibilityRef,
          gameIconSprite,
          grid,
          axes,
          hudCamera,
          hudScene,
          iconTextures,
          lastDisableBackfaceCullingRef,
          lastDisableVertexColorRef,
          lastPipelineSelectionSignatureRef,
          lastRenderWaterRef,
          lastWireframeRef,
          postFxDebugCapture: isWindowOpen('rendering'),
          postFxSunCoronaEnabled,
          pushConsoleLine,
          render2dfxEnabled: uiStateRef.current.render2dfx,
          renderMetricsRef,
          renderResourcesReadyRef,
          renderer,
          rendererHost: rendererHostRef.current,
          rwRenderQueueRef,
          scene,
          setStatus,
          showGameIcon: showGameIconRef.current,
          skyBottomColor,
          skyCamera: skyCameraRef.current,
          skyCloudScene: skyCloudSceneRef.current,
          skyFeature,
          skyScene: skySceneRef.current,
          timecycleCurrent,
          timeMs: time,
          uiStateRef,
          viewportHeight,
          viewportWidth,
          worldGameVersionRef,
          worldRootRef,
        });
      } catch (error) {
        console.error('Renderer runtime error:', error);
        if (!backendRuntimeFailed) {
          backendRuntimeFailed = true;
          pushConsoleLine('error', `Renderer runtime error: ${formatConsoleArg(error)}`);
          if (activeBackend !== 'WebGL') {
            setStatus('Renderer backend failed at runtime. Switched to WebGL.');
            uiStateRef.current.backendSelection = 'WebGL';
            backendSwitchingRef.current = true;
            setActiveBackend('WebGL');
          } else {
            setStatus(`Renderer runtime error: ${formatConsoleArg(error)}`);
            backendSwitchingRef.current = false;
          }
        }
        rafId = window.requestAnimationFrame(animate);
        return;
      }

      const { ImGui, ImGui_Impl, ready } = imguiRef.current;
      if (!backendSwitchingRef.current && ready && ImGui && ImGui_Impl) {
        const liveStats = statsRef.current;
        const liveStatus = statusRef.current;

        try {
          ImGui_Impl.NewFrame(time);
          ImGui.NewFrame();
          const io = ImGui.GetIO();
          imguiCaptureRef.current.mouse = Boolean(io?.WantCaptureMouse);
          imguiCaptureRef.current.keyboard = Boolean(io?.WantCaptureKeyboard);

        if (ImGui.BeginMainMenuBar()) {
          if (ImGui.BeginMenu('File')) {
            if (ImGui.BeginMenu('Load map')) {
              if (ImGui.MenuItem('Extracted folder')) {
                openMapPicker('imgui');
              }
              if (ImGui.MenuItem('Zip archive')) {
                openZipPicker();
              }
              ImGui.EndMenu();
            }
            if (ImGui.BeginMenu('Default Maps')) {
              if (ImGui.MenuItem('vcs.zip')) {
                void loadDefaultMap(vcsDefaultMapUrl, 'vcs.zip');
              }
              ImGui.EndMenu();
            }
            ImGui.EndMenu();
          }
          if (ImGui.BeginMenu('View')) {
            for (const item of WINDOW_DEFS) {
              if (ImGui.MenuItem(item.title, '', isWindowOpen(item.key))) {
                setWindowOpen(item.key, !isWindowOpen(item.key));
              }
            }
            ImGui.EndMenu();
          }
          if (ImGui.BeginMenu('Rendering')) {
            if (ImGui.MenuItem('Settings', '', isWindowOpen('rendering'))) {
              setWindowOpen('rendering', !isWindowOpen('rendering'));
            }
            ImGui.EndMenu();
          }
          if (ImGui.BeginMenu('Mode')) {
            if (ImGui.MenuItem('Editor', '', uiStateRef.current.appMode === APP_MODE_EDITOR)) {
              switchAppMode(APP_MODE_EDITOR).catch(() => {});
            }
            if (ImGui.MenuItem('Test', '', uiStateRef.current.appMode === APP_MODE_TEST)) {
              switchAppMode(APP_MODE_TEST).catch(() => {});
            }
            ImGui.EndMenu();
          }
          if (ImGui.BeginMenu('Help')) {
            if (ImGui.MenuItem('About')) {
              setWindowOpen('about', true);
            }
            ImGui.EndMenu();
          }
          const fpsHistory = fpsHistoryRef.current;
          let fpsSum = 0;
          let fpsCount = 0;
          for (let index = 0; index < fpsHistory.length; index += 1) {
            const sample = fpsHistory[index];
            if (sample > 0) {
              fpsSum += sample;
              fpsCount += 1;
            }
          }
          const fpsValue = fpsCount > 0 ? Math.round(fpsSum / fpsCount) : 0;
          const fpsText = `FPS: ${fpsValue}`;
          const brandText = 'jsrw By Nurupo';
          const fpsTextSize = ImGui.CalcTextSize(fpsText);
          const brandTextSize = ImGui.CalcTextSize(brandText);
          const menuBarWidth = ImGui.GetWindowWidth();
          const style = ImGui.GetStyle();
          const rightPadding = style?.FramePadding?.x ?? 0;
          const itemSpacing = style?.ItemSpacing?.x ?? 0;
          const separatorWidth = ImGui.CalcTextSize(' | ').x;
          const totalWidth = fpsTextSize.x + brandTextSize.x + separatorWidth + (itemSpacing * 2) + (rightPadding * 4);
          ImGui.SetCursorPosX(Math.max(ImGui.GetCursorPosX(), menuBarWidth - totalWidth));
          if (ImGui.SmallButton(fpsText)) {
            setWindowOpen('statistics', true);
          }
          ImGui.SameLine();
          ImGui.TextUnformatted('|');
          ImGui.SameLine();
          ImGui.TextUnformatted(brandText);
          ImGui.EndMainMenuBar();
        }

        const Vec2 = ImGui.ImVec2 ?? ImGui.Vec2;
        if (isWindowOpen('mapControls')) {
          ImGui.SetNextWindowPos(new Vec2(16, 16), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(420, 0), ImGui.Cond.Once);
          ImGui.Begin(
            'GTA Map Controls',
            (value = isWindowOpen('mapControls')) => setWindowOpen('mapControls', value),
          );

        ImGui.Text(`Files: ${liveStats.files}`);
        ImGui.Text(`Mode: ${uiStateRef.current.appMode}`);
        ImGui.Text(`IDE loaded: ${liveStats.ideFiles} | defs: ${liveStats.ideDefs}`);
        ImGui.Text(`IPL loaded: ${liveStats.iplFiles} | inst: ${liveStats.iplInst}`);
        ImGui.Text(`Rendered: ${liveStats.loaded} | failed: ${liveStats.failed} | missing IDE: ${liveStats.unresolved}`);

        ImGui.Separator();

        const versionOptions = ['SA', 'VCS'];
        if (ImGui.BeginCombo('GAME VERION', uiStateRef.current.gameVersion)) {
          for (const option of versionOptions) {
            const selected = uiStateRef.current.gameVersion === option;
            if (ImGui.Selectable(option, selected)) {
              uiStateRef.current.gameVersion = option;
            }
            if (selected) {
              ImGui.SetItemDefaultFocus();
            }
          }
          ImGui.EndCombo();
        }
        const quaternionOrderOptions = ['XYZW', 'WXYZ'];
        if (ImGui.BeginCombo('Quaternion Order', uiStateRef.current.quaternionOrder)) {
          for (const option of quaternionOrderOptions) {
            const selected = uiStateRef.current.quaternionOrder === option;
            if (ImGui.Selectable(option, selected)) {
              uiStateRef.current.quaternionOrder = option;
            }
            if (selected) {
              ImGui.SetItemDefaultFocus();
            }
          }
          ImGui.EndCombo();
        }
        ImGui.Checkbox(
          'Show LODs',
          (value = uiStateRef.current.showLods) => {
            uiStateRef.current.showLods = value;
            return value;
          },
        );
        ImGui.Checkbox(
          'Force LOD only',
          (value = uiStateRef.current.forceLodOnly) => {
            uiStateRef.current.forceLodOnly = value;
            return value;
          },
        );
        ImGui.Checkbox(
          'Show TOBJs',
          (value = uiStateRef.current.showTobjs) => {
            uiStateRef.current.showTobjs = value;
            return value;
          },
        );
        ImGui.Checkbox(
          'Render 2DFX',
          (value = uiStateRef.current.render2dfx) => {
            uiStateRef.current.render2dfx = value;
            return value;
          },
        );
        ImGui.Checkbox(
          'Force Render 2DFX',
          (value = uiStateRef.current.forceRender2dfx) => {
            uiStateRef.current.forceRender2dfx = value;
            return value;
          },
        );
        ImGui.Text('draw dist: LOD switch distance (near model <-> LOD)');
        ImGui.PushItemWidth(-1);
        let drawDistanceValue = Math.round(uiStateRef.current.drawDistance);
        if (ImGui.SliderInt(
          'draw dist',
          (value = drawDistanceValue) => {
            drawDistanceValue = value;
            return value;
          },
          20,
          3000,
        )) {
          uiStateRef.current.drawDistance = drawDistanceValue;
        }
        const currentFarClip = timecycleStateRef.current?.current?.values?.farClip;
        ImGui.Text('far clip: max visible distance (timecyc-driven when loaded)');
        if (Number.isFinite(currentFarClip)) ImGui.BeginDisabled();
        let farClipValue = Math.round(Number.isFinite(currentFarClip) ? currentFarClip : uiStateRef.current.renderingDistance);
        if (ImGui.SliderInt(
          'Far Clip',
          (value = farClipValue) => {
            farClipValue = value;
            return value;
          },
          50,
          20000,
        ) && !Number.isFinite(currentFarClip)) {
          uiStateRef.current.renderingDistance = farClipValue;
        }
        if (Number.isFinite(currentFarClip)) ImGui.EndDisabled();
        ImGui.Text('lod dist multiplier: VC horizon strip scale');
        let lodDistMultiplierValue = uiStateRef.current.lodDistMultiplier;
        if (ImGui.SliderFloat(
          'LOD Dist Multiplier',
          (value = lodDistMultiplierValue) => {
            lodDistMultiplierValue = value;
            return value;
          },
          0,
          4,
          '%.2f',
        )) {
          uiStateRef.current.lodDistMultiplier = lodDistMultiplierValue;
        }
        ImGui.PopItemWidth();
        ImGui.Checkbox(
          'Show grid',
          (value = uiStateRef.current.showGrid) => {
            uiStateRef.current.showGrid = value;
            return value;
          },
        );
        ImGui.Checkbox(
          'Show axes',
          (value = uiStateRef.current.showAxes) => {
            uiStateRef.current.showAxes = value;
            return value;
          },
        );
        ImGui.Checkbox(
          'Wireframe',
          (value = uiStateRef.current.wireframe) => {
            uiStateRef.current.wireframe = value;
            return value;
          },
        );
        ImGui.Checkbox(
          'Disable Vertex Color',
          (value = uiStateRef.current.disableVertexColor) => {
            uiStateRef.current.disableVertexColor = value;
            return value;
          },
        );

        if (ImGui.Button('Build / Rebuild')) {
          rebuildWorld();
        }
        ImGui.SameLine();
        if (ImGui.Button('Clear')) {
          clearWorld();
        }
        const liveProgress = buildProgressRef.current;
        if (liveProgress.active) {
          const progressTotal = Math.max(1, liveProgress.total);
          const progressFraction = liveProgress.current / progressTotal;
          ImGui.ProgressBar(
            progressFraction,
            new Vec2(-1, 0),
            `${Math.floor(progressFraction * 100)}% (${liveProgress.current}/${progressTotal})`,
          );
        }

          ImGui.TextWrapped(liveStatus);
          ImGui.End();
        }

        if (isWindowOpen('timecycle')) {
          ImGui.SetNextWindowPos(new Vec2(460, 16), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(420, 0), ImGui.Cond.Once);
          ImGui.Begin(
            'Time & Weather',
            (value = isWindowOpen('timecycle')) => setWindowOpen('timecycle', value),
          );
          const tcState = timecycleStateRef.current;
          const tcData = tcState?.data;
          const tcCurrent = tcState?.current;
          const tcControls = tcState?.controls;
          const weatherNames = Array.isArray(tcState?.weatherNames) && tcState.weatherNames.length > 0
            ? tcState.weatherNames
            : [...VCS_WEATHER_NAMES];
          if (!tcData || !tcCurrent || !tcControls) {
            ImGui.TextWrapped('No timecyc.dat loaded or current game version format is not implemented.');
          } else {
            const timecycleRow = (label, drawControl) => {
              ImGui.PushID(label);
              ImGui.Columns(2, `timecycle-row-${label}`, false);
              ImGui.SetColumnWidth(0, 130);
              ImGui.AlignTextToFramePadding();
              ImGui.TextUnformatted(label);
              ImGui.NextColumn();
              ImGui.PushItemWidth(-1);
              drawControl();
              ImGui.PopItemWidth();
              ImGui.Columns(1);
              ImGui.PopID();
            };

            ImGui.TextWrapped(`Source: ${tcState.sourcePath || 'data/timecyc.dat'}`);
            if (Object.keys(tcControls.overrides || {}).length > 0) {
              if (ImGui.Button('Reset Overrides')) {
                tcControls.overrides = {};
              }
              ImGui.Separator();
            }
            const defaultOpen = ImGui.TreeNodeFlags?.DefaultOpen ?? 0;
            if (ImGui.CollapsingHeader('Time Controls', defaultOpen)) {
              timecycleRow('Time Of Day', () => {
                let totalMinutesValue = (tcControls.hour * 60) + tcControls.minute;
                if (ImGui.SliderInt(
                  '##time-of-day',
                  (value = totalMinutesValue) => {
                    totalMinutesValue = value;
                    return value;
                  },
                  0,
                  1439,
                  `${String(tcControls.hour).padStart(2, '0')}:${String(tcControls.minute).padStart(2, '0')}`,
                )) {
                  const totalMinutes = Math.max(0, Math.min(1439, Math.round(totalMinutesValue)));
                  tcControls.hour = Math.floor(totalMinutes / 60);
                  tcControls.minute = totalMinutes % 60;
                }
              });
              timecycleRow('Weather A', () => {
                if (ImGui.BeginCombo('##weather-a', weatherNames[tcControls.weatherA] || 'UNKNOWN')) {
                  for (let index = 0; index < weatherNames.length; index += 1) {
                    const selected = tcControls.weatherA === index;
                    if (ImGui.Selectable(`${index}: ${weatherNames[index]}`, selected)) tcControls.weatherA = index;
                    if (selected) ImGui.SetItemDefaultFocus();
                  }
                  ImGui.EndCombo();
                }
              });
              timecycleRow('Weather B', () => {
                if (ImGui.BeginCombo('##weather-b', weatherNames[tcControls.weatherB] || 'UNKNOWN')) {
                  for (let index = 0; index < weatherNames.length; index += 1) {
                    const selected = tcControls.weatherB === index;
                    if (ImGui.Selectable(`${index}: ${weatherNames[index]}`, selected)) tcControls.weatherB = index;
                    if (selected) ImGui.SetItemDefaultFocus();
                  }
                  ImGui.EndCombo();
                }
              });
              timecycleRow('Weather Blend', () => {
                let weatherBlendValue = tcControls.weatherBlend;
                if (ImGui.SliderFloat(
                  '##weather-blend',
                  (value = weatherBlendValue) => {
                    weatherBlendValue = value;
                    return value;
                  },
                  0,
                  1,
                  '%.3f',
                )) {
                  tcControls.weatherBlend = Math.max(0, Math.min(1, weatherBlendValue));
                }
              });
              if (tcData.extraColourCount > 0 && tcData.extraColourWeatherIndex >= 0) {
                timecycleRow('Extra Colour', () => {
                  let extraColourValue = tcControls.extraColour;
                  if (ImGui.SliderInt(
                    '##extra-colour',
                    (value = extraColourValue) => {
                      extraColourValue = value;
                      return value;
                    },
                    -1,
                    (tcData.extraColourCount * tcData.hours) - 1,
                    tcControls.extraColour < 0 ? 'Disabled' : `Hour ${tcControls.extraColour % tcData.hours}`,
                  )) {
                    tcControls.extraColour = Math.max(-1, Math.min((tcData.extraColourCount * tcData.hours) - 1, Math.round(extraColourValue)));
                  }
                });
              }
              ImGui.TextWrapped(`Current Weather: ${tcCurrent.weatherNameA} -> ${tcCurrent.weatherNameB}`);
              ImGui.Text(`Time Alpha: ${tcCurrent.timeAlpha.toFixed(3)}`);
              if (tcCurrent.extraColourEnabled) {
                ImGui.Text(`Extra Colour Active: ${tcCurrent.extraColour}`);
              }
            }

            if (ImGui.CollapsingHeader('Timecycle Parameters', defaultOpen)) {
              for (const field of TIMECYCLE_FIELD_GROUPS) {
                const value = tcCurrent.values[field.key];
                if (value == null) continue;
                timecycleRow(field.label, () => {
                if (field.type === 'rgb' || field.type === 'rgba') {
                  let color = toTimecycleColorArray(value, field.type);
                  const changed = field.type === 'rgba'
                    ? ImGui.ColorEdit4(`##${field.key}`, color)
                    : ImGui.ColorEdit3(`##${field.key}`, color);
                  if (changed) {
                    tcControls.overrides[field.key] = fromTimecycleColorArray(color, field.type);
                  }
                } else if (field.key === 'farClip' || field.key === 'fogStart') {
                  let nextValue = Number(tcControls.overrides[field.key] ?? value);
                  const changed = ImGui.SliderFloat(
                    `##${field.key}`,
                    (editValue = nextValue) => {
                      nextValue = editValue;
                      return editValue;
                    },
                    field.key === 'farClip' ? 50 : -128,
                    4000,
                    '%.3f',
                  );
                  if (changed) tcControls.overrides[field.key] = nextValue;
                } else {
                  let nextValue = Number(tcControls.overrides[field.key] ?? value);
                  const changed = ImGui.InputFloat(
                    `##${field.key}`,
                    (editValue = nextValue) => {
                      nextValue = editValue;
                      return editValue;
                    },
                    0.1,
                    1,
                    '%.3f',
                  );
                  if (changed) tcControls.overrides[field.key] = nextValue;
                }
                  ImGui.SameLine();
                  if (ImGui.SmallButton(`Reset##${field.key}`)) delete tcControls.overrides[field.key];
                });
              }
            }
          }
          ImGui.End();
        }

        if (isWindowOpen('objectDetail')) {
          ImGui.SetNextWindowPos(new Vec2(860, 16), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(420, 320), ImGui.Cond.Once);
          ImGui.Begin(
            'Object Detail',
            (value = isWindowOpen('objectDetail')) => setWindowOpen('objectDetail', value),
          );
          const detail = selectedObjectRef.current;
          if (!detail) {
            ImGui.TextWrapped('No object selected. Click an object in Editor mode.');
          } else {
            const defaultOpen = ImGui.TreeNodeFlags?.DefaultOpen ?? 0;
            if (ImGui.CollapsingHeader('Identity', defaultOpen)) {
              ImGui.Text(`ID: ${detail.id}`);
              ImGui.Text(`Placement ID: ${detail.placementId}`);
              ImGui.Text(`Model: ${detail.modelName}`);
              ImGui.Text(`Texture (TXD): ${detail.txdName}`);
              ImGui.Text(`Section: ${detail.section}`);
              ImGui.Text(`LOD Kind: ${detail.lodKind}`);
              ImGui.Text(`Flags: ${detail.flags}`);
              const flagNames = Array.isArray(detail.activeFlagNames) ? detail.activeFlagNames : [];
              ImGui.Text(`Flag Names: ${flagNames.length}`);
              if (flagNames.length > 0) {
                ImGui.BeginChild('obj-flag-names', new Vec2(0, 80), true);
                for (const flagName of flagNames) {
                  ImGui.TextUnformatted(flagName);
                }
                ImGui.EndChild();
              }
              ImGui.Text(`Draw Distance: ${Number.isFinite(detail.drawDistance) ? detail.drawDistance : 'N/A'}`);
              const ideEffects = Array.isArray(detail.ideEffects) ? detail.ideEffects : [];
              const ideLights = ideEffects.filter((e) => e.kind === 'light');
              const dffLights = Array.isArray(detail.dffLights) ? detail.dffLights : [];
              const lightSummary = detail.hasLighting
                ? `yes (${ideLights.length} 2DFX, ${dffLights.length} DFF)`
                : 'no';
              ImGui.Text(`Lighting: ${lightSummary}`);
            }
            if (ImGui.CollapsingHeader('Transform', defaultOpen)) {
              ImGui.Text(
                `Position: ${detail.position.x.toFixed(3)}, ${detail.position.y.toFixed(3)}, ${detail.position.z.toFixed(3)}`,
              );
              ImGui.Text(
                `Rotation(q): ${detail.rotation.x.toFixed(6)}, ${detail.rotation.y.toFixed(6)}, ${detail.rotation.z.toFixed(6)}, ${detail.rotation.w.toFixed(6)}`,
              );
            }
            if (ImGui.CollapsingHeader('Lighting', defaultOpen)) {
              const ideEffects = Array.isArray(detail.ideEffects) ? detail.ideEffects : [];
              const ideLights = ideEffects.filter((e) => e.kind === 'light');
              const dffLights = Array.isArray(detail.dffLights) ? detail.dffLights : [];
              ImGui.Text(`Has Lighting: ${detail.hasLighting ? 'yes' : 'no'}`);
              ImGui.Text(`IDE 2DFX lights: ${ideLights.length}`);
              ImGui.Text(`DFF RW lights: ${dffLights.length}`);
              if (ideLights.length > 0) {
                ImGui.SeparatorText?.('2DFX');
                ImGui.BeginChild('obj-2dfx-lights', new Vec2(0, 110), true);
                for (const effect of ideLights) {
                  ImGui.TextWrapped(
                    `#${effect.effectIndex ?? 0} ${effect.coronaTextureName || 'corona'} dist=${Number(effect.distance || 0).toFixed(2)} size=${Number(effect.size || 0).toFixed(2)} outerRange=${Number(effect.outerRange || 0).toFixed(2)}`,
                  );
                }
                ImGui.EndChild();
              }
              if (dffLights.length > 0) {
                ImGui.SeparatorText?.('DFF');
                ImGui.BeginChild('obj-dff-lights', new Vec2(0, 110), true);
                for (const light of dffLights) {
                  ImGui.TextWrapped(
                    `#${light.lightIndex ?? 0} type=${light.lightType} flags=${light.flags} radius=${Number(light.radius || 0).toFixed(2)} frame=${light.frameIndex ?? -1}`,
                  );
                }
                ImGui.EndChild();
              }
            }
            if (ImGui.CollapsingHeader('Textures In Model', defaultOpen)) {
              const items = Array.isArray(detail.usedTextureEntries) ? detail.usedTextureEntries : [];
              ImGui.Text(`Count: ${items.length}`);
              ImGui.BeginChild('obj-used-tex', new Vec2(0, 180), true);
              const thumbSize = 48;
              const tileWidth = 92;
              const avail = Math.max(1, ImGui.GetContentRegionAvail().x);
              const perRow = Math.max(1, Math.floor(avail / tileWidth));
              if (items.length > 0) {
                ImGui.Columns(perRow, 'obj-used-tex-grid', false);
                for (const entry of items) {
                  ImGui.BeginGroup();
                  const texId = getImguiTextureForImage(entry.texture);
                  if (texId) {
                    ImGui.Image(texId, new Vec2(thumbSize, thumbSize));
                    if (ImGui.IsItemHovered() && ImGui.IsMouseDoubleClicked(0)) {
                      openTextureDetail(entry, detail);
                    }
                  } else {
                    ImGui.Dummy(new Vec2(thumbSize, thumbSize));
                  }
                  ImGui.TextWrapped(entry.name);
                  if (ImGui.IsItemHovered() && ImGui.IsMouseDoubleClicked(0)) {
                    openTextureDetail(entry, detail);
                  }
                  ImGui.EndGroup();
                  ImGui.NextColumn();
                }
                ImGui.Columns(1);
              }
              if (items.length === 0) {
                ImGui.TextUnformatted('No texture references found.');
              }
              ImGui.EndChild();
            }
          }
          ImGui.End();
        }

        if (selectedTextureDetailRef.current) {
          ImGui.SetNextWindowPos(new Vec2(980, 360), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(320, 0), ImGui.Cond.Once);
          let textureDetailOpen = true;
          ImGui.Begin(
            'Texture Detail',
            (value = textureDetailOpen) => {
              textureDetailOpen = value;
              return value;
            },
            ImGui.WindowFlags.AlwaysAutoResize,
          );
          if (!textureDetailOpen) {
            selectedTextureDetailRef.current = null;
            setSelectedTextureDetail(null);
            ImGui.End();
          } else {
            const texDetail = selectedTextureDetailRef.current;
            ImGui.Text(`name = ${texDetail.name}`);
            ImGui.Text(`txd = ${texDetail.txdName}`);
            ImGui.Text(`compress = ${texDetail.compressionMethod}`);
            ImGui.Text(`pixel format = ${texDetail.pixelFormat}`);
            ImGui.Text(`size = ${texDetail.width} x ${texDetail.height}`);
            ImGui.Separator();
            const texId = getImguiTextureForImage(texDetail.texture);
            if (texId && texDetail.width > 0 && texDetail.height > 0) {
              const maxPreview = 256;
              const aspect = texDetail.width / texDetail.height;
              const previewW = aspect >= 1 ? maxPreview : (maxPreview * aspect);
              const previewH = aspect >= 1 ? (maxPreview / aspect) : maxPreview;
              ImGui.Image(texId, new Vec2(previewW, previewH));
            } else {
              ImGui.TextUnformatted('Preview unavailable');
            }
            ImGui.End();
          }
        }

        if (isWindowOpen('statistics')) {
          let statisticsWindowBegun = false;
          try {
            ImGui.SetNextWindowPos(STATS_WINDOW_DEFAULT_POS, ImGui.Cond.Once);
            ImGui.SetNextWindowSize(STATS_WINDOW_DEFAULT_SIZE, ImGui.Cond.Once);
            ImGui.SetNextWindowSizeConstraints(STATS_WINDOW_MIN_SIZE, STATS_WINDOW_MAX_SIZE);
            ImGui.SetNextWindowBgAlpha(0.92);
            ImGui.PushStyleColor(ImGui.Col.WindowBg, STATS_COLOR_WINDOW_BG);
            ImGui.PushStyleColor(ImGui.Col.Border, STATS_COLOR_BORDER);
            ImGui.PushStyleColor(ImGui.Col.FrameBg, STATS_COLOR_FRAME_BG);
            ImGui.PushStyleColor(ImGui.Col.PlotLines, STATS_COLOR_PLOT_LINE);
            ImGui.PushStyleColor(ImGui.Col.PlotLinesHovered, STATS_COLOR_PLOT_LINE_HOVER);
            ImGui.PushStyleColor(ImGui.Col.Header, STATS_COLOR_HEADER);
            ImGui.PushStyleColor(ImGui.Col.HeaderHovered, STATS_COLOR_HEADER_HOVER);
            ImGui.PushStyleColor(ImGui.Col.HeaderActive, STATS_COLOR_HEADER_ACTIVE);
            ImGui.PushStyleVar(ImGui.StyleVar.WindowPadding, STATS_WINDOW_PADDING);
            ImGui.PushStyleVar(ImGui.StyleVar.WindowBorderSize, 1);
            ImGui.PushStyleVar(ImGui.StyleVar.WindowRounding, 0);
            ImGui.PushStyleVar(ImGui.StyleVar.ItemSpacing, STATS_WINDOW_ITEM_SPACING);
            ImGui.Begin(
              'Statistics',
              (value = isWindowOpen('statistics')) => setWindowOpen('statistics', value),
              0,
            );
            statisticsWindowBegun = true;
            const fpsValues = fpsHistoryRef.current;
            const fpsSampleCount = fpsSampleCountRef.current;
            let fpsMin = Number.POSITIVE_INFINITY;
            let fpsMax = 0;
            let fpsSum = 0;
            let fpsCount = 0;
            for (let i = 0; i < fpsSampleCount; i += 1) {
              const value = fpsValues[i];
              if (value <= 0) continue;
              fpsMin = Math.min(fpsMin, value);
              fpsMax = Math.max(fpsMax, value);
              fpsSum += value;
              fpsCount += 1;
            }
            const fpsAvg = fpsCount > 0 ? (fpsSum / fpsCount) : 0;
            const fpsCurrentIndex = (fpsHistoryIndexRef.current - 1 + fpsValues.length) % fpsValues.length;
            const fpsCurrent = fpsValues[fpsCurrentIndex] || 0;
            const frameCurrentMs = fpsCurrent > 0 ? (1000 / fpsCurrent) : 0;
            const frameBestMs = fpsMax > 0 ? (1000 / fpsMax) : 0;
            const frameWorstMs = fpsMin > 0 ? (1000 / fpsMin) : 0;
            const frameAvgMs = fpsAvg > 0 ? (1000 / fpsAvg) : 0;
            const renderMetrics = renderMetricsRef.current;
            const statisticsWindowSize = ImGui.GetWindowSize(statsWindowSizeRef.current);
            const surfaceWidth = Number(canvasRef.current?.width) || 0;
            const surfaceHeight = Number(canvasRef.current?.height) || 0;
            const renderSummaryRow = (label, value, rangeText = '', color = STATS_COLOR_TEXT, rangeColor = null) => {
              const rowStartX = ImGui.GetCursorPosX();
              const rowAvailWidth = Math.max(120, ImGui.GetContentRegionAvail().x);
              const stackedLayout = rowAvailWidth < 290;
              if (stackedLayout) {
                ImGui.TextUnformatted(`${label}:`);
                ImGui.SameLine();
                ImGui.TextColored(color, value);
                if (rangeText) {
                  ImGui.PushTextWrapPos(rowStartX + rowAvailWidth);
                  if (rangeColor) ImGui.TextColored(rangeColor, rangeText);
                  else ImGui.TextDisabled(rangeText);
                  ImGui.PopTextWrapPos();
                }
                return;
              }

              const valueColumnX = rowStartX + Math.max(74, Math.min(118, rowAvailWidth * 0.24));
              const rangeColumnX = rowStartX + Math.max(150, Math.min(228, rowAvailWidth * 0.52));
              ImGui.TextUnformatted(`${label}:`);
              ImGui.SameLine(valueColumnX);
              ImGui.TextColored(color, value);
              if (rangeText) {
                ImGui.SameLine(rangeColumnX);
                ImGui.PushTextWrapPos(rowStartX + rowAvailWidth);
                if (rangeColor) ImGui.TextColored(rangeColor, rangeText);
                else ImGui.TextDisabled(rangeText);
                ImGui.PopTextWrapPos();
              }
            };
            renderSummaryRow('Renderer', activeBackend, `[${surfaceWidth}x${surfaceHeight}]`, STATS_COLOR_TEXT, STATS_COLOR_TEXT);
            renderSummaryRow('FPS', fpsCurrent.toFixed(2), `[ ${fpsCount > 0 ? fpsMin.toFixed(2) : '0.00'}  ${fpsAvg.toFixed(2)}  ${fpsMax.toFixed(2)} ]`, STATS_COLOR_FPS);
            renderSummaryRow('Frame', `${frameCurrentMs.toFixed(2)}ms`, `[ ${frameBestMs.toFixed(2)}  ${frameAvgMs.toFixed(2)}  ${frameWorstMs.toFixed(2)} ]`, STATS_COLOR_FRAME);
            renderSummaryRow('Triangles', `${renderMetrics.triangles}`, `[ world ${renderMetrics.worldTriangles}  water ${renderMetrics.waterTriangles} ]`, STATS_COLOR_TRIANGLES);
            const graphAvailHeight = Math.max(0, ImGui.GetContentRegionAvail().y);
            const graphAvailWidth = Math.max(1, ImGui.GetContentRegionAvail().x);
            const fpsGraphHeight = Math.max(
              72,
              Math.min(
                180,
                Math.max(86, statisticsWindowSize.y * 0.34),
                graphAvailHeight > 0 ? graphAvailHeight : 180,
              ),
            );
            const fpsGraphSize = { x: graphAvailWidth, y: fpsGraphHeight };
            const fpsPlotMin = fpsCount > 0 ? Math.max(0, fpsMin * 0.9) : 0;
            const fpsPlotMax = Math.max(fpsPlotMin + 1, fpsMax * 1.1, fpsAvg * 1.1, fpsCurrent * 1.1, 60);
            if (fpsSampleCount > 0) {
              const fpsPlotOffset = fpsSampleCount < fpsValues.length ? 0 : fpsHistoryIndexRef.current;
              ImGui.PlotLines(
                '##fps-plot',
                fpsValues,
                fpsSampleCount,
                fpsPlotOffset,
                '',
                fpsPlotMin,
                fpsPlotMax,
                fpsGraphSize,
              );
            } else {
              ImGui.Dummy(fpsGraphSize);
            }
            const fpsGraphDrawList = ImGui.GetWindowDrawList();
            const fpsGraphMin = ImGui.GetItemRectMin(statsGraphRectMinRef.current);
            const fpsGraphMax = ImGui.GetItemRectMax(statsGraphRectMaxRef.current);
            const fpsGraphGridColor = ImGui.GetColorU32(STATS_COLOR_GRID);
            const fpsGraphBorderColor = ImGui.GetColorU32(STATS_COLOR_GRAPH_BORDER);
            const fpsGraphInsetMin = { x: fpsGraphMin.x + 1, y: fpsGraphMin.y + 1 };
            const fpsGraphInsetMax = { x: fpsGraphMax.x - 1, y: fpsGraphMax.y - 1 };
            for (let i = 1; i < 4; i += 1) {
              const y = fpsGraphInsetMin.y + (((fpsGraphInsetMax.y - fpsGraphInsetMin.y) * i) / 4);
              fpsGraphDrawList.AddLine(
                { x: fpsGraphInsetMin.x, y },
                { x: fpsGraphInsetMax.x, y },
                fpsGraphGridColor,
                1,
              );
            }
            for (let i = 1; i < 6; i += 1) {
              const x = fpsGraphInsetMin.x + (((fpsGraphInsetMax.x - fpsGraphInsetMin.x) * i) / 6);
              fpsGraphDrawList.AddLine(
                { x, y: fpsGraphInsetMin.y },
                { x, y: fpsGraphInsetMax.y },
                fpsGraphGridColor,
                1,
              );
            }
            fpsGraphDrawList.AddRect(fpsGraphMin, fpsGraphMax, fpsGraphBorderColor, 0, 0, 1);
            ImGui.SetNextItemOpen(false, ImGui.Cond.Once);
            if (ImGui.CollapsingHeader('Details')) {
              ImGui.Text(`Draw Calls: ${renderMetrics.drawCalls}`);
              ImGui.Text(`Triangles: ${renderMetrics.triangles}`);
              ImGui.Text(`Renderer backend: requested ${renderMetrics.rendererBackend} | actual ${renderMetrics.rendererActualBackend}`);
              ImGui.Text(`Renderer target: samples ${renderMetrics.rendererCurrentSamples} | output ${renderMetrics.rendererOutputBufferType}`);
              ImGui.Text(`World: calls ${renderMetrics.worldDrawCalls} | tris ${renderMetrics.worldTriangles}`);
              ImGui.Text(`Water: calls ${renderMetrics.waterDrawCalls} | tris ${renderMetrics.waterTriangles}`);
              ImGui.Text(`Sky/HUD: calls ${renderMetrics.skyDrawCalls} | tris ${renderMetrics.skyTriangles}`);
              ImGui.Text(
                `Sky clouds pass: ${renderMetrics.skyCloudsPassInvoked ? 'yes' : 'no'} | calls ${renderMetrics.skyCloudsPassDrawCalls ?? 0} | tris ${renderMetrics.skyCloudsPassTriangles ?? 0}`,
              );
              ImGui.Text(`Chunks: ${renderMetrics.frustumChunks}/${statsRef.current.totalChunks}`);
              ImGui.Text(`Active Items: ${renderMetrics.activeItems}`);
              ImGui.Text(`Pipeline materials: active ${renderMetrics.pipelineActiveMaterials} | cached ${renderMetrics.pipelineCachedMaterials}`);
              ImGui.Text(`Fade: active ${renderMetrics.activeFadeCount} | proxies ${renderMetrics.fadeProxyCount}`);
              ImGui.Text(`Render Queue: opaque ${renderMetrics.opaqueQueue} | cutout ${renderMetrics.cutoutQueue} | blend ${renderMetrics.transparentQueue} | add ${renderMetrics.additiveQueue} | overlay ${renderMetrics.overlayQueue}`);
              ImGui.Text(`Instancing: batches ${statsRef.current.instancedBatches} | placements ${statsRef.current.instancedItems}`);
              ImGui.Text(`Lighting: IDE 2DFX ${statsRef.current.ideEffects} | objects ${statsRef.current.lightObjects} | emitters ${statsRef.current.lightEmitters}`);
            }
          } catch (error) {
            pushConsoleLine('error', `Statistics window error: ${formatConsoleArg(error)}`);
            setWindowOpen('statistics', false);
          } finally {
            if (statisticsWindowBegun) ImGui.End();
            ImGui.PopStyleVar(4);
            ImGui.PopStyleColor(8);
          }
        }

        if (isWindowOpen('console')) {
          ImGui.SetNextWindowPos(new Vec2(16, 370), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(720, 260), ImGui.Cond.Once);
          ImGui.Begin(
            'Console',
            (value = isWindowOpen('console')) => setWindowOpen('console', value),
          );
          if (ImGui.Button('Clear logs')) {
            setConsoleLines([]);
            setFailedModels([]);
          }
          ImGui.SameLine();
          ImGui.Text(`Lines: ${consoleLinesRef.current.length}`);
          ImGui.Separator();
          if (ImGui.BeginTabBar('console-tabs')) {
            if (ImGui.BeginTabItem('Console')) {
              ImGui.BeginChild('console-scroll', new Vec2(0, 0), true);
              const lines = consoleLinesRef.current;
              const start = Math.max(0, lines.length - 500);
              let text = lines
                .slice(start)
                .map((line) => `[${line.ts}] [${line.level.toUpperCase()}] [${line.source}] ${line.message}`)
                .join('\n');
              ImGui.InputTextMultiline(
                '##console-text',
                (value = text) => { text = value; return text; },
                Math.max(4096, text.length + 1),
                new Vec2(-1, -1),
                ImGui.InputTextFlags.ReadOnly,
              );
              ImGui.EndChild();
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('Files')) {
              ImGui.BeginChild('console-files-scroll', new Vec2(0, 0), true);
              const files = loadedFilesRef.current.filter((entry) => {
                const detail = String(entry.detail || '').trim().toLowerCase();
                if (!detail) return false;
                if (detail === 'declared' || detail === 'required' || detail === 'optional') return false;
                return true;
              });
              const prioritizedFiles = files
                .slice()
                .sort((a, b) => {
                  const aPriority = a.kind === 'RUNTIME_MAP' ? 0 : 1;
                  const bPriority = b.kind === 'RUNTIME_MAP' ? 0 : 1;
                  if (aPriority !== bPriority) return aPriority - bPriority;
                  return 0;
                });
              const start = Math.max(0, prioritizedFiles.length - 1000);
              let text = prioritizedFiles
                .slice(start)
                .map((entry) => {
                  const detail = entry.detail ? ` (${entry.detail})` : '';
                  return `[${entry.kind}] ${entry.path}${detail}`;
                })
                .join('\n');
              ImGui.InputTextMultiline(
                '##files-text',
                (value = text) => { text = value; return text; },
                Math.max(4096, text.length + 1),
                new Vec2(-1, -1),
                ImGui.InputTextFlags.ReadOnly,
              );
              ImGui.EndChild();
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('Error')) {
              ImGui.BeginChild('console-error-scroll', new Vec2(0, 0), true);
              const errorLines = consoleLinesRef.current.filter((line) => line.level === 'error');
              const start = Math.max(0, errorLines.length - 500);
              let text = errorLines
                .slice(start)
                .map((line) => `[${line.ts}] [${line.source}] ${line.message}`)
                .join('\n');
              ImGui.InputTextMultiline(
                '##error-text',
                (value = text) => { text = value; return text; },
                Math.max(4096, text.length + 1),
                new Vec2(-1, -1),
                ImGui.InputTextFlags.ReadOnly,
              );
              ImGui.EndChild();
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('Failed')) {
              ImGui.BeginChild('console-failed-scroll', new Vec2(0, 0), true);
              const entries = failedModelsRef.current;
              const start = Math.max(0, entries.length - 2000);
              let text = entries
                .slice(start)
                .join('\n');
              ImGui.InputTextMultiline(
                '##failed-text',
                (value = text) => { text = value; return text; },
                Math.max(4096, text.length + 1),
                new Vec2(-1, -1),
                ImGui.InputTextFlags.ReadOnly,
              );
              ImGui.EndChild();
              ImGui.EndTabItem();
            }
            ImGui.EndTabBar();
          }
          ImGui.End();
        }

        if (isWindowOpen('rendering')) {
          ImGui.SetNextWindowPos(new Vec2(460, 16), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(320, 240), ImGui.Cond.Once);
          ImGui.Begin(
            'Rendering',
            (value = isWindowOpen('rendering')) => setWindowOpen('rendering', value),
          );
          if (ImGui.BeginTabBar('rendering-tabs')) {
            if (ImGui.BeginTabItem('Pipeline')) {
              ImGui.Checkbox(
                'Disable Backface Culling',
                (value = uiStateRef.current.disableBackfaceCulling) => {
                  uiStateRef.current.disableBackfaceCulling = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Enable Occlusion',
                (value = uiStateRef.current.enableOcclusion) => {
                  uiStateRef.current.enableOcclusion = value;
                  return value;
                },
              );
              const defaultOpen = ImGui.TreeNodeFlags?.DefaultOpen ?? 0;
              if (ImGui.CollapsingHeader('Water', defaultOpen)) {
                ImGui.TextWrapped('Single-layer RW water. The mesh is drawn as instanced 8x8 sector patches, with RW-style vertex waves on every patch.');
                ImGui.Checkbox(
                  'Render Water',
                  (value = uiStateRef.current.renderWater) => {
                    uiStateRef.current.renderWater = value;
                    return value;
                  },
                );
                renderImguiSliderRow(ImGui, {
                  id: 'uv-speed',
                  rowPrefix: 'water-row',
                  label: 'Texture Scroll Speed',
                  value: uiStateRef.current.waterUvSpeed,
                  setValue: (value) => { uiStateRef.current.waterUvSpeed = value; },
                  min: 0,
                  max: 4,
                });
                renderImguiSliderRow(ImGui, {
                  id: 'wave-height',
                  rowPrefix: 'water-row',
                  label: 'Wave Height Scale',
                  value: uiStateRef.current.waterWaveHeight,
                  setValue: (value) => { uiStateRef.current.waterWaveHeight = value; },
                  min: 0,
                  max: 100,
                  format: '%.0f',
                });
                renderImguiSliderRow(ImGui, {
                  id: 'water-alpha',
                  rowPrefix: 'water-row',
                  label: 'Fallback Alpha',
                  value: uiStateRef.current.waterAlpha,
                  setValue: (value) => { uiStateRef.current.waterAlpha = value; },
                  min: 0,
                  max: 1,
                });
                ImGui.TextWrapped('RW alignment: wind is pinned to 0, so the default wave profile uses the original 0.3 baseline swell with no weather-driven boost.');
              }
              if (ImGui.CollapsingHeader('Sky', defaultOpen)) {
                renderImguiSliderRow(ImGui, {
                  id: 'lod-dist-multiplier',
                  rowPrefix: 'sky-row',
                  label: 'LOD Dist Multiplier',
                  value: uiStateRef.current.lodDistMultiplier,
                  setValue: (value) => { uiStateRef.current.lodDistMultiplier = value; },
                  min: 0,
                  max: 4,
                });
              }
              if (ImGui.CollapsingHeader('Frame Stages', defaultOpen)) {
                ImGui.TextWrapped('Debug toggles for the per-frame render path. Disabling a stage skips that pass without changing the pipeline profile selection.');
                const renderStages = uiStateRef.current.renderStages;
                const renderStageCheckbox = (key, label) => {
                  ImGui.Checkbox(
                    `${label}##frame-stage-${key}`,
                    (value = renderStages[key]) => {
                      renderStages[key] = value;
                      return value;
                    },
                  );
                };
                renderStageCheckbox('skyDome', 'Sky Dome');
                renderStageCheckbox('skyBackdrop', 'Sky Backdrop');
                renderStageCheckbox('skyClouds', 'Sky Clouds');
                renderStageCheckbox('sceneOpaque', 'Scene Opaque');
                renderStageCheckbox('waterFar', 'Water Far');
                renderStageCheckbox('waterNear', 'Water Near');
                renderStageCheckbox('waterWavy', 'Water Wavy');
                renderStageCheckbox('waterWake', 'Water Wake');
                renderStageCheckbox('sceneTransparent', 'Scene Transparent');
                renderStageCheckbox('sceneBlend', 'Scene Blend');
                renderStageCheckbox('sceneAdditive', 'Scene Additive');
                renderStageCheckbox('sceneOverlay', 'Scene Overlay');
                renderStageCheckbox('coronas', 'Coronas');
                renderStageCheckbox('postFx', 'PostFX');
                renderStageCheckbox('sunBloom', 'Sun Bloom');
                renderStageCheckbox('sunFinal', 'Sun Final');
                renderStageCheckbox('hud', 'HUD');
                ImGui.TextDisabled('Transparent fill-rate gets much worse when Disable Backface Culling is on, because transparent surfaces become double-sided.');
              }
              {
                const gameOptions = getRWPipelineGameOptions();
                const pipelineDebug = uiStateRef.current.pipelineDebug;
                const renderPipelineDebugSection = (category, label, description) => {
                  const selection = pipelineDebug[category];
                  const status = jsrwSessionRef.current.getPipelineController().describeSelection(category, {
                    activeBackend,
                    worldGameVersion: worldGameVersionRef.current,
                  });
                  const platformOptions = getRWPipelinePlatformOptions(selection.game, category);
                  if (!platformOptions.includes(selection.platform)) {
                    selection.platform = platformOptions[0] || RW_PIPELINE_PLATFORM.DEFAULT;
                  }

                  if (!ImGui.CollapsingHeader(label, defaultOpen)) return;
                  ImGui.TextWrapped(description);
                  ImGui.Checkbox(
                    `Enable##${category}`,
                    (value = selection.enabled) => {
                      selection.enabled = value;
                      return value;
                    },
                  );
                  if (ImGui.BeginCombo(`Game##${category}`, selection.game)) {
                    for (const option of gameOptions) {
                      const selected = selection.game === option;
                      if (ImGui.Selectable(option, selected)) {
                        selection.game = option;
                        const nextPlatforms = getRWPipelinePlatformOptions(option, category);
                        selection.platform = nextPlatforms[0] || RW_PIPELINE_PLATFORM.DEFAULT;
                      }
                      if (selected) ImGui.SetItemDefaultFocus();
                    }
                    ImGui.EndCombo();
                  }
                  if (ImGui.BeginCombo(`Profile##${category}`, selection.platform)) {
                    for (const option of platformOptions) {
                      const selected = selection.platform === option;
                      if (ImGui.Selectable(option, selected)) selection.platform = option;
                      if (selected) ImGui.SetItemDefaultFocus();
                    }
                    ImGui.EndCombo();
                  }
                  ImGui.Text(`Resolved Profile: ${status.profile?.label || 'None'}`);
                  ImGui.Text(`Backend Support: ${status.supported ? 'Supported' : 'Unsupported'}`);
                  if (status.warning) {
                    ImGui.TextWrapped(`Warning: ${status.warning}`);
                  }
                  if (category === RW_PIPELINE_CATEGORY.POSTFX) {
                    const timecyclePostFxValues = timecycleStateRef.current?.current?.values || null;
                    const hasLiveTimecyclePostFx = Boolean(timecyclePostFxValues?.blur);
                    const postFxDebugViewOptions = [
                      ['final', 'Final'],
                      ['scene', 'Scene'],
                      ['current-frame', 'Current Frame'],
                      ['radiosity-blur-a', 'Radiosity Blur A'],
                      ['radiosity-blur-b', 'Radiosity Blur B'],
                      ['after-radiosity', 'After Radiosity'],
                      ['blur-source', 'Blur Source'],
                      ['history', 'History'],
                      ['blur-tint', 'Blur Tint'],
                    ];
                    selection.config ||= {
                      ...RW_PIPELINE_SELECTION_DEFAULTS[RW_PIPELINE_CATEGORY.POSTFX].config,
                    };
                    if (typeof selection.config.enableColorFilter !== 'boolean') {
                      selection.config.enableColorFilter = RW_PIPELINE_SELECTION_DEFAULTS[RW_PIPELINE_CATEGORY.POSTFX].config.enableColorFilter;
                    }
                    if (typeof selection.config.enableBigBloomSunEffect !== 'boolean') {
                      selection.config.enableBigBloomSunEffect = typeof selection.config.enableSunCorona === 'boolean'
                        ? selection.config.enableSunCorona
                        : RW_PIPELINE_SELECTION_DEFAULTS[RW_PIPELINE_CATEGORY.POSTFX].config.enableBigBloomSunEffect;
                    }
                    selection.config.enableSunCorona = selection.config.enableBigBloomSunEffect;
                    ImGui.Separator();
                    renderImguiSliderRow(ImGui, {
                      id: `postfx-${category}-trails-limit`,
                      rowPrefix: 'postfx-row',
                      label: 'Radiosity Limit',
                      value: selection.config.trailsLimit,
                      setValue: (value) => { selection.config.trailsLimit = Math.round(value); },
                      min: 0,
                      max: 255,
                      format: '%.0f',
                    });
                    renderImguiSliderRow(ImGui, {
                      id: `postfx-${category}-trails-intensity`,
                      rowPrefix: 'postfx-row',
                      label: 'Radiosity Intensity',
                      value: selection.config.trailsIntensity,
                      setValue: (value) => { selection.config.trailsIntensity = Math.round(value); },
                      min: 0,
                      max: 63,
                      format: '%.0f',
                    });
                    renderImguiSliderRow(ImGui, {
                      id: `postfx-${category}-radiosity-resolution-divisor`,
                      rowPrefix: 'postfx-row',
                      label: 'Radiosity Res Div',
                      value: selection.config.radiosityResolutionDivisor ?? 4,
                      setValue: (value) => { selection.config.radiosityResolutionDivisor = value; },
                      min: 1,
                      max: 8,
                      type: 'int',
                      format: '%d',
                    });
                    renderImguiSliderRow(ImGui, {
                      id: `postfx-${category}-blur-offset`,
                      rowPrefix: 'postfx-row',
                      label: 'Blur Offset',
                      value: selection.config.blurOffset,
                      setValue: (value) => { selection.config.blurOffset = value; },
                      min: 0,
                      max: 8,
                      format: '%.2f',
                    });
                    renderImguiSliderRow(ImGui, {
                      id: `postfx-${category}-blur-intensity`,
                      rowPrefix: 'postfx-row',
                      label: 'Blur Intensity',
                      value: selection.config.blurIntensity,
                      setValue: (value) => { selection.config.blurIntensity = value; },
                      min: 0,
                      max: 1,
                      format: '%.3f',
                    });
                    renderImguiSliderRow(ImGui, {
                      id: `postfx-${category}-history-intensity`,
                      rowPrefix: 'postfx-row',
                      label: 'Trails Intensity',
                      value: selection.config.historyIntensity,
                      setValue: (value) => { selection.config.historyIntensity = value; },
                      min: 0,
                      max: 1,
                      format: '%.3f',
                    });
                    if (hasLiveTimecyclePostFx) {
                      ImGui.TextDisabled('These values follow timecyc by default. Manual edits persist until Time/Weather changes and timecyc postfx values are resynced.');
                    }
                    ImGui.Checkbox(
                      `Enable Radiosity##${category}`,
                      (value = selection.config.enableRadiosity) => {
                        selection.config.enableRadiosity = value;
                        return value;
                      },
                    );
                    ImGui.Checkbox(
                      `Enable Blur##${category}`,
                      (value = selection.config.enableBlur) => {
                        selection.config.enableBlur = value;
                        return value;
                      },
                    );
                    ImGui.Checkbox(
                      `Enable Trails##${category}`,
                      (value = (selection.config.enableTrails ?? selection.config.enableHistory ?? true)) => {
                        selection.config.enableTrails = value;
                        selection.config.enableHistory = value;
                        return value;
                      },
                    );
                    ImGui.Checkbox(
                      `Enable Color Filter##${category}`,
                      (value = selection.config.enableColorFilter) => {
                        selection.config.enableColorFilter = value;
                        return value;
                      },
                    );
                    ImGui.Checkbox(
                      `Enable Big Bloom Sun Effect##${category}`,
                      (value = selection.config.enableBigBloomSunEffect) => {
                        selection.config.enableBigBloomSunEffect = value;
                        selection.config.enableSunCorona = value;
                        return value;
                      },
                    );
                    const sunRuntimeDebug = sunRuntimeDebugRef.current;
                    ImGui.TextDisabled(
                      `Sun runtime: bigSunBloom=${sunRuntimeDebug.bigSunBloom ? 1 : 0} enabled=${sunRuntimeDebug.enableBigBloom ? 1 : 0} eligible=${sunRuntimeDebug.bloomEligible ? 1 : 0} onScreen=${sunRuntimeDebug.sunOnScreen ? 1 : 0}`,
                    );
                    ImGui.TextDisabled(
                      `fade=${sunRuntimeDebug.bigBloomFadeAlpha.toFixed(3)} scale=${sunRuntimeDebug.bigBloomScale.toFixed(3)} corona=${sunRuntimeDebug.coronaFadeAlpha.toFixed(3)} lights=${sunRuntimeDebug.sunLightsMult.toFixed(3)}`,
                    );
                    ImGui.TextDisabled(
                      `center=${sunRuntimeDebug.centerBloomFactor.toFixed(3)} screen=${sunRuntimeDebug.screenCenterBloomFactor.toFixed(3)} facing=${sunRuntimeDebug.facingBloomFactor.toFixed(3)} align=${sunRuntimeDebug.viewAlignment.toFixed(3)}`,
                    );
                    ImGui.TextDisabled(
                      `bright=${sunRuntimeDebug.brightnessBloomFactor.toFixed(3)} brightScale=${sunRuntimeDebug.bloomBrightnessScale.toFixed(3)}`,
                    );
                    ImGui.TextDisabled(`Sun mode: ${sunRuntimeDebug.bigSunBloom ? 'big-bloom' : 'normal-corona'}`);
                    selection.config.debugView ||= 'final';
                    ImGui.Text('Debug View');
                    ImGui.SameLine();
                    ImGui.SetNextItemWidth(190);
                    if (ImGui.BeginCombo(`##postfx-debug-view-${category}`, postFxDebugViewOptions.find(([value]) => value === selection.config.debugView)?.[1] || 'Final')) {
                      for (const [value, label] of postFxDebugViewOptions) {
                        const selected = selection.config.debugView === value;
                        if (ImGui.Selectable(label, selected)) selection.config.debugView = value;
                        if (selected) ImGui.SetItemDefaultFocus();
                      }
                      ImGui.EndCombo();
                    }
                    const postFxEffect = jsrwSessionRef.current.getActiveEffect(RW_PIPELINE_CATEGORY.POSTFX) || null;
                    const postFxDebugPreviews = postFxEffect?.getDebugPreviewTextures?.() || [];
                    if (postFxDebugPreviews.length > 0) {
                      ImGui.Separator();
                      ImGui.Text('Stage Previews');
                      ImGui.TextDisabled('VCSPC order: Current Frame -> After Radiosity -> After BlurOverlay');
                      const previewWidth = Math.max(120, Math.min(220, (ImGui.GetContentRegionAvail().x - 16) / 3));
                      for (let i = 0; i < postFxDebugPreviews.length; i += 1) {
                        const preview = postFxDebugPreviews[i];
                        ImGui.BeginGroup();
                        ImGui.Text(preview.label);
                        const texId = getImguiTextureForImage(preview.texture);
                        const aspect = preview.width > 0 && preview.height > 0 ? (preview.width / preview.height) : 1;
                        const previewHeight = previewWidth / Math.max(0.5, aspect);
                        if (texId) {
                          ImGui.Image(texId, new Vec2(previewWidth, previewHeight));
                        } else {
                          ImGui.Dummy(new Vec2(previewWidth, previewHeight));
                        }
                        ImGui.Text(`${preview.width} x ${preview.height}`);
                        ImGui.EndGroup();
                        if (i !== postFxDebugPreviews.length - 1) ImGui.SameLine();
                      }
                    }
                  }
                };

                renderPipelineDebugSection(
                  RW_PIPELINE_CATEGORY.BUILDING,
                  'Building Pipeline',
                  'Hot-switch profile-backed RW building materials without rebuilding the world. V1 implements Leeds VCS PS2/PSP on WebGL.',
                );
                renderPipelineDebugSection(
                  RW_PIPELINE_CATEGORY.POSTFX,
                  'PostFX Pipeline',
                  'Fullscreen postfx profile switching. VCS now follows the VCSPC Render() order: Radiosity -> BlurOverlay(history) -> Present.',
                );
              }
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('SUN')) {
              const sunSettings = uiStateRef.current.sun;
              ImGui.Checkbox(
                'Enable RW Sun',
                (value = sunSettings.enabled) => {
                  sunSettings.enabled = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'World Occlusion',
                (value = sunSettings.useWorldOcclusion) => {
                  sunSettings.useWorldOcclusion = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Cloud Occlusion',
                (value = sunSettings.useCloudOcclusion) => {
                  sunSettings.useCloudOcclusion = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Bypass Fade',
                (value = sunSettings.debugBypassFade) => {
                  sunSettings.debugBypassFade = value;
                  return value;
                },
              );
              renderImguiSliderRow(ImGui, { id: 'distance', rowPrefix: 'sun-row', label: 'Sun Distance', value: sunSettings.distance, setValue: (value) => { sunSettings.distance = value; }, min: 50, max: 1000, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'core-size-scale', rowPrefix: 'sun-row', label: 'Core Size Scale', value: sunSettings.coreSizeScale, setValue: (value) => { sunSettings.coreSizeScale = value; }, min: 0, max: 4 });
              renderImguiSliderRow(ImGui, { id: 'core-size-bias', rowPrefix: 'sun-row', label: 'Core Size Bias', value: sunSettings.coreSizeBias, setValue: (value) => { sunSettings.coreSizeBias = value; }, min: 0, max: 32 });
              renderImguiSliderRow(ImGui, { id: 'core-jitter', rowPrefix: 'sun-row', label: 'Core Jitter', value: sunSettings.coreJitterAmplitude, setValue: (value) => { sunSettings.coreJitterAmplitude = value; }, min: 0, max: 8 });
              renderImguiSliderRow(ImGui, { id: 'corona-size-scale', rowPrefix: 'sun-row', label: 'Corona Size Scale', value: sunSettings.coronaSizeScale, setValue: (value) => { sunSettings.coronaSizeScale = value; }, min: 0, max: 64 });
              renderImguiSliderRow(ImGui, { id: 'flare-scale', rowPrefix: 'sun-row', label: 'Flare Scale', value: sunSettings.flareScale, setValue: (value) => { sunSettings.flareScale = value; }, min: 0, max: 4 });
              renderImguiSliderRow(ImGui, { id: 'flare-offset-scale', rowPrefix: 'sun-row', label: 'Flare Offset Scale', value: sunSettings.flareOffsetScale, setValue: (value) => { sunSettings.flareOffsetScale = value; }, min: 0, max: 4 });
              renderImguiSliderRow(ImGui, { id: 'flare-alpha-scale', rowPrefix: 'sun-row', label: 'Flare Alpha Scale', value: sunSettings.flareAlphaScale, setValue: (value) => { sunSettings.flareAlphaScale = value; }, min: 0, max: 4 });
              renderImguiSliderRow(ImGui, { id: 'core-alpha', rowPrefix: 'sun-row', label: 'Core Alpha', value: sunSettings.coreAlpha, setValue: (value) => { sunSettings.coreAlpha = value; }, min: 0, max: 2 });
              renderImguiSliderRow(ImGui, { id: 'corona-alpha', rowPrefix: 'sun-row', label: 'Corona Alpha', value: sunSettings.coronaAlpha, setValue: (value) => { sunSettings.coronaAlpha = value; }, min: 0, max: 2 });
              renderImguiSliderRow(ImGui, { id: 'fade-speed', rowPrefix: 'sun-row', label: 'Fade Speed', value: sunSettings.fadeSpeed, setValue: (value) => { sunSettings.fadeSpeed = value; }, min: 0, max: 8 });
              renderImguiSliderRow(ImGui, { id: 'cloud-highlight-radius', rowPrefix: 'sun-row', label: 'Cloud Highlight Radius', value: sunSettings.cloudHighlightRadius, setValue: (value) => { sunSettings.cloudHighlightRadius = value; }, min: 0.01, max: 1 });
              renderImguiSliderRow(ImGui, { id: 'cloud-highlight-strength', rowPrefix: 'sun-row', label: 'Cloud Highlight Strength', value: sunSettings.cloudHighlightStrength, setValue: (value) => { sunSettings.cloudHighlightStrength = value; }, min: 0, max: 2 });
              renderImguiSliderRow(ImGui, { id: 'cloud-block-radius', rowPrefix: 'sun-row', label: 'Cloud Block Radius', value: sunSettings.cloudBlockRadius, setValue: (value) => { sunSettings.cloudBlockRadius = value; }, min: 0.01, max: 0.5 });
              ImGui.TextWrapped('RW mapping: core/corona sizes come from timecycle sun size, flares follow RW corona positions, and cloud blocking fades the corona path instead of using postprocess god rays.');
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('MOON')) {
              const moonSettings = uiStateRef.current.moon;
              ImGui.Checkbox(
                'Enable RW Moon',
                (value = moonSettings.enabled) => {
                  moonSettings.enabled = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Small Moon',
                (value = moonSettings.smallMoon) => {
                  moonSettings.smallMoon = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Coverage Dimming',
                (value = moonSettings.coverageDimming) => {
                  moonSettings.coverageDimming = value;
                  return value;
                },
              );
              renderImguiSliderRow(ImGui, { id: 'offset-x', rowPrefix: 'moon-row', label: 'Offset X', value: moonSettings.offsetX, setValue: (value) => { moonSettings.offsetX = value; }, min: -300, max: 300, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'offset-y', rowPrefix: 'moon-row', label: 'Offset Y', value: moonSettings.offsetY, setValue: (value) => { moonSettings.offsetY = value; }, min: -300, max: 300, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'offset-z', rowPrefix: 'moon-row', label: 'Offset Z', value: moonSettings.offsetZ, setValue: (value) => { moonSettings.offsetZ = value; }, min: -100, max: 100, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'moon-size-index', rowPrefix: 'moon-row', label: 'Moon Size Index', value: moonSettings.moonSizeIndex, setValue: (value) => { moonSettings.moonSizeIndex = value; }, min: 0, max: 7, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'base-scale', rowPrefix: 'moon-row', label: 'Base Scale', value: moonSettings.baseScale, setValue: (value) => { moonSettings.baseScale = value; }, min: 0, max: 32 });
              renderImguiSliderRow(ImGui, { id: 'small-scale', rowPrefix: 'moon-row', label: 'Small Moon Scale', value: moonSettings.smallMoonScale, setValue: (value) => { moonSettings.smallMoonScale = value; }, min: 0, max: 16 });
              renderImguiSliderRow(ImGui, { id: 'brightness-scale', rowPrefix: 'moon-row', label: 'Brightness Scale', value: moonSettings.brightnessScale, setValue: (value) => { moonSettings.brightnessScale = value; }, min: 0, max: 4 });
              renderImguiSliderRow(ImGui, { id: 'fade-center', rowPrefix: 'moon-row', label: 'Fade Center Minutes', value: moonSettings.fadeCenterMinutes, setValue: (value) => { moonSettings.fadeCenterMinutes = value; }, min: 0, max: 1440, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'fade-window', rowPrefix: 'moon-row', label: 'Fade Window Minutes', value: moonSettings.fadeWindowMinutes, setValue: (value) => { moonSettings.fadeWindowMinutes = value; }, min: 1, max: 720, format: '%.0f' });
              ImGui.TextWrapped('RW mapping: moon is rendered in the clouds pass with particle/coronamoon, a fixed world-space offset from the camera, weather coverage dimming, and the original 3AM-centered fade window.');
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('STARS')) {
              const starsSettings = uiStateRef.current.stars;
              ImGui.Checkbox(
                'Enable RW Stars',
                (value = starsSettings.enabled) => {
                  starsSettings.enabled = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Coverage Dimming',
                (value = starsSettings.coverageDimming) => {
                  starsSettings.coverageDimming = value;
                  return value;
                },
              );
              renderImguiSliderRow(ImGui, { id: 'brightness-scale', rowPrefix: 'stars-row', label: 'Brightness Scale', value: starsSettings.brightnessScale, setValue: (value) => { starsSettings.brightnessScale = value; }, min: 0, max: 4 });
              renderImguiSliderRow(ImGui, { id: 'logo-offset-x', rowPrefix: 'stars-row', label: 'Logo Offset X', value: starsSettings.logoOffsetX, setValue: (value) => { starsSettings.logoOffsetX = value; }, min: -300, max: 300, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'logo-offset-y', rowPrefix: 'stars-row', label: 'Logo Offset Y', value: starsSettings.logoOffsetY, setValue: (value) => { starsSettings.logoOffsetY = value; }, min: -300, max: 300, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'logo-offset-z', rowPrefix: 'stars-row', label: 'Logo Offset Z', value: starsSettings.logoOffsetZ, setValue: (value) => { starsSettings.logoOffsetZ = value; }, min: -100, max: 100, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'logo-span-y', rowPrefix: 'stars-row', label: 'Logo Span Y', value: starsSettings.logoSpanY, setValue: (value) => { starsSettings.logoSpanY = value; }, min: 0, max: 180, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'logo-span-z', rowPrefix: 'stars-row', label: 'Logo Span Z', value: starsSettings.logoSpanZ, setValue: (value) => { starsSettings.logoSpanZ = value; }, min: 0, max: 180, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'star-scale', rowPrefix: 'stars-row', label: 'Star Scale', value: starsSettings.starScale, setValue: (value) => { starsSettings.starScale = value; }, min: 0, max: 4 });
              renderImguiSliderRow(ImGui, { id: 'sparkle-offset-y', rowPrefix: 'stars-row', label: 'Sparkle Offset Y', value: starsSettings.sparkleOffsetY, setValue: (value) => { starsSettings.sparkleOffsetY = value; }, min: -180, max: 180, format: '%.0f' });
              renderImguiSliderRow(ImGui, { id: 'sparkle-scale', rowPrefix: 'stars-row', label: 'Sparkle Scale', value: starsSettings.sparkleScale, setValue: (value) => { starsSettings.sparkleScale = value; }, min: 0, max: 16 });
              renderImguiSliderRow(ImGui, { id: 'sparkle-min', rowPrefix: 'stars-row', label: 'Sparkle Min Flicker', value: starsSettings.sparkleMinFlicker, setValue: (value) => { starsSettings.sparkleMinFlicker = value; }, min: 0, max: 1 });
              renderImguiSliderRow(ImGui, { id: 'sparkle-range', rowPrefix: 'stars-row', label: 'Sparkle Flicker Range', value: starsSettings.sparkleFlickerRange, setValue: (value) => { starsSettings.sparkleFlickerRange = value; }, min: 0, max: 1 });
              ImGui.TextWrapped('RW mapping: stars are the fixed Rockstar-logo sprite pattern from Clouds.cpp plus the flickering star, using particle/coronastar and the original night visibility curve with weather coverage dimming.');
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('2DFX')) {
              const twoDfxSettings = uiStateRef.current.twoDfx;
              ImGui.TextWrapped('2DFX coronas are billboard sprites sourced from particle.txd-style textures, with optional debug helpers and forced daytime rendering.');
              ImGui.Checkbox(
                'Render 2DFX',
                (value = uiStateRef.current.render2dfx) => {
                  uiStateRef.current.render2dfx = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Debug 2DFX',
                (value = uiStateRef.current.debug2dfx) => {
                  uiStateRef.current.debug2dfx = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Force Render 2DFX',
                (value = uiStateRef.current.forceRender2dfx) => {
                  uiStateRef.current.forceRender2dfx = value;
                  return value;
                },
              );
              renderImguiSliderRow(ImGui, {
                id: '2dfx-max-active-coronas',
                rowPrefix: '2dfx-row',
                label: 'Max Active Coronas',
                value: twoDfxSettings.maxActiveCoronas,
                setValue: (value) => { twoDfxSettings.maxActiveCoronas = Math.round(value); },
                min: 0,
                max: 512,
                format: '%.0f',
              });
              ImGui.Text(`IDE 2DFX defs: ${statsRef.current.ideEffects}`);
              ImGui.Text(`Active emitters: ${statsRef.current.lightEmitters}`);
              ImGui.Text(`Objects with lights: ${statsRef.current.lightObjects}`);
              ImGui.TextDisabled('Force Render 2DFX bypasses the original night/flicker schedule for 2DFX emitters only.');
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('Traffic Light')) {
              const trafficSettings = uiStateRef.current.trafficLights;
              ImGui.TextWrapped('Traffic light coronas follow revc-style model-specific lamp selection, phase switching, and camera-facing side selection.');
              ImGui.Checkbox(
                'Render Traffic Lights',
                (value = trafficSettings.enabled) => {
                  trafficSettings.enabled = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Debug 2DFX Helpers',
                (value = uiStateRef.current.debug2dfx) => {
                  uiStateRef.current.debug2dfx = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Ignore Facing',
                (value = trafficSettings.ignoreFacing) => {
                  trafficSettings.ignoreFacing = value;
                  return value;
                },
              );
              const phaseOptions = ['auto', 'red', 'yellow', 'green'];
              if (ImGui.BeginCombo('Force Phase', String(trafficSettings.forcePhase || 'auto'))) {
                for (const option of phaseOptions) {
                  const selected = trafficSettings.forcePhase === option;
                  if (ImGui.Selectable(option, selected)) {
                    trafficSettings.forcePhase = option;
                  }
                  if (selected) ImGui.SetItemDefaultFocus();
                }
                ImGui.EndCombo();
              }
              ImGui.Checkbox(
                'Wind Blinking',
                (value = trafficSettings.windBlinking) => {
                  trafficSettings.windBlinking = value;
                  return value;
                },
              );
              renderImguiSliderRow(ImGui, {
                id: 'traffic-wind-strength',
                rowPrefix: 'traffic-light-row',
                label: 'Wind Strength',
                value: trafficSettings.windStrength,
                setValue: (value) => { trafficSettings.windStrength = value; },
                min: 0,
                max: 2,
              });
              renderImguiSliderRow(ImGui, {
                id: 'traffic-brightness-scale',
                rowPrefix: 'traffic-light-row',
                label: 'Brightness Scale',
                value: trafficSettings.brightnessScale,
                setValue: (value) => { trafficSettings.brightnessScale = value; },
                min: 0,
                max: 2,
              });
              renderImguiSliderRow(ImGui, {
                id: 'traffic-size-scale',
                rowPrefix: 'traffic-light-row',
                label: 'Size Scale',
                value: trafficSettings.sizeScale,
                setValue: (value) => { trafficSettings.sizeScale = value; },
                min: 0.1,
                max: 3,
              });
              ImGui.Text('Cars1 visual: green 5000ms, yellow 1000ms, else red');
              ImGui.Text('Cars2 visual: red 6000ms, green 5000ms, yellow 1000ms, else red');
              ImGui.Text(`Total light emitters: ${statsRef.current.lightEmitters}`);
              ImGui.TextDisabled('Ignore Facing shows both sides. Force Phase overrides the revc Cars1/Cars2 visual schedule.');
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('Shadow')) {
              const shadowSettings = uiStateRef.current.shadows;
              const shadowStats = jsrwSessionRef.current.getShadowRuntime()?.raw?.debugStats || {};
              ImGui.TextWrapped('RW shadows are handled by a dedicated shadow runtime, separate from coronas, and project additive shadow geometry onto scene collision.');
              ImGui.Checkbox(
                'Render Shadows',
                (value = shadowSettings.enabled) => {
                  shadowSettings.enabled = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Wireframe Shadows',
                (value = shadowSettings.wireframe) => {
                  shadowSettings.wireframe = value;
                  return value;
                },
              );
              ImGui.Checkbox(
                'Rebuild Every Frame',
                (value = shadowSettings.rebuildEveryFrame) => {
                  shadowSettings.rebuildEveryFrame = value;
                  return value;
                },
              );
              renderImguiSliderRow(ImGui, {
                id: 'shadow-intensity-scale',
                rowPrefix: 'shadow-row',
                label: 'Intensity Scale',
                value: shadowSettings.intensityScale,
                setValue: (value) => { shadowSettings.intensityScale = value; },
                min: 0,
                max: 4,
              });
              renderImguiSliderRow(ImGui, {
                id: 'shadow-size-scale',
                rowPrefix: 'shadow-row',
                label: 'Size Scale',
                value: shadowSettings.sizeScale,
                setValue: (value) => { shadowSettings.sizeScale = value; },
                min: 0.1,
                max: 4,
              });
              renderImguiSliderRow(ImGui, {
                id: 'shadow-z-distance-scale',
                rowPrefix: 'shadow-row',
                label: 'Z Distance Scale',
                value: shadowSettings.zDistanceScale,
                setValue: (value) => { shadowSettings.zDistanceScale = value; },
                min: 0.1,
                max: 4,
              });
              renderImguiSliderRow(ImGui, {
                id: 'shadow-draw-distance-scale',
                rowPrefix: 'shadow-row',
                label: 'Draw Distance Scale',
                value: shadowSettings.drawDistanceScale,
                setValue: (value) => { shadowSettings.drawDistanceScale = value; },
                min: 0.1,
                max: 4,
              });
              renderImguiSliderRow(ImGui, {
                id: 'shadow-height-bias',
                rowPrefix: 'shadow-row',
                label: 'Height Bias',
                value: shadowSettings.heightBias,
                setValue: (value) => { shadowSettings.heightBias = value; },
                min: 0,
                max: 0.25,
              });
              renderImguiSliderRow(ImGui, {
                id: 'shadow-max-active-shadows',
                rowPrefix: 'shadow-row',
                label: 'Max Active Shadows',
                value: shadowSettings.maxActiveShadows,
                setValue: (value) => { shadowSettings.maxActiveShadows = Math.round(value); },
                min: 0,
                max: 256,
                format: '%.0f',
              });
              ImGui.Text(`Shadow entries: ${shadowStats.entryCount || 0}`);
              ImGui.Text(`Projected: ${shadowStats.projectedCount || 0}`);
              ImGui.Text(`Visible: ${shadowStats.visibleCount || 0}`);
              ImGui.Text(`Rebuilt this frame: ${shadowStats.rebuiltCount || 0}`);
              ImGui.Text(`Missing texture: ${shadowStats.missingTextureCount || 0}`);
              ImGui.Text(`Zero intensity: ${shadowStats.zeroIntensityCount || 0}`);
              ImGui.Text(`Out of range: ${shadowStats.outOfRangeCount || 0}`);
              ImGui.Text(`Rebuild failed: ${shadowStats.rebuildFailedCount || 0}`);
              ImGui.Text(`Fallback corners: ${shadowStats.fallbackCornerCount || 0}`);
              ImGui.TextDisabled('Rebuild Every Frame is expensive and is intended only for shadow debugging.');
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('Backend')) {
              ImGui.Text(`WebGPU: ${WebGPU.isAvailable() ? 'available' : 'unavailable'}`);
              const backendOptions = ['WebGL', 'WebGPU'];
              if (ImGui.BeginCombo('Graphics Backend', uiStateRef.current.backendSelection)) {
                for (const option of backendOptions) {
                  const selected = uiStateRef.current.backendSelection === option;
                  const disableOption = option === 'WebGPU' && !WebGPU.isAvailable();
                  if (disableOption) ImGui.BeginDisabled();
                  if (ImGui.Selectable(option, selected)) {
                    uiStateRef.current.backendSelection = option;
                  }
                  if (disableOption) ImGui.EndDisabled();
                  if (selected) ImGui.SetItemDefaultFocus();
                }
                ImGui.EndCombo();
              }
              ImGui.Text(`Active: ${activeBackend}`);
              const backendChanged = uiStateRef.current.backendSelection !== activeBackend;
              if (!backendChanged) ImGui.BeginDisabled();
              if (ImGui.Button('Apply Backend')) {
                pushConsoleLine('info', `Switch backend: ${activeBackend} -> ${uiStateRef.current.backendSelection}`);
                setStatus(`Switching backend to ${uiStateRef.current.backendSelection}...`);
                backendSwitchingRef.current = true;
                setActiveBackend(uiStateRef.current.backendSelection);
                setShowGameIcon(false);
              }
              if (!backendChanged) ImGui.EndDisabled();
              ImGui.TextWrapped('Switching backend recreates renderer. Rebuild map afterwards.');
              ImGui.EndTabItem();
            }
            ImGui.EndTabBar();
          }
          ImGui.End();
        }

        if (isWindowOpen('about')) {
          ImGui.SetNextWindowPos(new Vec2(80, 70), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(320, 0), ImGui.Cond.Once);
          ImGui.Begin(
            'About',
            (value = isWindowOpen('about')) => setWindowOpen('about', value),
            ImGui.WindowFlags.AlwaysAutoResize,
          );
          ImGui.Text('GTA Map Renderer');
          ImGui.Separator();
          ImGui.Text('Author: Nurupo');
          ImGui.End();
        }

          ImGui.EndFrame();
          ImGui.Render();
          ImGui_Impl.RenderDrawData(ImGui.GetDrawData());
          if (renderer.state && typeof renderer.state.reset === 'function') {
            renderer.state.reset();
          }
        } catch (error) {
          console.error('ImGui runtime error:', error);
          pushConsoleLine('error', `ImGui runtime error: ${formatConsoleArg(error)}`);
          imguiRef.current = { ImGui: null, ImGui_Impl: null, ready: false };
          imguiCaptureRef.current = { mouse: false, keyboard: false };
        }
      }

      rafId = window.requestAnimationFrame(animate);
    };

    const worldRoot = worldRootRef.current;

    const initImGui = async () => {
      if (imguiRef.current.ready) {
        backendSwitchingRef.current = false;
        return;
      }
      try {
        const imguiModule = await import('imgui-js');
        const implModule = await import('imgui-js/dist/imgui_impl.umd.js');

        const imguiCandidates = [
          imguiModule,
          imguiModule?.default,
          imguiModule?.default?.default,
        ];
        const ImGui = imguiCandidates.find(
          (candidate) =>
            candidate &&
            typeof candidate.CreateContext === 'function' &&
            typeof candidate.NewFrame === 'function',
        );
        if (!ImGui) {
          throw new Error('Could not resolve ImGui API namespace');
        }

        const initCandidates = [
          imguiModule?.default,
          ImGui?.default,
          imguiModule,
        ];
        const initImGuiRuntime = initCandidates.find((candidate) => typeof candidate === 'function');
        if (typeof initImGuiRuntime !== 'function') {
          throw new Error('Could not resolve ImGui runtime init function');
        }
        await initImGuiRuntime();

        const implCandidates = [
          implModule,
          implModule?.default,
          implModule?.default?.default,
        ];
        const ImGui_Impl = implCandidates.find(
          (candidate) =>
            candidate &&
            typeof candidate.Init === 'function' &&
            typeof candidate.NewFrame === 'function' &&
            typeof candidate.RenderDrawData === 'function',
        );
        if (!ImGui_Impl) {
          throw new Error('Could not resolve ImGui implementation backend');
        }

        if (!mounted) return;

        const checkVersion = ImGui.CHECKVERSION ?? ImGui.IMGUI_CHECKVERSION;
        if (typeof checkVersion === 'function') {
          checkVersion();
        }
        ImGui.CreateContext();
        ImGui.StyleColorsDark();
        const imguiGlContext = imguiCanvas.getContext('webgl2', {
          alpha: true,
          antialias: true,
          premultipliedAlpha: true,
        }) || imguiCanvas.getContext('webgl', {
          alpha: true,
          antialias: true,
          premultipliedAlpha: true,
        });
        if (!imguiGlContext) {
          throw new Error('Failed to create ImGui WebGL context');
        }
        imguiGlRef.current = imguiGlContext;
        ImGui_Impl.Init(imguiGlContext);

        imguiRef.current = { ImGui, ImGui_Impl, ready: true };
        backendSwitchingRef.current = false;
      } catch (error) {
        console.error('imgui-js init error:', error);
        setStatus(`imgui-js failed to initialize: ${error?.message ?? 'unknown error'}`);
      }
    };

    initImGui();
    rafId = window.requestAnimationFrame(animate);

    return () => {
      mounted = false;
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      resizeObserver?.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('contextmenu', onContextMenu);

      const { ImGui, ImGui_Impl, ready } = imguiRef.current;
      if (appUnmountingRef.current && ready && ImGui && ImGui_Impl) {
        try {
          resetImguiTextureCache();
          if (typeof ImGui_Impl.Shutdown === 'function') ImGui_Impl.Shutdown();
          if (typeof ImGui.DestroyContext === 'function') ImGui.DestroyContext();
        } catch {
          // Ignore context teardown errors during app shutdown.
        }
        imguiRef.current = { ImGui: null, ImGui_Impl: null, ready: false };
        imguiCaptureRef.current = { mouse: false, keyboard: false };
      }
      backendSwitchingRef.current = true;
      playerModeManager.destroy();
      orbitControls.dispose();

      rendererHost.dispose();
      rendererHostRef.current = null;
      Object.values(iconTextures).forEach((texture) => texture.dispose());
      iconMaterial.dispose();
      for (const sprite of lowCloudSpritesRef.current) {
        sprite.material.map?.dispose?.();
        sprite.material.dispose?.();
      }
      for (const sprite of fluffyCloudSpritesRef.current) {
        sprite.material.dispose?.();
      }
      for (const sprite of fluffyHighlightSpritesRef.current) {
        sprite.material.dispose?.();
      }
      fluffyCloudTextureRef.current?.dispose?.();
      fluffyHighlightTextureRef.current?.dispose?.();
      skyFeatureRef.current?.dispose();
      skyFeatureRef.current = null;
      skyQuad.geometry.dispose();
      skyMaterial.dispose();
      imguiGlRef.current = null;
      jsrwSession.dispose();
      disposeWorld(worldRoot);
    };
  }, [
    activeBackend,
    clearWorld,
    isWindowOpen,
    loadDefaultMap,
    openMapPicker,
    openZipPicker,
    pushConsoleLine,
    rebuildWorld,
    resetImguiTextureCache,
    setWindowOpen,
  ]);

  const fileSummary = useMemo(() => `Indexed files: ${stats.files}`, [stats.files]);

  return (
    <div className="app-root" ref={containerRef}>
      <canvas key={`renderer-${activeBackend}`} ref={canvasRef} className="viewport" />
      <canvas ref={imguiCanvasRef} className="imgui-overlay" />

      <div className="hud">
        <label className="picker">
          <span>Pick extracted GTA folder</span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            webkitdirectory=""
            directory=""
            onChange={onPickFolder}
          />
        </label>
        <label className="picker">
          <span>Pick map zip</span>
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            onChange={onPickZip}
          />
        </label>
        {showMapPickerFallback ? (
          <button type="button" onClick={() => openMapPicker('dom')}>Open map picker</button>
        ) : null}

        <button type="button" onClick={rebuildWorld}>Build World</button>
        <button type="button" onClick={clearWorld}>Clear</button>
        <p>{fileSummary}</p>
        <p>{status}</p>
      </div>
    </div>
  );
}

export default App;
