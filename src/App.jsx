import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { playerController as createExternalPlayerController } from 'three-player-controller';
import { formatConsoleArg } from './lib/console';
import { buildFileIndex } from './lib/fileIndex';
import {
  DISTANCE_FADE_DEFAULTS,
  resolveRenderableDistance,
} from './lib/renderDistanceFade';
import {
  addCoronaCandidate,
  addShadowCandidate,
  addVisibleChunk,
  addVisibleItem,
  addVisibleQueueMesh,
  createFrameVisibilityResult,
  resetFrameVisibilityResult,
} from './lib/frameVisibility';
import RenderEntityController from './lib/jsrw/renderer/common/RenderEntityController.js';
import { WORLD_UP, gtaPlacementQuaternionToThree, gtaPositionToThree } from './lib/gtaTransforms';
import { IDE_LIGHT_FLAG, IDE_LIGHT_TYPE, normalizePath } from './lib/gta/loaders/SectionLoader';
import { sampleTimecyc, TIMECYCLE_FIELD_GROUPS, VCS_WEATHER_NAMES } from './lib/Timecycle';
import { buildLodMapping, isLodModel } from './lib/lod';
import { PlayerControllerAdapter } from './lib/playerControllerAdapter';
import { APP_MODE_EDITOR, APP_MODE_TEST, PlayerModeManager } from './lib/PlayerModeManager';
import {
  applyDisableVertexColor,
  applyRwIdeFlagsToInstance,
  calcScreenCoorsLikeRw,
  cloneRWMaterialDescriptor,
  cloneRWPipelineSelections,
  buildTrafficLightCoronaEmitters,
  createJsrwRenderer,
  createRWPipelineMaterialForProfile,
  createThreeMaterialFromRW,
  decodeRwIdeFlags,
  getRWMaterialDescriptor,
  getRWPipelineGameOptions,
  getRWPipelinePlatformOptions,
  prepareTobjInstanceMaterials,
  resolveRWPipelineSelection,
  RW_MOON_DEBUG_DEFAULTS,
  RW_PIPELINE_CATEGORY,
  RW_PIPELINE_PLATFORM,
  RW_PIPELINE_SELECTION_DEFAULTS,
  RW_STARS_DEBUG_DEFAULTS,
  RW_SUN_DEBUG_DEFAULTS,
  SkyRendererBundle,
  toRWMaterial,
  tuneTransparentMaterial,
} from './lib/jsrw';
import {
  applyGlobalBackfaceCulling,
  applyWireframe,
  disposeWorld,
  getChunkCenterFromKey,
  getChunkKeyFromPosition,
  makeAssetKey,
  WORLD_CHUNK_SIZE,
} from './lib/worldUtils';
import { WINDOW_DEFS } from './ui/windows';
import {
  applyObjectSelectionHighlight,
  clearObjectSelectionHighlight,
  getSelectableRootFromObject,
} from './lib/selection';
import { BrowserFileSystem } from './lib/gta/fs/BrowserFileSystem';
import { WorldLoader } from './lib/gta/world/WorldLoader';
import saIcon from './assets/sa.png';
import vcsIcon from './assets/vcs.png';
import skyVertexShader from './shaders/sky.vertex.glsl.js';
import skyFragmentShader from './shaders/sky.fragment.glsl.js';
import './App.css';

const MAX_CONSOLE_LINES = 500;
const MAX_FAILED_MODELS = 5000;
const DEFAULT_SCENE_BACKGROUND = new THREE.Color(0x8ea9b5);
const CHUNK_ACTIVE_MARGIN = 384;
const CHUNK_SPHERE_PADDING = WORLD_CHUNK_SIZE * 0.75;
const CHUNK_CULL_MARGIN_XZ = WORLD_CHUNK_SIZE * 1.0;
const CHUNK_CULL_MARGIN_Y = WORLD_CHUNK_SIZE * 1.5;
const ENABLE_WORLD_INSTANCING = true;
const STREAMING_BUILD_PLACEMENT_BUDGET = 8;
const STREAMING_BUILD_FRAME_BUDGET_MS = 8;
const RW_DISTANCE_FADE_WINDOW = DISTANCE_FADE_DEFAULTS.window;
const RW_STREAM_ALPHA_PER_SECOND = DISTANCE_FADE_DEFAULTS.streamAlphaPerSecond;
const RW_FADE_EPSILON = DISTANCE_FADE_DEFAULTS.epsilon;
const HIDDEN_INSTANCE_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
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

function createResourceCacheState() {
  return {
    rawAssetCache: new Map(),
    parsedTxdCache: new Map(),
    modelTemplateCache: new Map(),
    missingDff: new Set(),
    missingTxd: new Set(),
  };
}

function toPlainVector(vector) {
  return {
    x: Number(vector?.x) || 0,
    y: Number(vector?.y) || 0,
    z: Number(vector?.z) || 0,
  };
}

function map2dfxVisibilityMode(lightType) {
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

function mapDffLightKind(lightType) {
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

function collectQueueMeshes(root) {
  if (!root?.traverse) return [];
  const meshes = [];
  root.traverse((node) => {
    if (!node?.isMesh) return;
    meshes.push(node);
  });
  root.userData = {
    ...(root.userData || {}),
    rwQueueMeshes: meshes,
  };
  return meshes;
}

function getCachedQueueMeshes(root) {
  if (!root?.traverse) return [];
  if (Array.isArray(root.userData?.rwQueueMeshes)) return root.userData.rwQueueMeshes;
  return collectQueueMeshes(root);
}

function getTextureSizeFromSource(textureSource) {
  const image = textureSource?.image ?? textureSource;
  return {
    width: Number(image?.videoWidth ?? image?.width ?? 0),
    height: Number(image?.videoHeight ?? image?.height ?? 0),
  };
}

function describeTextureSourceForLog(name, textureSource, entry = null) {
  if (!textureSource?.isTexture) return `${name}: invalid texture`;
  const { width, height } = getTextureSizeFromSource(textureSource);
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
  const d3dFormat = Number(entry?.d3dFormat ?? textureSource?.userData?.rwD3dFormat ?? 0);
  const rasterFormat = Number(entry?.rasterFormat ?? textureSource?.userData?.rwRasterFormat ?? 0);
  const image = textureSource.image;
  const data = image?.data;
  if (!data || !ArrayBuffer.isView(data) || data.length === 0) {
    return `${name}: ${width}x${height} comp=${compressionMethod} pix=${pixelFormat} d3d=${d3dFormat} raster=${rasterFormat} data=unavailable`;
  }

  let rgbTotal = 0;
  let alphaTotal = 0;
  let nonZeroAlphaCount = 0;
  const pixelCount = Math.max(1, Math.floor(data.length / 4));
  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4;
    rgbTotal += data[offset + 0] + data[offset + 1] + data[offset + 2];
    alphaTotal += data[offset + 3];
    if (data[offset + 3] > 0) nonZeroAlphaCount += 1;
  }
  const avgRgb = (rgbTotal / (pixelCount * 3)).toFixed(1);
  const avgAlpha = (alphaTotal / pixelCount).toFixed(1);
  const alphaCoverage = ((nonZeroAlphaCount / pixelCount) * 100).toFixed(1);
  const sample = Array.from(data.slice(0, Math.min(16, data.length))).join(',');
  return `${name}: ${width}x${height} comp=${compressionMethod} pix=${pixelFormat} d3d=${d3dFormat} raster=${rasterFormat} avgRGB=${avgRgb} avgA=${avgAlpha} alpha>0=${alphaCoverage}% sample=${sample}`;
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

function disposeObjectMaterialsOnly(root) {
  if (!root?.traverse) return;
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      material?.dispose?.();
    }
  });
}

function createFadeMaterial(material, geometry) {
  if (!material) return material;
  const descriptor = getRWMaterialDescriptor(material);
  if (material.userData?.rwPipelineMaterial && descriptor) {
    const fadeDescriptor = cloneRWMaterialDescriptor(descriptor);
    if (fadeDescriptor.rwFlags?.additive) {
      fadeDescriptor.alphaMode = 'additive';
      fadeDescriptor.blending = THREE.AdditiveBlending;
      fadeDescriptor.renderBucket = 'additive';
    } else {
      fadeDescriptor.alphaMode = 'blend';
      fadeDescriptor.blending = THREE.NormalBlending;
      fadeDescriptor.renderBucket = 'transparent';
    }
    fadeDescriptor.transparent = true;
    fadeDescriptor.depthTest = true;
    fadeDescriptor.depthWrite = false;
    fadeDescriptor.alphaRef = 0;
    fadeDescriptor.opacity = 1;
    const pipelineMaterial = createRWPipelineMaterialForProfile(
      material.userData?.rwPipelineProfileId,
      {
        descriptor: fadeDescriptor,
        geometry,
      },
    );
    if (pipelineMaterial) {
      pipelineMaterial.userData = {
        ...(pipelineMaterial.userData || {}),
        ...(material.userData || {}),
        ...(pipelineMaterial.userData || {}),
        rwPipelineOwnedMaterial: true,
      };
      pipelineMaterial.transparent = true;
      pipelineMaterial.opacity = 1;
      pipelineMaterial.depthTest = true;
      pipelineMaterial.depthWrite = false;
      pipelineMaterial.alphaTest = 0;
      pipelineMaterial.blending = fadeDescriptor.blending;
      pipelineMaterial.fog = Boolean(pipelineMaterial.userData?.rwPipelineUsesThreeFog);
      pipelineMaterial.needsUpdate = true;
      return pipelineMaterial;
    }
  }
  if (descriptor) {
    const fadeDescriptor = cloneRWMaterialDescriptor(descriptor);
    if (fadeDescriptor.rwFlags?.additive) {
      fadeDescriptor.alphaMode = 'additive';
      fadeDescriptor.blending = THREE.AdditiveBlending;
      fadeDescriptor.renderBucket = 'additive';
    } else {
      fadeDescriptor.alphaMode = 'blend';
      fadeDescriptor.blending = THREE.NormalBlending;
      fadeDescriptor.renderBucket = 'transparent';
    }
    fadeDescriptor.transparent = true;
    fadeDescriptor.depthTest = true;
    fadeDescriptor.depthWrite = false;
    fadeDescriptor.alphaRef = 0;
    fadeDescriptor.opacity = 1;
    return createThreeMaterialFromRW(fadeDescriptor, geometry);
  }

  const cloned = material.clone();
  cloned.transparent = true;
  cloned.opacity = 1;
  cloned.depthTest = true;
  cloned.depthWrite = false;
  cloned.alphaTest = 0;
  if (cloned.blending !== THREE.AdditiveBlending) {
    cloned.blending = THREE.NormalBlending;
  }
  cloned.needsUpdate = true;
  return cloned;
}

function setFadeProxyOpacity(proxyRoot, opacity) {
  const clampedOpacity = clamp01(opacity);
  const materials = Array.isArray(proxyRoot?.userData?.rwFadeMaterials) ? proxyRoot.userData.rwFadeMaterials : [];
  for (const material of materials) {
    if (!material) continue;
    const descriptor = getRWMaterialDescriptor(material);
    if (descriptor) descriptor.opacity = clampedOpacity;
    material.opacity = clampedOpacity;
    if (material.uniforms?.opacity) {
      material.uniforms.opacity.value = clampedOpacity;
    }
  }
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function yieldToNextTask() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// #region agent log helpers
function dbgLog(payload) {
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

function getPipelineSelectionSignature(selectionMap, backend, worldGameVersion) {
  const selections = cloneRWPipelineSelections(selectionMap);
  return Object.values(RW_PIPELINE_CATEGORY).map((category) => {
    const normalized = resolveRWPipelineSelection(selections[category], worldGameVersion);
    return [
      category,
      normalized.enabled ? '1' : '0',
      normalized.game,
      normalized.platform,
      JSON.stringify(normalized.config || {}),
      String(backend || 'WebGL'),
      String(worldGameVersion || ''),
    ].join('|');
  }).join('::');
}

function createRwPipelineTarget(gameVersion, isTobj) {
  return {
    category: RW_PIPELINE_CATEGORY.BUILDING,
    game: String(gameVersion || '').toUpperCase(),
    isTobj: Boolean(isTobj),
  };
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

function configureFluffyCloudTexture(texture) {
  if (!texture?.isTexture) return null;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.premultiplyAlpha = true;
  texture.needsUpdate = true;
  return texture;
}

function configureFluffyHighlightTexture(texture) {
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

function applyTimecycleOverrides(sampled, overrides) {
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
  const jsrwSessionRef = useRef(createJsrwRenderer());
  const renderItemsRef = useRef([]);
  const renderChunksRef = useRef([]);
  const frameVisibilityRef = useRef(createFrameVisibilityResult());
  const renderMetricsRef = useRef({
    activeChunks: 0,
    frustumChunks: 0,
    activeItems: 0,
    visibleNear: 0,
    visibleLod: 0,
    visibleQueueMeshes: 0,
    coronaCandidates: 0,
    shadowCandidates: 0,
    transparentQueue: 0,
    additiveQueue: 0,
    overlayQueue: 0,
    drawCalls: 0,
    triangles: 0,
  });
  const selectedObjectRootRef = useRef(null);
  const selectedInstanceHighlightRef = useRef(null);
  const selectedObjectRef = useRef(null);
  const selectedTextureDetailRef = useRef(null);
  const timecycleDataRef = useRef(null);
  const timecycleStateRef = useRef({
    sourcePath: '',
    data: null,
    current: null,
    weatherNames: [...VCS_WEATHER_NAMES],
    controls: {
      hour: 12,
      minute: 0,
      weatherA: 0,
      weatherB: 0,
      weatherBlend: 0,
      extraColour: -1,
      overrides: {},
    },
  });
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
  const fpsHistoryRef = useRef(new Float32Array(180));
  const fpsHistoryIndexRef = useRef(0);
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
    backendSelection: 'WebGL',
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

  const [status, setStatus] = useState('Select an extracted GTA folder to begin.');
  const [activeBackend, setActiveBackend] = useState('WebGL');
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
    const normalizedKind = String(kind || '').trim().toUpperCase();
    const rawPath = String(path || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
    const normalizedPath = normalizePath(rawPath);
    const normalizedDetail = String(detail || '').trim();
    if (!normalizedKind || !normalizedPath) return;
    setLoadedFiles((prev) => {
      const index = prev.findIndex((entry) => (
        entry.kind === normalizedKind
        && entry.normalizedPath === normalizedPath
      ));
      if (index === -1) {
        return [...prev, {
          kind: normalizedKind,
          path: rawPath,
          normalizedPath,
          detail: normalizedDetail,
        }];
      }
      if (prev[index].detail === normalizedDetail) return prev;
      const next = [...prev];
      next[index] = {
        ...next[index],
        path: rawPath || next[index].path,
        normalizedPath,
        detail: normalizedDetail,
      };
      return next;
    });
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

  const clearWorld = useCallback(() => {
    if (selectedInstanceHighlightRef.current?.parent) {
      selectedInstanceHighlightRef.current.parent.remove(selectedInstanceHighlightRef.current);
    }
    selectedInstanceHighlightRef.current = null;
    if (selectedObjectRootRef.current) {
      clearObjectSelectionHighlight(selectedObjectRootRef.current);
      selectedObjectRootRef.current = null;
    }
    selectedObjectRef.current = null;
    setSelectedObject(null);
    selectedTextureDetailRef.current = null;
    setSelectedTextureDetail(null);
    resetImguiTextureCache();
    const worldRoot = worldRootRef.current;
    disposeWorld(worldRoot);
    jsrwSessionRef.current.disposeWaterRuntime();
    jsrwSessionRef.current.disposeCoronaRuntime();
    timecycleDataRef.current = null;
    resourceCacheRef.current = createResourceCacheState();
    streamingBuildRef.current = {
      token: buildTokenRef.current,
      running: false,
      queue: [],
      queuedKeys: new Set(),
      context: null,
      startedAt: 0,
      firstChunkReadyAt: 0,
    };
    timecycleStateRef.current = {
      sourcePath: '',
      data: null,
      current: null,
      weatherNames: [...VCS_WEATHER_NAMES],
      controls: {
        hour: 12,
        minute: 0,
        weatherA: 0,
        weatherB: 0,
        weatherBlend: 0,
        extraColour: -1,
        overrides: {},
      },
    };
    renderItemsRef.current = [];
    renderChunksRef.current = [];
    resetFrameVisibilityResult(frameVisibilityRef.current);
    worldGameVersionRef.current = String(uiStateRef.current.gameVersion || 'VCS').toUpperCase();
    jsrwSessionRef.current.setBackend(activeBackend || 'WebGL');
    jsrwSessionRef.current.setRoot(worldRoot);
    jsrwSessionRef.current.applyToRoot(worldRoot, {
      activeBackend: activeBackend || 'WebGL',
      worldGameVersion: worldGameVersionRef.current,
      fallbackAmbient: RW_PIPELINE_FALLBACK_AMBIENT,
      fallbackEmissive: RW_PIPELINE_FALLBACK_EMISSIVE,
    });
    lastPipelineSelectionSignatureRef.current = '';
    activeFadeCountRef.current = 0;
    renderMetricsRef.current = {
      activeChunks: 0,
      frustumChunks: 0,
      activeItems: 0,
      visibleNear: 0,
      visibleLod: 0,
      visibleQueueMeshes: 0,
      coronaCandidates: 0,
      shadowCandidates: 0,
      transparentQueue: 0,
      additiveQueue: 0,
      overlayQueue: 0,
      drawCalls: 0,
      triangles: 0,
    };
    rwRenderQueueRef.current?.markDirty();
    lodUpdateStateRef.current.needsRefresh = true;
    lodUpdateStateRef.current.lastCameraPos.set(Number.NaN, Number.NaN, Number.NaN);
    lodUpdateStateRef.current.lastCameraQuat.set(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    lodUpdateStateRef.current.lastCameraAspect = Number.NaN;
    lodUpdateStateRef.current.lastCameraFov = Number.NaN;
    lodUpdateStateRef.current.lastCameraNear = Number.NaN;
    lodUpdateStateRef.current.lastCameraFar = Number.NaN;
    setShowGameIcon(false);
    renderResourcesReadyRef.current = false;
    setBuildProgress({ active: false, current: 0, total: 0 });
    setStats((prev) => ({
      ...prev,
      loaded: 0,
      failed: 0,
      unresolved: 0,
      ideEffects: 0,
      nearOnly: 0,
      totalChunks: 0,
      instancedBatches: 0,
      instancedItems: 0,
      lightObjects: 0,
      lightEmitters: 0,
      queuedChunks: 0,
      readyChunks: 0,
    }));
    setFailedModels([]);
    pushConsoleLine('info', 'World cleared');
  }, [activeBackend, pushConsoleLine, resetImguiTextureCache]);

  const rebuildWorld = useCallback(async () => {
    const fileIndex = fileIndexRef.current;
    if (!fileIndex) {
      setStatus('No files loaded. Choose a folder first.');
      pushConsoleLine('warn', 'Build requested without loaded files');
      return;
    }

    const worldRoot = worldRootRef.current;
    const token = ++buildTokenRef.current;
    const buildGameVersion = String(uiStateRef.current.gameVersion || 'VCS').toUpperCase();
    buildActiveRef.current = true;
    renderResourcesReadyRef.current = false;

    try {
      // #region agent log
      dbgLog({ runId: 'safari-build', hypothesisId: 'H0', location: 'App.jsx:rebuildWorld', message: 'Build start', data: { token, buildGameVersion, files: fileIndex?.count ?? null } });
      // #endregion
      clearWorld();
      worldGameVersionRef.current = buildGameVersion;
      setLoadedFiles([]);
      setFailedModels([]);
      setShowGameIcon(false);
      setStatus('Parsing gta.dat, IDE and IPL...');
      pushConsoleLine('info', 'Start building world');
      await yieldToBrowser();
      const parseStartTime = performance.now();

      let worldLoadResult;
      try {
        const worldLoader = new WorldLoader({
          fileSystem: new BrowserFileSystem(fileIndex),
          gameVersion: uiStateRef.current.gameVersion,
          onLog: (level, message) => pushConsoleLine(level, message),
          onFileEvent: (kind, path, detail) => {
            pushLoadedFile(kind, path, detail);
            pushLoadedFileConsoleEvent(kind, path, detail);
          },
        });
        worldLoadResult = await worldLoader.load({
          extraImgPaths: ['models/gta3.img'],
        });
      } catch (error) {
        setStatus('gta.dat not found in uploaded files.');
        pushConsoleLine('error', formatConsoleArg(error));
        return;
      }

      const worldContext = worldLoadResult.context;
      const worldBuild = worldLoadResult.build;
      const worldLoadStats = worldLoadResult.stats;
      const defaultResources = worldLoadStats.defaultResources || worldContext.defaultResources || null;
      const ideById = worldContext.ideRegistry?.byId || new Map();
      const ideByModel = worldContext.ideRegistry?.byModel || new Map();
      const placements = worldContext.iplRegistry?.getAll?.() || [];

      pushConsoleLine('info', `IDE/IPL parsed in ${(performance.now() - parseStartTime).toFixed(1)} ms`);
      if (defaultResources) {
        pushConsoleLine(
          'info',
          `Static defaults: IMG ${defaultResources.counts.imgMounted}/${defaultResources.counts.imgRequested}, TXD ${defaultResources.counts.textureFound}/${defaultResources.counts.textureRequested}, COL ${defaultResources.counts.collisionFound}`,
        );
      }

      const previousControls = timecycleStateRef.current?.controls || {};
      const parsedTimecycle = worldBuild.weather?.data || null;
      const weatherNames = worldBuild.weather?.weatherNames || [...VCS_WEATHER_NAMES];
      if (parsedTimecycle) {
        const controls = {
          hour: Number.isFinite(previousControls.hour) ? previousControls.hour : 12,
          minute: Number.isFinite(previousControls.minute) ? previousControls.minute : 0,
          weatherA: Number.isFinite(previousControls.weatherA) ? previousControls.weatherA : 0,
          weatherB: Number.isFinite(previousControls.weatherB) ? previousControls.weatherB : 0,
          weatherBlend: Number.isFinite(previousControls.weatherBlend) ? previousControls.weatherBlend : 0,
          extraColour: Number.isFinite(previousControls.extraColour) ? previousControls.extraColour : -1,
          overrides: previousControls.overrides && typeof previousControls.overrides === 'object'
            ? { ...previousControls.overrides }
            : {},
        };
        controls.weatherA = Math.min(Math.max(controls.weatherA, 0), weatherNames.length - 1);
        controls.weatherB = Math.min(Math.max(controls.weatherB, 0), weatherNames.length - 1);
        const current = applyTimecycleOverrides(sampleTimecyc(parsedTimecycle, controls), controls.overrides);
        timecycleDataRef.current = parsedTimecycle;
        timecycleStateRef.current = {
          sourcePath: worldBuild.weather?.sourcePath || '',
          data: parsedTimecycle,
          current,
          weatherNames,
          controls,
        };
        pushConsoleLine(
          'info',
          `timecyc.dat loaded: ${parsedTimecycle.hours} hours x ${weatherNames.length} weathers (${worldBuild.weather?.sourcePath || 'unknown'})`,
        );
      } else {
        timecycleDataRef.current = null;
        timecycleStateRef.current = {
          sourcePath: '',
          data: null,
          current: null,
          weatherNames: [...VCS_WEATHER_NAMES],
          controls: {
            hour: 12,
            minute: 0,
            weatherA: 0,
            weatherB: 0,
            weatherBlend: 0,
            extraColour: -1,
            overrides: {},
          },
        };
      }

      totalObjectsRef.current = placements.length;

      setStats({
        files: fileIndex.count,
        ideFiles: worldLoadStats.ideFiles,
        iplFiles: worldLoadStats.iplFiles,
        ideDefs: ideByModel.size,
        ideEffects: worldLoadStats.ideEffects || 0,
        iplInst: placements.length,
        defaultResources,
        loaded: 0,
        failed: 0,
        unresolved: 0,
        nearOnly: 0,
        totalChunks: 0,
        instancedBatches: 0,
        instancedItems: 0,
        lightObjects: 0,
        lightEmitters: 0,
      });

      const modelCache = new Map();
      const textureLogCache = new Set();
      let pendingWaterPipeline = null;
      let particleTextureDictionary = null;
      const pushRuntimeMapLog = (label, texture, matches) => {
        const runtimePath = `${label}: ${texture?.name || 'unnamed'}`;
        const detail = `match=${matches ? 'yes' : 'no'}`;
        pushConsoleLine('info', `${runtimePath} / ${detail}`, 'runtime');
        pushConsoleLine('info', `[RUNTIME_MAP] ${runtimePath} / ${detail}`, 'console');
        console.log(`[RUNTIME_MAP] ${runtimePath} / ${detail}`);
        pushLoadedFile('RUNTIME_MAP', runtimePath, detail);
      };

      const getTextureDict = async (txdName) => {
        if (!txdName) return null;

        try {
          const txd = await worldContext.textureResolver.resolveTextureDictionary(txdName);
          const txdSource = worldContext.textureResolver.getSource(txdName);
          if (txd && txdSource && !textureLogCache.has(txdName)) {
            textureLogCache.add(txdName);
            pushConsoleLine('info', `TXD loaded: ${txdName}.txd (${txdSource})`);
          }
          return txd;
        } catch {
          pushConsoleLine('error', `TXD parse failed: ${txdName}.txd`);
          return null;
        }
      };

      const log2dfxDebug = (level, message) => {
        pushConsoleLine(level, message, 'runtime');
        if (level === 'warn') console.warn(message);
        else if (level === 'error') console.error(message);
        else console.log(message);
      };

      const buildCoronaTextureDictionary = async (emitters = []) => {
        const mergedDictionary = new Map(particleTextureDictionary ? Array.from(particleTextureDictionary.entries()) : []);
        const textureKeys = Array.from(new Set(
          (emitters || [])
            .flatMap((emitter) => [
              String(emitter?.textureKey || '').trim().toLowerCase(),
              String(emitter?.shadow?.textureKey || (Number(emitter?.shadow?.size) > 0 ? 'shad_exp' : '')).trim().toLowerCase(),
            ])
            .filter(Boolean),
        ));

        log2dfxDebug('info', `[2DFX] emitter texture keys: ${textureKeys.length > 0 ? textureKeys.join(', ') : '(none)'}`);

        for (const textureKey of textureKeys) {
          if (mergedDictionary.has(textureKey)) {
            const existingEntry = mergedDictionary.get(textureKey);
            log2dfxDebug('info', `[2DFX] texture found: ${textureKey} <- particle.txd (${existingEntry?.texture?.name || existingEntry?.name || textureKey})`);
            continue;
          }
          const resolvedEntry = await worldContext.textureResolver.resolveTextureEntry(textureKey, {
            preferredDictionaries: ['particle'],
          });
          if (!resolvedEntry) {
            log2dfxDebug('warn', `[2DFX] texture missing: ${textureKey}`);
            continue;
          }
          mergedDictionary.set(textureKey, resolvedEntry);
          log2dfxDebug('info', `[2DFX] texture found: ${textureKey} <- ${resolvedEntry.txdName || 'unknown.txd'} (${resolvedEntry.sourcePath || 'unknown source'})`);
        }

        return mergedDictionary;
      };

      const applyParticleTextures = async () => {
        pushConsoleLine('info', '[RUNTIME_MAP] applyParticleTextures invoked', 'runtime');
        console.log('[RUNTIME_MAP] applyParticleTextures invoked');
        await yieldToNextTask();
        dbgLog({ runId: 'safari-build', hypothesisId: 'H4', location: 'App.jsx:particle-textures', message: 'Particle textures: start getTextureDict(particle)', data: { token } });
        setStatus('Loading particle.txd...');
        const particleTxd = await getTextureDict('particle');
        particleTextureDictionary = particleTxd || null;
        const particleSource = worldContext.textureResolver.getSource('particle');
        dbgLog({ runId: 'safari-build', hypothesisId: 'H4', location: 'App.jsx:particle-textures', message: 'Particle textures: got particle txd', data: { token, ok: Boolean(particleTxd), source: particleSource || '' } });
        if (buildTokenRef.current !== token) return;

        const waterTextureName = String(worldBuild.water?.config?.textureName || 'waterclear256').toLowerCase();
        const waterTextureEntry = particleTxd?.get?.(waterTextureName) || null;
        const waterTexture = waterTextureEntry?.texture || waterTextureEntry || null;
        const lowCloudTextures = ['cloud1', 'cloud2', 'cloud3']
          .map((name) => particleTxd?.get?.(name)?.texture || particleTxd?.get?.(name) || null)
          .filter(Boolean);
        const fluffyCloudTexture = particleTxd?.get?.('cloudmasked')?.texture || particleTxd?.get?.('cloudmasked') || null;
        const fluffyHighlightTexture = particleTxd?.get?.('cloudhilit')?.texture || particleTxd?.get?.('cloudhilit') || null;

        if (particleTxd?.size || particleSource) {
          const particleKeys = particleTxd ? Array.from(particleTxd.keys()) : [];
          const requiredParticleKeys = [
            waterTextureName,
            'cloud1',
            'cloud2',
            'cloud3',
            'cloudmasked',
            'cloudhilit',
            'coronamoon',
            'coronastar',
            'coronahex',
            'coronacircle',
            'coronaringa',
          ];
          const availability = requiredParticleKeys
            .map((name) => `${name}:${particleTxd?.has?.(name) ? 'ok' : 'missing'}`)
            .join(', ');
          pushConsoleLine('info', `particle.txd source: ${particleSource || 'unknown'} | entries=${particleKeys.length}`, 'files');
          pushConsoleLine('info', `particle.txd check: ${availability}`, 'files');
          if (particleKeys.length > 0) {
            pushConsoleLine('info', `particle.txd sample: ${particleKeys.slice(0, 24).join(', ')}`, 'files');
          }
        }

        if (!pendingWaterPipeline) {
          pushConsoleLine('warn', 'Water runtime unavailable when applying particle textures.', 'runtime');
        } else if (!waterTexture) {
          pushConsoleLine('warn', `Water texture missing: particle/${waterTextureName}. Using flat color water.`);
        } else {
          pendingWaterPipeline.setTexture(waterTexture);
          pushConsoleLine('info', `Water texture applied: particle/${waterTextureName}`);
          const appliedWaterMap = pendingWaterPipeline?.raw?.farMaterial?.map;
          pushRuntimeMapLog('Water runtime map', appliedWaterMap, appliedWaterMap === waterTexture);
        }

        if (lowCloudTextures.length > 0) {
          for (let index = 0; index < lowCloudSpritesRef.current.length; index += 1) {
            const sprite = lowCloudSpritesRef.current[index];
            if (!sprite?.material) continue;
            const texture = lowCloudTextures[index % lowCloudTextures.length];
            if (!texture) continue;
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.magFilter = THREE.LinearFilter;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.needsUpdate = true;
            sprite.material.map = texture;
            sprite.material.needsUpdate = true;
          }
          pushConsoleLine('info', `Cloud textures applied: particle/${lowCloudTextures.length >= 3 ? 'cloud1-3' : 'cloud*'}`);
          const lowCloudMap = lowCloudSpritesRef.current[0]?.material?.map || null;
          pushRuntimeMapLog('Low cloud runtime map', lowCloudMap, lowCloudTextures.includes(lowCloudMap));
        } else {
          pushConsoleLine('warn', 'Low cloud textures missing: particle/cloud1-3. Using fallback sprites.');
        }

        if (fluffyCloudTexture) {
          configureFluffyCloudTexture(fluffyCloudTexture);
          fluffyCloudTextureRef.current = fluffyCloudTexture;
          for (const sprite of fluffyCloudSpritesRef.current) {
            if (!sprite?.material) continue;
            sprite.material.map = fluffyCloudTexture;
            sprite.material.premultipliedAlpha = true;
            sprite.material.needsUpdate = true;
          }
          pushConsoleLine('info', 'Cloud texture applied: particle/cloudmasked');
          const fluffyMap = fluffyCloudSpritesRef.current[0]?.material?.map || null;
          pushRuntimeMapLog('Fluffy cloud runtime map', fluffyMap, fluffyMap === fluffyCloudTexture);
        } else {
          pushConsoleLine('warn', 'Fluffy cloud texture missing: particle/cloudmasked. Using fallback sprite.');
        }

        if (fluffyHighlightTexture) {
          configureFluffyHighlightTexture(fluffyHighlightTexture);
          fluffyHighlightTextureRef.current = fluffyHighlightTexture;
          for (const sprite of fluffyHighlightSpritesRef.current) {
            if (!sprite?.material) continue;
            sprite.material.map = fluffyHighlightTexture;
            sprite.material.premultipliedAlpha = true;
            sprite.material.needsUpdate = true;
          }
          pushConsoleLine('info', 'Cloud highlight texture applied: particle/cloudhilit');
          const fluffyHighlightMap = fluffyHighlightSpritesRef.current[0]?.material?.map || null;
          pushRuntimeMapLog('Fluffy highlight runtime map', fluffyHighlightMap, fluffyHighlightMap === fluffyHighlightTexture);
        } else {
          pushConsoleLine('warn', 'Cloud highlight texture missing: particle/cloudhilit. Using fallback sprite.');
        }

        const sunTextures = {
          star: particleTxd?.get?.('coronastar')?.texture || particleTxd?.get?.('coronastar') || null,
          hex: particleTxd?.get?.('coronahex')?.texture || particleTxd?.get?.('coronahex') || null,
          circle: particleTxd?.get?.('coronacircle')?.texture || particleTxd?.get?.('coronacircle') || null,
          ring: particleTxd?.get?.('coronaringa')?.texture || particleTxd?.get?.('coronaringa') || null,
        };
        const starTexture = sunTextures.star;
        const moonTexture = particleTxd?.get?.('coronamoon')?.texture || particleTxd?.get?.('coronamoon') || null;
        skyFeatureRef.current?.setParticleTextures({
          moonTexture,
          starTexture,
          sunTextures,
        });
        if (moonTexture) {
          pushConsoleLine('info', 'Moon texture applied: particle/coronamoon');
        } else {
          pushConsoleLine('warn', 'Moon texture missing: particle/coronamoon. Using fallback sprite.');
        }
        if (starTexture) {
          pushConsoleLine('info', 'Stars texture applied: particle/coronastar');
        } else {
          pushConsoleLine('warn', 'Stars texture missing: particle/coronastar. Using fallback sprite.');
        }
        if (sunTextures.star && sunTextures.hex && sunTextures.circle && sunTextures.ring) {
          pushConsoleLine('info', 'Sun textures applied: particle/coronastar, coronahex, coronacircle, coronaringa');
        } else {
          pushConsoleLine('warn', 'Some sun textures are missing in particle.txd. Fallback procedural sprites remain in use for missing entries.');
        }
        const moonRuntimeMap = skyFeatureRef.current?.moon?.sprite?.material?.map || null;
        const starsRuntimeMap = skyFeatureRef.current?.stars?.logoSprites?.[0]?.material?.map || null;
        const sunCoreRuntimeMap = skyFeatureRef.current?.sun?.coreSprite?.material?.map || null;
        pushRuntimeMapLog('Moon runtime map', moonRuntimeMap, moonRuntimeMap === moonTexture);
        pushRuntimeMapLog('Stars runtime map', starsRuntimeMap, starsRuntimeMap === starTexture);
        pushRuntimeMapLog('Sun runtime map', sunCoreRuntimeMap, sunCoreRuntimeMap === sunTextures.star);
      };

      const tryBuildWater = async () => {
      const waterConfig = worldBuild.water?.config || null;
      if (!waterConfig) {
        pushConsoleLine('warn', 'waterpro.dat not found. Water rendering disabled.');
        return;
      }
      if (waterConfig.source !== 'waterpro') {
        pushConsoleLine(
          'warn',
          `${waterConfig.gameVersion} uses water.dat in librw/euryopa. waterpro.dat loading is skipped, so water rendering is disabled.`,
        );
        return;
      }

      const waterSourcePath = worldBuild.water?.sourcePath || '';
      const parsed = worldBuild.water?.data || null;
      if (!waterConfig || !parsed) {
        pushConsoleLine('warn', 'waterpro.dat not found. Water rendering disabled.');
        return;
      }

      try {
        setStatus('Building water... (stage 1/6: start)');
        // #region agent log
        dbgLog({ runId: 'safari-build', hypothesisId: 'H1', location: 'App.jsx:tryBuildWater', message: 'Building water: start', data: { token, waterPath: waterSourcePath || null } });
        // #endregion
        await yieldToBrowser();
        const waterStartTime = performance.now();
        // #region agent log
        dbgLog({ runId: 'safari-build', hypothesisId: 'H1', location: 'App.jsx:tryBuildWater', message: 'Building water: before arrayBuffer', data: { token } });
        // #endregion
        setStatus('Building water... (stage 2/6: reading waterpro.dat)');
        // #region agent log
        dbgLog({ runId: 'safari-build', hypothesisId: 'H2', location: 'App.jsx:tryBuildWater', message: 'Building water: parsed waterpro.dat', data: { token, levelCount: parsed?.levelCount ?? null, fineBlocks: parsed?.fineBlockList?.length ?? null } });
        // #endregion
        const waterTextureName = String(waterConfig.textureName || '').toLowerCase();

        // #region agent log
        dbgLog({ runId: 'safari-build', hypothesisId: 'H3', location: 'App.jsx:tryBuildWater', message: 'Building water: before RWWaterPipeline', data: { token, renderWater: uiStateRef.current.renderWater } });
        // #endregion
        setStatus('Building water... (stage 3/6: constructing water pipeline)');
        jsrwSessionRef.current.setBackend(activeBackend);
        const pipeline = jsrwSessionRef.current.createWaterRuntime({
          parsed,
          waterConfig,
          texture: null,
          toThreePosition: (x, y, z) => gtaPositionToThree(x, y, z),
          writeThreePosition: (target, offset, x, y, z) => {
            target[offset + 0] = -x;
            target[offset + 1] = z;
            target[offset + 2] = y;
          },
          toGamePosition: (position) => ({
            x: -position.x,
            y: position.z,
            z: position.y,
          }),
          wireframe: uiStateRef.current.wireframe,
          enabled: uiStateRef.current.renderWater,
          settings: {
            uvSpeed: uiStateRef.current.waterUvSpeed,
            waveHeight: uiStateRef.current.waterWaveHeight,
            farAlpha: uiStateRef.current.waterAlpha,
          },
        });
        // #region agent log
        dbgLog({ runId: 'safari-build', hypothesisId: 'H3', location: 'App.jsx:tryBuildWater', message: 'Building water: after RWWaterPipeline', data: { token, ms: Number((performance.now() - waterStartTime).toFixed(1)) } });
        // #endregion
        setStatus('Building water... (stage 4/6: pipeline ready)');
        pendingWaterPipeline?.dispose();
        pendingWaterPipeline = pipeline;
        pipeline.setTimecycleProvider(() => {
          const current = timecycleStateRef.current?.current;
          if (!current) return null;
          const fogNear = Math.max(
            cameraRef.current?.near ?? 0.1,
            Math.min(current.values.fogStart, current.values.farClip - 1),
          );
          const fogFar = Math.max(fogNear + 1, current.values.farClip);
          const waterAlpha = THREE.MathUtils.clamp(
            (Number(current.values?.water?.a) || 0) / 255,
            0,
            1,
          );
          return {
            color: current.three?.waterColor || null,
            farAlpha: waterAlpha,
            fogColor: current.three?.fogColor || null,
            fogNear,
            fogFar,
          };
        });
        const waterCells = pipeline.getWaterCellCount();
        pipeline.nearMesh.userData.water = {
          kind: 'waterpro',
          levelCount: parsed.levelCount,
          cells: waterCells,
        };
        pushConsoleLine(
          'info',
          `waterpro.dat loaded: ${parsed.levelCount} levels, ${waterCells} cells`,
        );
        pushConsoleLine('info', `Water pipeline built in ${(performance.now() - waterStartTime).toFixed(1)} ms`);
      } catch (error) {
        pushConsoleLine('error', `waterpro.dat parse failed: ${formatConsoleArg(error)}`);
      }
      };

      await tryBuildWater();
      await applyParticleTextures();

      const getModelTemplate = async (modelName, txdName) => {
      const key = makeAssetKey(modelName, txdName);
      if (modelCache.has(key)) return modelCache.get(key);

      const pending = (async () => {
        const resolvedModel = await worldContext.modelResolver.resolve(modelName, txdName);
        if (!resolvedModel?.template) {
          pushConsoleLine('error', `DFF missing: ${modelName}.dff (file + IMG)`);
          throw new Error(`Missing DFF: ${modelName}.dff`);
        }

        const txd = resolvedModel.textureDictionary || null;
        const dffSource = resolvedModel.dffSource || '';
        const template = resolvedModel.template;
        const usedTextureEntries = new Map();
        const registerTexture = (textureName, texture) => {
          const name = String(textureName || '').trim().toLowerCase();
          if (!name) return;
          const existing = usedTextureEntries.get(name);
          if (!existing) {
            usedTextureEntries.set(name, { name, texture: texture || null });
          } else if (!existing.texture && texture) {
            existing.texture = texture;
          }
        };
        const collectMaterialTextureNames = (material) => {
          if (!material) return;
          registerTexture(material.map?.name, material.map);
          registerTexture(material.alphaMap?.name, material.alphaMap);
          registerTexture(material.userData?.textureName, material.map);
        };
        template.traverse((node) => {
          if (!node.isMesh) return;
          const sourceMats = Array.isArray(node.material) ? node.material : [node.material];
          for (const mat of sourceMats) collectMaterialTextureNames(mat);
          const rwMats = sourceMats.map((mat) => {
            tuneTransparentMaterial(mat);
            return toRWMaterial(mat, node.geometry);
          });
          node.material = Array.isArray(node.material) ? rwMats : rwMats[0];
        });
        template.updateMatrixWorld(true);
        const meshNodes = [];
        template.traverse((node) => {
          if (!node.isMesh) return;
          meshNodes.push(node);
        });
        const instancable = meshNodes.length > 0 && meshNodes.every((node) => !node.isSkinnedMesh);
        const meshDescriptors = instancable
          ? meshNodes.map((node) => ({
            geometry: node.geometry,
            material: node.material,
            localMatrix: node.matrixWorld.clone(),
          }))
          : [];
        const dffLights = Array.isArray(template.userData?.rwDffLights) ? template.userData.rwDffLights : [];
        pushConsoleLine('info', `DFF loaded: ${modelName}.dff (${dffSource})${dffLights.length > 0 ? ` | dffLights=${dffLights.length}` : ''}`);
        const txdTextures = txd && typeof txd.keys === 'function' ? txd : null;
        if (txdTextures) {
          for (const entry of usedTextureEntries.values()) {
            if (entry.texture) continue;
            const txdTexture = txdTextures.get(entry.name);
            if (txdTexture) {
              entry.texture = txdTexture.texture || txdTexture;
              entry.compressionMethod = txdTexture.compressionMethod || txdTexture.texture?.userData?.rwCompressionMethod || 'UNKNOWN';
              entry.pixelFormat = txdTexture.pixelFormat || txdTexture.texture?.userData?.rwPixelFormat || 'UNKNOWN';
            }
          }
        }
        return {
          key,
          modelName,
          txdName,
          template,
          usedTextureEntries: Array.from(usedTextureEntries.values()).sort((a, b) => a.name.localeCompare(b.name)),
          dffLights,
          instancable,
          meshDescriptors,
        };
      })();

      modelCache.set(key, pending);
      return pending;
      };

      let loaded = 0;
      let failed = 0;
      let unresolved = 0;
      let tobjBuilt = 0;
      const effectivePlacements = placements;

      setStatus(`Loading ${effectivePlacements.length} placements...`);
      await yieldToNextTask();
      await yieldToBrowser();
      const placementStartTime = performance.now();

      const { mapping: lodMapping, usedLodIndices } = buildLodMapping(effectivePlacements, uiStateRef.current.gameVersion);
    const nonLodIndices = [];
    for (let index = 0; index < effectivePlacements.length; index += 1) {
      if (!isLodModel(effectivePlacements[index].modelName)) nonLodIndices.push(index);
    }
    const standaloneLodIndices = [];
    for (let index = 0; index < effectivePlacements.length; index += 1) {
      if (!isLodModel(effectivePlacements[index].modelName)) continue;
      if (usedLodIndices.has(index)) continue;
      standaloneLodIndices.push(index);
    }
    const camera = cameraRef.current;
    if (camera) {
      nonLodIndices.sort((a, b) => {
        const pa = effectivePlacements[a].position;
        const pb = effectivePlacements[b].position;
        const da = camera.position.distanceTo(gtaPositionToThree(pa.x, pa.y, pa.z));
        const db = camera.position.distanceTo(gtaPositionToThree(pb.x, pb.y, pb.z));
        return da - db;
      });
    }
    const nonLodWithLodIndices = nonLodIndices.filter((index) => Number.isInteger(lodMapping.get(index)));
    const nonLodWithoutLodIndices = nonLodIndices.filter((index) => !Number.isInteger(lodMapping.get(index)));
    const missingLodModels = new Set();
    for (const index of nonLodIndices) {
      if (Number.isInteger(lodMapping.get(index))) continue;
      const modelName = String(effectivePlacements[index]?.modelName || '').trim().toLowerCase();
      if (modelName) missingLodModels.add(modelName);
    }
    if (missingLodModels.size > 0) {
      pushConsoleLine(
        'error',
        `Missing LOD mapping for ${missingLodModels.size} models (render as near-only using IDE draw distance).`,
        'lod',
      );
      for (const modelName of Array.from(missingLodModels).sort()) {
        pushConsoleLine('error', `No LOD match: ${modelName}`, 'lod');
      }
    }
    const standaloneLodModels = new Set(
      standaloneLodIndices.map((index) => String(effectivePlacements[index]?.modelName || '').trim().toLowerCase()).filter(Boolean),
    );
    if (standaloneLodModels.size > 0) {
      pushConsoleLine(
        'error',
        `Standalone LOD models found: ${standaloneLodModels.size} (no near model). They will render as LOD-only.`,
        'lod',
      );
      for (const modelName of Array.from(standaloneLodModels).sort()) {
        pushConsoleLine('error', `Standalone LOD: ${modelName}`, 'lod');
      }
    }
    const buildTotal = nonLodWithLodIndices.length + nonLodWithoutLodIndices.length + standaloneLodIndices.length;
    setBuildProgress({ active: true, current: 0, total: buildTotal });

    const getPlacementDef = (placement) => ideByModel.get(placement.modelName) ?? ideById.get(placement.id);
    const tobjPlacementCount = effectivePlacements.reduce((count, placement) => {
      const def = getPlacementDef(placement);
      return count + (def?.section === 'tobjs' ? 1 : 0);
    }, 0);
    pushConsoleLine('info', `TOBJ detected in IPL placements: ${tobjPlacementCount}`);
    const placementAnchors = effectivePlacements.map((placement) => gtaPositionToThree(
      placement.position.x,
      placement.position.y,
      placement.position.z,
    ));
    const renderItems = [];
    const renderChunkMap = new Map();
    const instancedBatchMap = new Map();
    const coronaEmitters = [];
    const registeredCoronaPlacements = new Set();
    const placementsWithLights = new Set();
    let instancedItems = 0;

    const getRenderChunk = (anchor) => {
      const chunkKey = getChunkKeyFromPosition(anchor);
      if (renderChunkMap.has(chunkKey)) return renderChunkMap.get(chunkKey);
      const chunk = {
        key: chunkKey,
        center: getChunkCenterFromKey(chunkKey),
        items: [],
        coronaEmitters: [],
        shadowEmitters: [],
        active: false,
        boundsMin: new THREE.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
        boundsMax: new THREE.Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY),
        boundingBox: new THREE.Box3(),
        boundingSphere: new THREE.Sphere(),
      };
      renderChunkMap.set(chunkKey, chunk);
      return chunk;
    };

    const registerRenderItem = (item) => {
      renderItems.push(item);
      const chunk = getRenderChunk(item.anchor);
      chunk.items.push(item);
      chunk.boundsMin.min(item.anchor);
      chunk.boundsMax.max(item.anchor);
      const expandBoundsWithObject = (object3D) => {
        if (!object3D?.traverse) return;
        object3D.updateMatrixWorld(true);
        object3D.traverse((node) => {
          if (!node?.isMesh || !node.geometry) return;
          if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
          if (!node.geometry.boundingBox) return;
          const worldBox = node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld);
          chunk.boundsMin.min(worldBox.min);
          chunk.boundsMax.max(worldBox.max);
        });
      };
      expandBoundsWithObject(item.nearObj);
      expandBoundsWithObject(item.lodObj);
      item.chunkKey = chunk.key;
      return item;
    };

    const registerChunkEmitter = (emitter) => {
      if (!emitter?.position) return;
      const chunk = getRenderChunk(emitter.position);
      emitter.chunkKey = chunk.key;
      chunk.coronaEmitters.push(emitter);
      if (Number(emitter.shadow?.size) > 0) {
        chunk.shadowEmitters.push(emitter);
      }
    };

    const buildRenderSideState = (obj, handles, drawDistanceValue, defaultIsTobj) => {
      const firstHandle = Array.isArray(handles) && handles.length > 0 ? handles[0] : null;
      const placementMatrix = obj?.userData?.placementMatrix || firstHandle?.placementMatrix || null;
      return {
        streamAlpha: (obj || firstHandle) ? 0 : 1,
        fadeAlpha: (obj || firstHandle) ? 0 : 1,
        currentOpacity: 0,
        renderObject: obj || null,
        fadeBindings: null,
        proxyRoot: null,
        template: obj?.userData?.fadeTemplate || firstHandle?.selectionTemplate || null,
        placementMatrix: placementMatrix?.clone?.() || null,
        ideFlags: obj?.userData?.rwIdeFlags ?? firstHandle?.ideFlags ?? 0,
        isTobj: Boolean(obj?.userData?.isTobj ?? firstHandle?.isTobj ?? defaultIsTobj),
        objectDetail: obj?.userData?.objectDetail || firstHandle?.objectDetail || null,
        drawDistance: Number.isFinite(drawDistanceValue) ? drawDistanceValue : null,
      };
    };

    const buildPlacementWorldMatrix = (placement, anchor) => {
      const placementQuaternion = gtaPlacementQuaternionToThree(
        placement.rotation.x,
        placement.rotation.y,
        placement.rotation.z,
        placement.rotation.w,
        uiStateRef.current.quaternionOrder,
      );
      return new THREE.Matrix4().compose(
        anchor,
        placementQuaternion,
        new THREE.Vector3(1, 1, 1),
      );
    };

    const buildCoronaEmittersForPlacement = (placement, placementIndex, worldMatrix, ide, model) => {
      const emitters = [];
      const directionMatrix = new THREE.Matrix3().setFromMatrix4(worldMatrix);
      const baseId = `${placement.sourcePath || 'ipl'}:${placementIndex}:${placement.modelName}`;
      const effectLights = Array.isArray(ide?.effects)
        ? ide.effects.filter((e) => e.kind === 'light')
        : [];
      const trafficLightEmitters = buildTrafficLightCoronaEmitters({
        effectLights,
        placement,
        placementIndex,
        worldMatrix,
        baseId,
        toWorldPosition: (position, matrix) => {
          const localPosition = gtaPositionToThree(
            Number(position?.x) || 0,
            Number(position?.y) || 0,
            Number(position?.z) || 0,
          );
          return toPlainVector(localPosition.applyMatrix4(matrix));
        },
        toWorldDirection: (direction, matrix) => {
          const localDirection = gtaPositionToThree(
            Number(direction?.x) || 0,
            Number(direction?.y) || 0,
            Number(direction?.z) || 0,
          ).normalize();
          return toPlainVector(localDirection.applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix)).normalize());
        },
      });
      if (trafficLightEmitters.length > 0) {
        emitters.push(...trafficLightEmitters);
      } else {
        effectLights.forEach((effect) => {
          const effectColor = effect.color || { r: 255, g: 255, b: 255, a: 255 };
          const localPosition = gtaPositionToThree(
            Number(effect.position?.x) || 0,
            Number(effect.position?.y) || 0,
            Number(effect.position?.z) || 0,
          );
          const worldPosition = localPosition.applyMatrix4(worldMatrix);
          emitters.push({
            id: `2dfx:${baseId}:${effect.effectIndex ?? 0}`,
            sourceType: '2dfx',
            modelName: placement.modelName,
            placementIndex,
            position: toPlainVector(worldPosition),
            color: { ...effectColor, a: 255 },
            alpha: 255,
            size: Number(effect.size) || 1,
            drawDistance: Number(effect.distance) || 0,
            textureKey: effect.coronaTextureName || 'corona',
            flareType: Number(effect.flare) || 0,
            reflection: Number(effect.roadReflection ?? effect.wet) || 0,
            losCheck: Boolean((effect.flags | 0) & IDE_LIGHT_FLAG.LOS_CHECK),
            longDistance: Boolean((effect.flags | 0) & IDE_LIGHT_FLAG.LONG_DISTANCE),
            visibilityMode: map2dfxVisibilityMode(effect.flash),
            fogType: (effect.flags | 0) & IDE_LIGHT_FLAG.FOG_TYPE_MASK,
            hideObject: Boolean((effect.flags | 0) & IDE_LIGHT_FLAG.HIDE_OBJECT),
            shadow: {
              textureKey: effect.shadowTextureName || '',
              alpha: 128,
              size: Number(effect.shadowSize ?? effect.innerRange) || 0,
              intensity: Number(effect.shadowIntensity) || 0,
              front: toPlainVector(gtaPositionToThree(Number(effect.shadowSize ?? effect.innerRange) || 0, 0, 0)),
              side: toPlainVector(gtaPositionToThree(0, -(Number(effect.shadowSize ?? effect.innerRange) || 0), 0)),
              zDistance: 15,
              drawDistance: 40,
            },
            light: Number(effect.outerRange) > 0 ? {
              kind: 'point',
              range: Number(effect.outerRange) || 0,
              intensity: 1.5,
              colorScale: 'spriteBrightness',
            } : null,
          });
        });
      }

      const dffLights = Array.isArray(model?.dffLights) ? model.dffLights : [];
      dffLights.forEach((light) => {
        const lightKind = mapDffLightKind(light.lightType);
        if (!lightKind) return;
        const worldPosition = new THREE.Vector3(
          ...(Array.isArray(light.localPosition) ? light.localPosition : [0, 0, 0]),
        ).applyMatrix4(worldMatrix);
        const worldDirection = new THREE.Vector3(
          ...(Array.isArray(light.localDirection) ? light.localDirection : [0, 0, -1]),
        ).applyMatrix3(directionMatrix)
          .normalize();
        const normalizedColor = {
          r: Math.round(Math.max(0, Math.min(1, Number(light.color?.r) || 0)) * 255),
          g: Math.round(Math.max(0, Math.min(1, Number(light.color?.g) || 0)) * 255),
          b: Math.round(Math.max(0, Math.min(1, Number(light.color?.b) || 0)) * 255),
          a: 255,
        };
        emitters.push({
          id: `dfflight:${baseId}:${light.lightIndex ?? 0}`,
          sourceType: 'dffLight',
          modelName: placement.modelName,
          placementIndex,
          position: toPlainVector(worldPosition),
          direction: toPlainVector(worldDirection),
          color: normalizedColor,
          drawDistance: Math.max(120, (Number(light.radius) || 0) * 12),
          frameIndex: Number(light.frameIndex) || 0,
          lightType: Number(light.lightType) || 0,
          lightFlags: Number(light.flags) || 0,
          radius: Number(light.radius) || 0,
          directionAngle: Number(light.directionAngle) || 0,
          light: {
            kind: lightKind,
            range: Number(light.radius) || 0,
            intensity: 1.25,
            directionAngle: Number(light.directionAngle) || 0,
            penumbra: lightKind === 'spotsoft' ? 0.5 : 0,
          },
        });
      });

      return emitters;
    };

    const maybeRegisterPlacementEmitters = (placement, placementIndex, worldMatrix, ide, model, lodKind) => {
      if (lodKind === 'lod') return;
      if (registeredCoronaPlacements.has(placementIndex)) return;
      registeredCoronaPlacements.add(placementIndex);
      const emitters = buildCoronaEmittersForPlacement(placement, placementIndex, worldMatrix, ide, model);
      if (emitters.length > 0) {
        placementsWithLights.add(placementIndex);
        emitters.forEach((emitter) => registerChunkEmitter(emitter));
        coronaEmitters.push(...emitters);
      }
    };

    const buildObjectDetail = (ide, placement, lodKind, model) => {
      const ideEffects = Array.isArray(ide.effects) ? ide.effects : [];
      const dffLights = Array.isArray(model.dffLights) ? model.dffLights : [];
      return {
        id: ide.id,
        placementId: placement.id,
        modelName: ide.modelName,
        txdName: ide.txdName,
        flags: ide.flags | 0,
        activeFlagNames: decodeRwIdeFlags(ide.flags).activeFlags,
        section: ide.section,
        drawDistance: ide.drawDistance,
        lodKind,
        position: {
          x: placement.position.x,
          y: placement.position.y,
          z: placement.position.z,
        },
        rotation: {
          x: placement.rotation.x,
          y: placement.rotation.y,
          z: placement.rotation.z,
          w: placement.rotation.w,
        },
        usedTextureEntries: model.usedTextureEntries || [],
        ideEffects,
        dffLights,
        hasLighting:
          ideEffects.some((e) => e.kind === 'light') || (dffLights?.length ?? 0) > 0,
      };
    };

    const canUseInstancing = (model, ide) => {
      if (!ENABLE_WORLD_INSTANCING) return false;
      if (!model?.instancable || !Array.isArray(model.meshDescriptors) || model.meshDescriptors.length === 0) {
        return false;
      }
      if (ide?.section === 'tobjs') return false;
      const decoded = decodeRwIdeFlags(ide?.flags);
      if (decoded.drawLast || decoded.additive || decoded.noZWrite) return false;
      return model.meshDescriptors.every((descriptor) => {
        if (!descriptor?.geometry || !descriptor?.material || Array.isArray(descriptor.material)) return false;
        const rwMaterial = getRWMaterialDescriptor(descriptor.material);
        if (!rwMaterial) return false;
        return rwMaterial.renderBucket === 'opaque' || rwMaterial.renderBucket === 'cutout';
      });
    };

    const ensureInstancedBatch = (model, lodKind, ide, descriptorIndex, descriptor) => {
      const batchKey = `${model.key}|${lodKind}|${descriptorIndex}|${ide.flags | 0}`;
      if (instancedBatchMap.has(batchKey)) return instancedBatchMap.get(batchKey);
      const rwMaterial = getRWMaterialDescriptor(descriptor.material);
      const material = createThreeMaterialFromRW(cloneRWMaterialDescriptor(rwMaterial), descriptor.geometry);
      const mesh = new THREE.InstancedMesh(descriptor.geometry, material, 1);
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;
      mesh.visible = true;
      mesh.userData = {
        ...(mesh.userData || {}),
        rwPipelineTarget: createRwPipelineTarget(buildGameVersion, ide.section === 'tobjs'),
        isTobj: ide.section === 'tobjs',
      };
      applyRwIdeFlagsToInstance(mesh, ide.flags);
      worldRoot.add(mesh);
      const batch = {
        key: batchKey,
        mesh,
        entries: [],
        visibleCount: 0,
      };
      instancedBatchMap.set(batchKey, batch);
      return batch;
    };

    const tryBuildInstancedHandles = async (placement, placementIndex, lodKind, anchor) => {
      const ide = ideByModel.get(placement.modelName) ?? ideById.get(placement.id);
      if (!ide) {
        unresolved += 1;
        pushConsoleLine('error', `Missing IDE def for placement: model=${placement.modelName} id=${placement.id}`, 'build');
        return null;
      }

      try {
        const model = await getModelTemplate(ide.modelName, ide.txdName);
        if (!canUseInstancing(model, ide)) return null;
        const worldMatrix = buildPlacementWorldMatrix(placement, anchor);
        maybeRegisterPlacementEmitters(placement, placementIndex, worldMatrix, ide, model, lodKind);
        const handles = [];
        const objectDetail = buildObjectDetail(ide, placement, lodKind, model);
        model.meshDescriptors.forEach((descriptor, descriptorIndex) => {
          const batch = ensureInstancedBatch(model, lodKind, ide, descriptorIndex, descriptor);
          const matrix = worldMatrix.clone().multiply(descriptor.localMatrix);
          const handle = {
            batch,
            index: -1,
            matrix,
            placementMatrix: worldMatrix.clone(),
            visible: false,
            objectDetail,
            selectionTemplate: model.template,
            ideFlags: ide.flags | 0,
            isTobj: ide.section === 'tobjs',
          };
          batch.entries.push(handle);
          handles.push(handle);
        });
        loaded += 1;
        instancedItems += 1;
        return {
          handles,
          ide,
          model,
        };
      } catch (error) {
        failed += 1;
        pushConsoleLine(
          'error',
          `Build failed: model=${ide.modelName} txd=${ide.txdName} lod=${lodKind} (${formatConsoleArg(error)})`,
          'build',
        );
        pushFailedModel(`model=${ide.modelName} txd=${ide.txdName} lod=${lodKind} error=${formatConsoleArg(error)}`);
        return null;
      }
    };

    const buildPlacementObject = async (placement, placementIndex, lodKind, anchor) => {
      const ide = ideByModel.get(placement.modelName) ?? ideById.get(placement.id);
      if (!ide) {
        unresolved += 1;
        pushConsoleLine('error', `Missing IDE def for placement: model=${placement.modelName} id=${placement.id}`, 'build');
        return null;
      }

      try {
        const model = await getModelTemplate(ide.modelName, ide.txdName);
        const worldMatrix = buildPlacementWorldMatrix(placement, anchor);
        maybeRegisterPlacementEmitters(placement, placementIndex, worldMatrix, ide, model, lodKind);

        const instance = SkeletonUtils.clone(model.template);
        instance.applyMatrix4(worldMatrix);
        applyWireframe(instance, uiStateRef.current.wireframe);
        if (ide.section === 'tobjs') {
          prepareTobjInstanceMaterials(instance, uiStateRef.current.disableVertexColor);
          tobjBuilt += 1;
        }
        applyRwIdeFlagsToInstance(instance, ide.flags);
        applyDisableVertexColor(instance, uiStateRef.current.disableVertexColor);
        applyGlobalBackfaceCulling(instance, uiStateRef.current.disableBackfaceCulling);
        instance.updateMatrixWorld(true);
        instance.traverse((node) => {
          if (!node.isObject3D) return;
          node.matrixAutoUpdate = false;
          node.matrixWorldAutoUpdate = false;
        });
        instance.visible = false;
        instance.userData.lodKind = lodKind;
        instance.userData.selectableRoot = true;
        instance.userData.objectDetail = buildObjectDetail(ide, placement, lodKind, model);
        instance.userData.fadeTemplate = model.template;
        instance.userData.placementMatrix = worldMatrix.clone();
        instance.userData.rwIdeFlags = ide.flags | 0;
        instance.userData.isTobj = ide.section === 'tobjs';
        instance.userData.rwPipelineTarget = createRwPipelineTarget(buildGameVersion, ide.section === 'tobjs');
        collectQueueMeshes(instance);
        worldRoot.add(instance);
        loaded += 1;
        return instance;
      } catch (error) {
        failed += 1;
        pushConsoleLine(
          'error',
          `Build failed: model=${ide.modelName} txd=${ide.txdName} lod=${lodKind} (${formatConsoleArg(error)})`,
          'build',
        );
        pushFailedModel(`model=${ide.modelName} txd=${ide.txdName} lod=${lodKind} error=${formatConsoleArg(error)}`);
        return null;
      }
    };

    const batchSize = 32;
    let completed = 0;
      for (let batchStart = 0; batchStart < nonLodWithLodIndices.length; batchStart += batchSize) {
        if (buildTokenRef.current !== token) {
          pendingWaterPipeline?.dispose();
          return;
        }
      const batch = nonLodWithLodIndices.slice(batchStart, batchStart + batchSize);

      await Promise.all(batch.map(async (index) => {
        const placement = effectivePlacements[index];
        const anchor = placementAnchors[index];
        const lodIndex = lodMapping.get(index);
        const lodPlacement = effectivePlacements[lodIndex];
        const lodAnchor = placementAnchors[lodIndex];
        const nearDef = getPlacementDef(placement);
        const lodDef = getPlacementDef(lodPlacement);
        const isTobj = nearDef?.section === 'tobjs';
        const nearObj = await buildPlacementObject(placement, index, 'near', anchor);
        const lodObj = await buildPlacementObject(lodPlacement, lodIndex, 'lod', lodAnchor);
        if (nearObj || lodObj) {
          registerRenderItem({
            isTobj,
            anchor: anchor.clone(),
            nearObj,
            lodObj,
            nearHandles: [],
            lodHandles: [],
            nearDrawDistance: Number.isFinite(nearDef?.drawDistance) ? nearDef.drawDistance : null,
            lodDrawDistance: Number.isFinite(lodDef?.drawDistance) ? lodDef.drawDistance : null,
            nearState: buildRenderSideState(nearObj, [], nearDef?.drawDistance, isTobj),
            lodState: buildRenderSideState(lodObj, [], lodDef?.drawDistance, lodDef?.section === 'tobjs'),
            mode: 'hidden',
          });
        }
      }));
      completed += batch.length;

      setStats((prev) => ({ ...prev, loaded, failed, unresolved }));
      setBuildProgress({ active: true, current: completed, total: buildTotal });
      pushConsoleLine('info', `Build progress: ${completed}/${buildTotal}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

      for (let batchStart = 0; batchStart < nonLodWithoutLodIndices.length; batchStart += batchSize) {
        if (buildTokenRef.current !== token) {
          pendingWaterPipeline?.dispose();
          return;
        }
      const batch = nonLodWithoutLodIndices.slice(batchStart, batchStart + batchSize);

      await Promise.all(batch.map(async (index) => {
        const placement = effectivePlacements[index];
        const anchor = placementAnchors[index];
        const nearDef = getPlacementDef(placement);
        const isTobj = nearDef?.section === 'tobjs';
        const nearInstanced = await tryBuildInstancedHandles(placement, index, 'near', anchor);
        const nearObj = nearInstanced ? null : await buildPlacementObject(placement, index, 'near', anchor);
        if (nearObj || nearInstanced) {
          registerRenderItem({
            isTobj,
            anchor: anchor.clone(),
            nearObj,
            lodObj: null,
            nearHandles: nearInstanced?.handles || [],
            lodHandles: [],
            nearDrawDistance: Number.isFinite(nearDef?.drawDistance) ? nearDef.drawDistance : null,
            lodDrawDistance: null,
            nearState: buildRenderSideState(nearObj, nearInstanced?.handles || [], nearDef?.drawDistance, isTobj),
            lodState: buildRenderSideState(null, [], null, false),
            mode: 'hidden',
          });
        }
      }));
      completed += batch.length;

      setStats((prev) => ({ ...prev, loaded, failed, unresolved }));
      setBuildProgress({ active: true, current: completed, total: buildTotal });
      pushConsoleLine('info', `Build progress: ${completed}/${buildTotal}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

      for (let batchStart = 0; batchStart < standaloneLodIndices.length; batchStart += batchSize) {
        if (buildTokenRef.current !== token) {
          pendingWaterPipeline?.dispose();
          return;
        }
      const batch = standaloneLodIndices.slice(batchStart, batchStart + batchSize);

      await Promise.all(batch.map(async (index) => {
        const placement = effectivePlacements[index];
        const anchor = placementAnchors[index];
        const lodDef = getPlacementDef(placement);
        const isTobj = lodDef?.section === 'tobjs';
        const lodInstanced = await tryBuildInstancedHandles(placement, index, 'lod', anchor);
        const lodObj = lodInstanced ? null : await buildPlacementObject(placement, index, 'lod', anchor);
        if (lodObj || lodInstanced) {
          registerRenderItem({
            isTobj,
            anchor: anchor.clone(),
            nearObj: null,
            lodObj,
            nearHandles: [],
            lodHandles: lodInstanced?.handles || [],
            nearDrawDistance: null,
            lodDrawDistance: Number.isFinite(lodDef?.drawDistance) ? lodDef.drawDistance : null,
            nearState: buildRenderSideState(null, [], null, isTobj),
            lodState: buildRenderSideState(lodObj, lodInstanced?.handles || [], lodDef?.drawDistance, isTobj),
            mode: 'hidden',
          });
        }
      }));
      completed += batch.length;

      setStats((prev) => ({ ...prev, loaded, failed, unresolved }));
      setBuildProgress({ active: true, current: completed, total: buildTotal });
      pushConsoleLine('info', `Build progress: ${completed}/${buildTotal}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

      for (const chunk of renderChunkMap.values()) {
        if (chunk.items.length === 0) {
          chunk.boundingBox.setFromCenterAndSize(
            chunk.center.clone(),
            new THREE.Vector3(
              WORLD_CHUNK_SIZE + (CHUNK_CULL_MARGIN_XZ * 2),
              WORLD_CHUNK_SIZE + (CHUNK_CULL_MARGIN_Y * 2),
              WORLD_CHUNK_SIZE + (CHUNK_CULL_MARGIN_XZ * 2),
            ),
          );
          chunk.boundingSphere.center.copy(chunk.center);
          chunk.boundingSphere.radius = CHUNK_SPHERE_PADDING + Math.max(CHUNK_CULL_MARGIN_XZ, CHUNK_CULL_MARGIN_Y);
          continue;
        }
        chunk.boundingBox.min.copy(chunk.boundsMin);
        chunk.boundingBox.max.copy(chunk.boundsMax);
        chunk.boundingBox.min.x -= CHUNK_CULL_MARGIN_XZ;
        chunk.boundingBox.min.y -= CHUNK_CULL_MARGIN_Y;
        chunk.boundingBox.min.z -= CHUNK_CULL_MARGIN_XZ;
        chunk.boundingBox.max.x += CHUNK_CULL_MARGIN_XZ;
        chunk.boundingBox.max.y += CHUNK_CULL_MARGIN_Y;
        chunk.boundingBox.max.z += CHUNK_CULL_MARGIN_XZ;
        const sphereCenter = chunk.boundsMin.clone().add(chunk.boundsMax).multiplyScalar(0.5);
        let radiusSq = 0;
        for (const item of chunk.items) {
          radiusSq = Math.max(radiusSq, sphereCenter.distanceToSquared(item.anchor));
        }
        chunk.boundingSphere.center.copy(sphereCenter);
        chunk.boundingSphere.radius = Math.sqrt(radiusSq) + CHUNK_SPHERE_PADDING + Math.max(CHUNK_CULL_MARGIN_XZ, CHUNK_CULL_MARGIN_Y);
      }

      for (const batch of instancedBatchMap.values()) {
        const entryCount = batch.entries.length;
        const sourceGeometry = batch.mesh.geometry;
        const sourceMaterial = batch.mesh.material;
        const instancedMesh = new THREE.InstancedMesh(sourceGeometry, sourceMaterial, Math.max(1, entryCount));
        instancedMesh.count = entryCount;
        instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        instancedMesh.frustumCulled = false;
        instancedMesh.matrixAutoUpdate = false;
        instancedMesh.matrixWorldAutoUpdate = false;
        instancedMesh.visible = false;
        instancedMesh.material = sourceMaterial;
        instancedMesh.userData = {
          ...(batch.mesh.userData || {}),
          rwInstanceEntries: batch.entries,
        };
        worldRoot.remove(batch.mesh);
        batch.mesh = instancedMesh;
        worldRoot.add(instancedMesh);
        for (let index = 0; index < batch.entries.length; index += 1) {
          const entry = batch.entries[index];
          entry.index = index;
          instancedMesh.setMatrixAt(index, HIDDEN_INSTANCE_MATRIX);
        }
        instancedMesh.instanceMatrix.needsUpdate = true;
      }

      jsrwSessionRef.current.setWaterRuntime(pendingWaterPipeline);
      log2dfxDebug('info', `[2DFX] corona emitters discovered: ${coronaEmitters.length}`);
      if (coronaEmitters.length > 0) {
        const coronaTextureDictionary = await buildCoronaTextureDictionary(coronaEmitters);
        const coronaRuntime = jsrwSessionRef.current.createCoronaRuntime({
          root: worldRoot,
          emitters: coronaEmitters,
          textureDictionary: coronaTextureDictionary,
          enableDebugHelpers: true,
        });
        coronaRuntime.setEnabled(uiStateRef.current.render2dfx);
        coronaRuntime.setDebugShowAll(uiStateRef.current.debug2dfx);
        const coronaBindings = Array.isArray(coronaRuntime?.raw?.entries)
          ? coronaRuntime.raw.entries
            .filter((entry) => entry?.emitter?.sourceType === '2dfx')
            .map((entry) => ({
              textureKey: String(entry?.emitter?.textureKey || ''),
              hasTexture: Boolean(entry?.sprite?.material?.map),
              appliedName: entry?.sprite?.material?.map?.name || '',
            }))
          : [];
        if (coronaBindings.length > 0) {
          const groupedBindings = Array.from(new Map(
            coronaBindings.map((binding) => [binding.textureKey, binding]),
          ).values());
          groupedBindings.forEach((binding) => {
            log2dfxDebug(
              binding.hasTexture ? 'info' : 'warn',
              `[2DFX] apply ${binding.textureKey}: ${binding.hasTexture ? `ok (${binding.appliedName || 'unnamed'})` : 'failed (material.map missing)'}`,
            );
          });
        }
        const shadowRuntime = jsrwSessionRef.current.createShadowRuntime({
          root: worldRoot,
          emitters: coronaEmitters,
          textureDictionary: coronaTextureDictionary,
        });
        shadowRuntime.setEnabled(uiStateRef.current.render2dfx && uiStateRef.current.shadows.enabled);
        log2dfxDebug('info', `[2DFX] corona emitters ready: ${coronaEmitters.length}`);
      } else {
        log2dfxDebug('warn', '[2DFX] no corona emitters were created');
        jsrwSessionRef.current.disposeCoronaRuntime();
        jsrwSessionRef.current.disposeShadowRuntime();
      }
      renderItemsRef.current = renderItems;
      renderChunksRef.current = Array.from(renderChunkMap.values());
      jsrwSessionRef.current.setBackend(activeBackend);
      jsrwSessionRef.current.setRoot(worldRoot);
      jsrwSessionRef.current.applyToRoot(worldRoot, {
        activeBackend,
        worldGameVersion: buildGameVersion,
        timecycleCurrent: timecycleStateRef.current?.current,
        ambientColor: timecycleStateRef.current?.current?.values?.ambient
          ? toThreeColorFromTimecycleValue(timecycleStateRef.current.current.values.ambient)
          : RW_PIPELINE_FALLBACK_AMBIENT,
        emissiveColor: timecycleStateRef.current?.current?.values?.ambientBl
          ? toThreeColorFromTimecycleValue(timecycleStateRef.current.current.values.ambientBl)
          : RW_PIPELINE_FALLBACK_EMISSIVE,
        fallbackAmbient: RW_PIPELINE_FALLBACK_AMBIENT,
        fallbackEmissive: RW_PIPELINE_FALLBACK_EMISSIVE,
      });
      applyWireframe(worldRoot, uiStateRef.current.wireframe);
      applyDisableVertexColor(worldRoot, uiStateRef.current.disableVertexColor);
      applyGlobalBackfaceCulling(worldRoot, uiStateRef.current.disableBackfaceCulling);
      lastPipelineSelectionSignatureRef.current = getPipelineSelectionSignature(
        uiStateRef.current.pipelineDebug,
        activeBackend,
        buildGameVersion,
      );
      rwRenderQueueRef.current?.markDirty();
      lodUpdateStateRef.current.needsRefresh = true;
      lodUpdateStateRef.current.lastCameraPos.set(Number.NaN, Number.NaN, Number.NaN);
      lodUpdateStateRef.current.lastCameraQuat.set(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
      lodUpdateStateRef.current.lastCameraAspect = Number.NaN;
      lodUpdateStateRef.current.lastCameraFov = Number.NaN;
      lodUpdateStateRef.current.lastCameraNear = Number.NaN;
      lodUpdateStateRef.current.lastCameraFar = Number.NaN;
      setBuildProgress({ active: false, current: buildTotal, total: buildTotal });
      setStatus(`Done. Loaded ${loaded} placements.`);
      setShowGameIcon(true);
      renderResourcesReadyRef.current = true;
      setStats((prev) => ({
        ...prev,
        loaded,
        failed,
        unresolved,
        totalChunks: renderChunkMap.size,
        instancedBatches: instancedBatchMap.size,
        instancedItems,
        lightObjects: placementsWithLights.size,
        lightEmitters: coronaEmitters.length,
      }));
      pushConsoleLine('info', `Chunk visible set: ${renderChunkMap.size} chunks`);
      pushConsoleLine('info', `Instanced batches: ${instancedBatchMap.size}, instanced placements: ${instancedItems}`);
      pushConsoleLine('info', `Build done. loaded=${loaded} failed=${failed} unresolved=${unresolved} tobjBuilt=${tobjBuilt}`);
      pushConsoleLine('info', `Placement build finished in ${(performance.now() - placementStartTime).toFixed(1)} ms`);
    } finally {
      buildActiveRef.current = false;
    }
  }, [activeBackend, clearWorld, pushConsoleLine, pushFailedModel, pushLoadedFile]);

  const onPickFolder = useCallback((event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const index = buildFileIndex(files);
    fileIndexRef.current = index;
    pushConsoleLine('info', `Folder indexed: ${index.count} files`);

    setStats((prev) => ({ ...prev, files: index.count }));
    setShowMapPickerFallback(false);
    setStatus(`Indexed ${index.count} files. Click Build World.`);
    event.target.value = '';
  }, [pushConsoleLine]);

  const openMapPicker = useCallback((source = 'dom') => {
    const input = fileInputRef.current;
    if (!input) return false;

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS/i.test(ua);

    input.value = '';

    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        setShowMapPickerFallback(false);
        return true;
      }
    } catch {
      // Safari may reject showPicker/click outside a trusted DOM gesture.
    }

    try {
      input.click();
      if (source !== 'imgui' || !isSafari) {
        setShowMapPickerFallback(false);
      } else {
        setShowMapPickerFallback(true);
        setStatus('Safari may block file dialogs from the ImGui menu. Click the HUD folder picker below.');
      }
      return true;
    } catch {
      if (isSafari) {
        setShowMapPickerFallback(true);
        setStatus('Safari blocked the ImGui file dialog. Click the HUD folder picker below.');
      }
      return false;
    }
  }, []);

  const setInstanceHandlesVisible = useCallback((handles, visible, dirtyBatches) => {
    if (!Array.isArray(handles) || handles.length === 0) return;
    for (const handle of handles) {
      if (!handle?.batch?.mesh || handle.index < 0 || handle.visible === visible) continue;
      handle.batch.mesh.setMatrixAt(handle.index, visible ? handle.matrix : HIDDEN_INSTANCE_MATRIX);
      handle.visible = visible;
      handle.batch.visibleCount += visible ? 1 : -1;
      handle.batch.mesh.visible = handle.batch.visibleCount > 0;
      dirtyBatches?.add(handle.batch);
    }
  }, []);

  const setRenderSideOriginalVisible = useCallback((item, side, visible, dirtyBatches) => {
    if (side === 'near') {
      if (item.nearObj) item.nearObj.visible = visible;
      setInstanceHandlesVisible(item.nearHandles, visible, dirtyBatches);
      return;
    }
    if (item.lodObj) item.lodObj.visible = visible;
    setInstanceHandlesVisible(item.lodHandles, visible, dirtyBatches);
  }, [setInstanceHandlesVisible]);

  const ensureRenderSideObjectFade = useCallback((sideState) => {
    const root = sideState?.renderObject;
    if (!root?.traverse) return false;
    if (Array.isArray(sideState.fadeBindings)) return true;

    const bindings = [];
    root.traverse((node) => {
      if (!node.isMesh) return;
      const sourceMaterials = Array.isArray(node.material) ? node.material : [node.material];
      const fadeMaterials = sourceMaterials.map((material) => createFadeMaterial(material, node.geometry));
      bindings.push({
        node,
        originalMaterial: node.material,
        fadeMaterials,
        isArray: Array.isArray(node.material),
      });
      node.material = Array.isArray(node.material) ? fadeMaterials : fadeMaterials[0];
    });
    sideState.fadeBindings = bindings;
    return true;
  }, []);

  const setRenderSideObjectFadeOpacity = useCallback((sideState, opacity) => {
    const bindings = Array.isArray(sideState?.fadeBindings) ? sideState.fadeBindings : [];
    const clampedOpacity = clamp01(opacity);
    for (const binding of bindings) {
      for (const material of binding.fadeMaterials) {
        const descriptor = getRWMaterialDescriptor(material);
        if (descriptor) descriptor.opacity = clampedOpacity;
        material.opacity = clampedOpacity;
        if (material.uniforms?.opacity) {
          material.uniforms.opacity.value = clampedOpacity;
        }
      }
    }
  }, []);

  const disposeRenderSideObjectFade = useCallback((sideState) => {
    const bindings = Array.isArray(sideState?.fadeBindings) ? sideState.fadeBindings : null;
    if (!bindings) return false;
    for (const binding of bindings) {
      binding.node.material = binding.originalMaterial;
      for (const material of binding.fadeMaterials) {
        material?.dispose?.();
      }
    }
    sideState.fadeBindings = null;
    return true;
  }, []);

  const buildRenderSideFadeProxy = useCallback((item, side) => {
    const sideState = side === 'near' ? item?.nearState : item?.lodState;
    if (!sideState?.template?.traverse || !sideState?.placementMatrix) return null;

    const proxy = SkeletonUtils.clone(sideState.template);
    proxy.name = `${side}_fade_proxy`;
    proxy.applyMatrix4(sideState.placementMatrix);
    applyWireframe(proxy, uiStateRef.current.wireframe);
    if (sideState.isTobj) {
      prepareTobjInstanceMaterials(proxy, uiStateRef.current.disableVertexColor);
    }
    applyRwIdeFlagsToInstance(proxy, sideState.ideFlags || 0);
    applyDisableVertexColor(proxy, uiStateRef.current.disableVertexColor);
    applyGlobalBackfaceCulling(proxy, uiStateRef.current.disableBackfaceCulling);
    proxy.visible = false;
    proxy.userData = {
      ...(proxy.userData || {}),
      rwFadeProxy: true,
      selectableRoot: false,
      objectDetail: sideState.objectDetail || null,
      isTobj: Boolean(sideState.isTobj),
      rwPipelineTarget: createRwPipelineTarget(worldGameVersionRef.current, sideState.isTobj),
    };

    const fadeMaterials = [];
    proxy.traverse((node) => {
      if (!node.isObject3D) return;
      node.matrixAutoUpdate = false;
      node.matrixWorldAutoUpdate = false;
      if (!node.isMesh) return;
      node.frustumCulled = false;
      node.raycast = () => {};
      const sourceMaterials = Array.isArray(node.material) ? node.material : [node.material];
      const nextMaterials = sourceMaterials.map((material) => {
        const fadeMaterial = createFadeMaterial(material, node.geometry);
        if (fadeMaterial) fadeMaterials.push(fadeMaterial);
        return fadeMaterial;
      });
      node.material = Array.isArray(node.material) ? nextMaterials : nextMaterials[0];
    });
    proxy.userData.rwFadeMaterials = fadeMaterials;
    collectQueueMeshes(proxy);
    proxy.updateMatrixWorld(true);
    return proxy;
  }, []);

  const disposeRenderSideFadeProxy = useCallback((sideState) => {
    const proxyRoot = sideState?.proxyRoot;
    if (!proxyRoot) return false;
    if (proxyRoot.parent) proxyRoot.parent.remove(proxyRoot);
    disposeObjectMaterialsOnly(proxyRoot);
    sideState.proxyRoot = null;
    sideState.currentOpacity = 0;
    return true;
  }, []);

  const ensureRenderSideFadeProxy = useCallback((item, side) => {
    const sideState = side === 'near' ? item?.nearState : item?.lodState;
    if (!sideState) return null;
    if (sideState.proxyRoot) return sideState.proxyRoot;
    const proxy = buildRenderSideFadeProxy(item, side);
    if (!proxy) return null;
    worldRootRef.current.add(proxy);
    sideState.proxyRoot = proxy;
    jsrwSessionRef.current.setBackend(activeBackend);
    jsrwSessionRef.current.applyToObject(proxy, {
      activeBackend,
      worldGameVersion: worldGameVersionRef.current,
      timecycleCurrent: timecycleStateRef.current?.current,
      ambientColor: timecycleStateRef.current?.current?.values?.ambient
        ? toThreeColorFromTimecycleValue(timecycleStateRef.current.current.values.ambient)
        : RW_PIPELINE_FALLBACK_AMBIENT,
      emissiveColor: timecycleStateRef.current?.current?.values?.ambientBl
        ? toThreeColorFromTimecycleValue(timecycleStateRef.current.current.values.ambientBl)
        : RW_PIPELINE_FALLBACK_EMISSIVE,
      fallbackAmbient: RW_PIPELINE_FALLBACK_AMBIENT,
      fallbackEmissive: RW_PIPELINE_FALLBACK_EMISSIVE,
    });
    applyWireframe(proxy, uiStateRef.current.wireframe);
    applyDisableVertexColor(proxy, uiStateRef.current.disableVertexColor);
    applyGlobalBackfaceCulling(proxy, uiStateRef.current.disableBackfaceCulling);
    rwRenderQueueRef.current?.markDirty();
    return proxy;
  }, [activeBackend, buildRenderSideFadeProxy]);

  const applyRenderSideOpacity = useCallback((item, side, opacity, dirtyBatches) => {
    const sideState = side === 'near' ? item?.nearState : item?.lodState;
    if (!sideState) return false;
    const clampedOpacity = clamp01(opacity);

    if (clampedOpacity <= RW_FADE_EPSILON) {
      if (disposeRenderSideObjectFade(sideState)) rwRenderQueueRef.current?.markDirty();
      setRenderSideOriginalVisible(item, side, false, dirtyBatches);
      if (disposeRenderSideFadeProxy(sideState)) rwRenderQueueRef.current?.markDirty();
      sideState.currentOpacity = 0;
      return false;
    }

    if (clampedOpacity >= (1 - RW_FADE_EPSILON)) {
      if (disposeRenderSideObjectFade(sideState)) rwRenderQueueRef.current?.markDirty();
      if (disposeRenderSideFadeProxy(sideState)) rwRenderQueueRef.current?.markDirty();
      setRenderSideOriginalVisible(item, side, true, dirtyBatches);
      sideState.currentOpacity = 1;
      return false;
    }

    if (ensureRenderSideObjectFade(sideState)) {
      if (disposeRenderSideFadeProxy(sideState)) rwRenderQueueRef.current?.markDirty();
      sideState.renderObject.visible = true;
      setRenderSideObjectFadeOpacity(sideState, clampedOpacity);
      sideState.currentOpacity = clampedOpacity;
      return false;
    }

    setRenderSideOriginalVisible(item, side, false, dirtyBatches);
    const proxy = ensureRenderSideFadeProxy(item, side);
    if (!proxy) {
      setRenderSideOriginalVisible(item, side, true, dirtyBatches);
      sideState.currentOpacity = 1;
      return false;
    }
    setFadeProxyOpacity(proxy, clampedOpacity);
    proxy.visible = true;
    sideState.currentOpacity = clampedOpacity;
    return true;
  }, [
    disposeRenderSideFadeProxy,
    disposeRenderSideObjectFade,
    ensureRenderSideFadeProxy,
    ensureRenderSideObjectFade,
    setRenderSideObjectFadeOpacity,
    setRenderSideOriginalVisible,
  ]);

  const hideRenderItemCompletely = useCallback((item, dirtyBatches) => {
    item.mode = 'hidden';
    if (item?.nearState) item.nearState.currentOpacity = 0;
    if (item?.lodState) item.lodState.currentOpacity = 0;
    setRenderSideOriginalVisible(item, 'near', false, dirtyBatches);
    setRenderSideOriginalVisible(item, 'lod', false, dirtyBatches);
    let queueDirty = false;
    if (disposeRenderSideObjectFade(item?.nearState)) queueDirty = true;
    if (disposeRenderSideObjectFade(item?.lodState)) queueDirty = true;
    if (disposeRenderSideFadeProxy(item?.nearState)) queueDirty = true;
    if (disposeRenderSideFadeProxy(item?.lodState)) queueDirty = true;
    if (queueDirty) rwRenderQueueRef.current?.markDirty();
  }, [disposeRenderSideFadeProxy, disposeRenderSideObjectFade, setRenderSideOriginalVisible]);

  const hasNearRenderable = useCallback((item) => (
    Boolean(item?.nearObj) || (Array.isArray(item?.nearHandles) && item.nearHandles.length > 0)
  ), []);

  const hasLodRenderable = useCallback((item) => (
    Boolean(item?.lodObj) || (Array.isArray(item?.lodHandles) && item.lodHandles.length > 0)
  ), []);

  const collectRenderSideFrameVisibility = useCallback((frameVisibility, item, side) => {
    const sideState = side === 'near' ? item?.nearState : item?.lodState;
    if (!frameVisibility || !sideState) return;
    if ((sideState.currentOpacity ?? 0) <= RW_FADE_EPSILON) return;

    addVisibleItem(frameVisibility, item);

    if (sideState.proxyRoot?.visible) {
      for (const mesh of getCachedQueueMeshes(sideState.proxyRoot)) {
        addVisibleQueueMesh(frameVisibility, mesh);
      }
      return;
    }

    if (sideState.renderObject?.visible) {
      for (const mesh of getCachedQueueMeshes(sideState.renderObject)) {
        addVisibleQueueMesh(frameVisibility, mesh);
      }
    }

    const handles = side === 'near' ? item?.nearHandles : item?.lodHandles;
    if (!Array.isArray(handles) || handles.length === 0) return;
    for (const handle of handles) {
      if (!handle?.visible || !handle?.batch?.mesh?.visible) continue;
      addVisibleQueueMesh(frameVisibility, handle.batch.mesh);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const imguiCanvas = imguiCanvasRef.current;
    if (!container || !canvas || !imguiCanvas) return undefined;

    let renderer = null;
    let cancelled = false;
    let rendererReady = false;

    if (activeBackend === 'WebGPU') {
      if (!WebGPU.isAvailable()) {
        pushConsoleLine('warn', 'WebGPU is not supported in this browser. Fallback to WebGL.');
        setStatus('WebGPU not supported. Switched to WebGL.');
        uiStateRef.current.backendSelection = 'WebGL';
        backendSwitchingRef.current = true;
        setActiveBackend('WebGL');
        return undefined;
      }
      renderer = new WebGPURenderer({ canvas, antialias: true, alpha: false });
      renderer.init().then(() => {
        if (cancelled) {
          renderer.dispose();
          return;
        }
        pushConsoleLine('info', 'WebGPU backend initialized');
        resize();
        rendererReady = true;
        backendSwitchingRef.current = false;
      }).catch((error) => {
        if (cancelled) return;
        pushConsoleLine('error', `WebGPU init failed: ${formatConsoleArg(error)}. Fallback to WebGL.`);
        setStatus('WebGPU init failed. Switched to WebGL.');
        uiStateRef.current.backendSelection = 'WebGL';
        setActiveBackend('WebGL');
        try {
          renderer.dispose();
        } catch {
          // ignore disposal errors in fallback path
        }
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        rendererRef.current = renderer;
        resize();
        rendererReady = true;
        backendSwitchingRef.current = false;
      });
    } else {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      rendererReady = true;
      backendSwitchingRef.current = false;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    if (renderer.info) {
      renderer.info.autoReset = false;
    }

    canvas.tabIndex = 1;

    const scene = new THREE.Scene();
    scene.background = null;
    const skyScene = new THREE.Scene();
    const skyCloudScene = new THREE.Scene();
    const skyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    const skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSkyTop: { value: SKY_DEFAULT_TOP.clone() },
        uSkyBottom: { value: SKY_DEFAULT_BOTTOM.clone() },
        uFogColor: { value: SKY_DEFAULT_FOG.clone() },
        uBelowHorizonColor: { value: new THREE.Color().setRGB(30 / 255, 30 / 255, 30 / 255, THREE.SRGBColorSpace) },
        uCameraForward: { value: new THREE.Vector3(0, 0, -1) },
        uCameraRight: { value: new THREE.Vector3(1, 0, 0) },
        uCameraUp: { value: new THREE.Vector3(0, 1, 0) },
        uHorizonY: { value: 0.5 },
        uSmallStripHeight: { value: SKY_SMALL_STRIP_HEIGHT },
        uHorizonStrength: { value: 0.8 },
        uLowerBandEndY: { value: 0.38 },
        uTanHalfFov: { value: Math.tan(THREE.MathUtils.degToRad(60 * 0.5)) },
        uAspect: { value: 1 },
        uBelowHorizonMix: { value: 0 },
      },
      vertexShader: skyVertexShader,
      fragmentShader: skyFragmentShader,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
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
      sprite.scale.set(60, 60, 1);
      sprite.renderOrder = -840;
      skyCloudScene.add(sprite);
      return sprite;
    });
    const hudScene = new THREE.Scene();
    const hudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    hudCamera.position.set(0, 0, 1);
    const skyFeature = new SkyRendererBundle();

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
    jsrwSessionRef.current.setRoot(worldRootRef.current);
    rwRenderQueueRef.current = jsrwSessionRef.current.getRenderQueue() || jsrwSessionRef.current.createRenderQueue(worldRootRef.current);
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
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
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

      const timecycleInfo = timecycleStateRef.current;
      const parsedTimecycle = timecycleDataRef.current;
      if (parsedTimecycle) {
        const sampled = applyTimecycleOverrides(
          sampleTimecyc(parsedTimecycle, timecycleInfo.controls),
          timecycleInfo.controls?.overrides,
        );
        timecycleInfo.current = sampled;
      } else {
        timecycleInfo.current = null;
      }
      const timecycleCurrent = timecycleInfo.current;
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
      const sunPipeline = skyFeature?.sun || null;
      const cloudMotion = cloudMotionRef.current;
      if (skyMaterial?.uniforms) {
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
        skyMaterial.uniforms.uSkyTop.value.copy(skyTopColor);
        skyMaterial.uniforms.uSkyBottom.value.copy(skyBottomColor);
        skyMaterial.uniforms.uFogColor.value.copy(fogColor);
        skyMaterial.uniforms.uBelowHorizonColor.value.copy(belowHorizonColor);
        skyMaterial.uniforms.uCameraForward.value.copy(cameraForward);
        skyMaterial.uniforms.uCameraRight.value.copy(cameraRight);
        skyMaterial.uniforms.uCameraUp.value.copy(cameraUp);
        skyMaterial.uniforms.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
        skyMaterial.uniforms.uAspect.value = camera.aspect;
        skyMaterial.uniforms.uBelowHorizonMix.value = THREE.MathUtils.clamp((camera.position.y - 25) / 80, 0, 1);
        skyMaterial.uniforms.uHorizonY.value = projectedHorizonY;
        skyMaterial.uniforms.uSmallStripHeight.value = SKY_SMALL_STRIP_HEIGHT;
        skyMaterial.uniforms.uHorizonStrength.value = 1.0;
        skyMaterial.uniforms.uLowerBandEndY.value = lowerBandEndY;
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
      if (skyMaterial?.uniforms) {
        skyMaterial.uniforms.uSkyTop.value.copy(skyTopColor);
        skyMaterial.uniforms.uSkyBottom.value.copy(skyBottomColor);
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

      lodUpdateAccumulatorRef.current += dt;
      const lodState = lodUpdateStateRef.current;
      const drawDistance = uiStateRef.current.drawDistance;
      const renderingDistance = effectiveFarClip;
      const showLods = uiStateRef.current.showLods;
      const forceLodOnly = uiStateRef.current.forceLodOnly;
      const showTobjs = uiStateRef.current.showTobjs;

      const configChanged = (
        lodState.lastDrawDistance !== drawDistance
        || lodState.lastRenderingDistance !== renderingDistance
        || lodState.lastShowLods !== showLods
        || lodState.lastForceLodOnly !== forceLodOnly
        || lodState.lastShowTobjs !== showTobjs
      );
      if (configChanged) {
        lodState.lastDrawDistance = drawDistance;
        lodState.lastRenderingDistance = renderingDistance;
        lodState.lastShowLods = showLods;
        lodState.lastForceLodOnly = forceLodOnly;
        lodState.lastShowTobjs = showTobjs;
        lodState.needsRefresh = true;
      }

      const knownCameraPos = Number.isFinite(lodState.lastCameraPos.x)
        && Number.isFinite(lodState.lastCameraPos.y)
        && Number.isFinite(lodState.lastCameraPos.z);
      if (!knownCameraPos || camera.position.distanceToSquared(lodState.lastCameraPos) > 9) {
        lodState.lastCameraPos.copy(camera.position);
        lodState.needsRefresh = true;
      }

      const knownCameraQuat = Number.isFinite(lodState.lastCameraQuat.x)
        && Number.isFinite(lodState.lastCameraQuat.y)
        && Number.isFinite(lodState.lastCameraQuat.z)
        && Number.isFinite(lodState.lastCameraQuat.w);
      const cameraQuatDot = knownCameraQuat ? Math.abs(camera.quaternion.dot(lodState.lastCameraQuat)) : 0;
      if (!knownCameraQuat || cameraQuatDot < 0.99995) {
        lodState.lastCameraQuat.copy(camera.quaternion);
        lodState.needsRefresh = true;
      }

      const projectionChanged = (
        Math.abs((lodState.lastCameraAspect ?? 0) - camera.aspect) > 1e-6
        || Math.abs((lodState.lastCameraFov ?? 0) - camera.fov) > 1e-6
        || Math.abs((lodState.lastCameraNear ?? 0) - camera.near) > 1e-6
        || Math.abs((lodState.lastCameraFar ?? 0) - camera.far) > 1e-6
      );
      if (projectionChanged) {
        lodState.lastCameraAspect = camera.aspect;
        lodState.lastCameraFov = camera.fov;
        lodState.lastCameraNear = camera.near;
        lodState.lastCameraFar = camera.far;
        lodState.needsRefresh = true;
      }

      const needsFadeTick = activeFadeCountRef.current > 0;
      if ((lodState.needsRefresh || needsFadeTick) && lodUpdateAccumulatorRef.current >= 0.02) {
        lodUpdateAccumulatorRef.current = 0;
        const distanceFadeConfig = DISTANCE_FADE_DEFAULTS;
        const fadeEpsilon = RenderEntityController.getEpsilon(distanceFadeConfig);
        const frameVisibility = resetFrameVisibilityResult(frameVisibilityRef.current);
        const chunkActiveDist = renderingDistance + CHUNK_ACTIVE_MARGIN;
        const chunkActiveDistSq = chunkActiveDist * chunkActiveDist;
        const chunkFrustum = chunkFrustumRef.current;
        const chunkProjScreenMatrix = chunkProjScreenMatrixRef.current;
        chunkProjScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        chunkFrustum.setFromProjectionMatrix(chunkProjScreenMatrix);
        const dirtyBatches = new Set();
        let activeChunks = 0;
        let frustumChunks = 0;
        let activeItems = 0;
        let visibleNear = 0;
        let visibleLod = 0;
        let activeFades = 0;
        for (const chunk of renderChunksRef.current) {
          const chunkInRange = camera.position.distanceToSquared(chunk.center) <= chunkActiveDistSq;
          const chunkInFrustum = chunkInRange && (
            chunk.boundingBox?.isBox3
              ? chunkFrustum.intersectsBox(chunk.boundingBox)
              : chunkFrustum.intersectsSphere(chunk.boundingSphere)
          );
          if (chunkInRange) frustumChunks += chunkInFrustum ? 1 : 0;
          if (!chunkInFrustum) {
            if (chunk.active) {
              chunk.active = false;
              for (const item of chunk.items) {
                hideRenderItemCompletely(item, dirtyBatches);
              }
            }
            continue;
          }

          chunk.active = true;
          activeChunks += 1;
          activeItems += chunk.items.length;
          addVisibleChunk(frameVisibility, chunk);
          for (const emitter of chunk.coronaEmitters) addCoronaCandidate(frameVisibility, emitter);
          for (const emitter of chunk.shadowEmitters) addShadowCandidate(frameVisibility, emitter);
          for (const item of chunk.items) {
            const distSq = camera.position.distanceToSquared(item.anchor);
            const hasNear = hasNearRenderable(item);
            const hasLod = hasLodRenderable(item);
            const tobjAllowed = !item.isTobj || showTobjs;
            const dist = Math.sqrt(distSq);
            if (!tobjAllowed || !RenderEntityController.isWithinDrawDistance(dist, renderingDistance, distanceFadeConfig)) {
              hideRenderItemCompletely(item, dirtyBatches);
              continue;
            }

            const pairedItem = hasNear && hasLod;
            const nearConfiguredDistance = resolveRenderableDistance(
              item.nearState?.drawDistance,
              showLods ? drawDistance : renderingDistance,
            );
            const nearEndDistance = Math.min(nearConfiguredDistance, renderingDistance);
            const lodEndDistance = Math.min(
              resolveRenderableDistance(item.lodState?.drawDistance, renderingDistance),
              renderingDistance,
            );

            let nearShouldShow = false;
            let lodShouldShow = false;
            let nearOpacity = 0;
            let lodOpacity = 0;

            if (pairedItem && showLods && !forceLodOnly) {
              const nearCoreRange = dist <= drawDistance;
              const nearFadeRange = RenderEntityController.isWithinDrawDistance(dist, drawDistance, distanceFadeConfig);
              const lodVisibleRange = RenderEntityController.isWithinDrawDistance(dist, lodEndDistance, distanceFadeConfig);

              if (item.nearState) {
                nearOpacity = RenderEntityController.updateFade(item.nearState, {
                  targetVisible: nearFadeRange,
                  distance: dist,
                  drawDistance,
                  dt,
                  config: distanceFadeConfig,
                });
              }
              if (item.lodState) {
                lodOpacity = RenderEntityController.updateFade(item.lodState, {
                  targetVisible: lodVisibleRange,
                  distance: dist,
                  drawDistance: lodEndDistance,
                  dt,
                  config: distanceFadeConfig,
                });
              }

              const nearStreamAlpha = item.nearState?.streamAlpha ?? 1;
              if (nearCoreRange) {
                lodOpacity = lodVisibleRange
                  ? clamp01((nearStreamAlpha < (1 - fadeEpsilon) ? 1 : 0) * lodOpacity)
                  : 0;
              }
              nearShouldShow = nearOpacity > fadeEpsilon;
              lodShouldShow = lodOpacity > fadeEpsilon;
            } else {
              nearShouldShow = hasNear
                && !forceLodOnly
                && RenderEntityController.isWithinDrawDistance(dist, nearEndDistance, distanceFadeConfig);
              const lodShouldShowBase = hasLod
                && (
                  forceLodOnly
                  || (!showLods && !hasNear)
                  || (showLods && (!hasNear || dist > drawDistance))
                );

              if (item.nearState) {
                nearOpacity = RenderEntityController.updateFade(item.nearState, {
                  targetVisible: nearShouldShow,
                  distance: dist,
                  drawDistance: nearEndDistance,
                  dt,
                  config: distanceFadeConfig,
                });
              }

              lodShouldShow = hasLod
                && RenderEntityController.isWithinDrawDistance(dist, lodEndDistance, distanceFadeConfig)
                && lodShouldShowBase;
              if (item.lodState) {
                lodOpacity = RenderEntityController.updateFade(item.lodState, {
                  targetVisible: lodShouldShow,
                  distance: dist,
                  drawDistance: lodEndDistance,
                  dt,
                  config: distanceFadeConfig,
                });
              }
            }

            item.mode = nearOpacity > fadeEpsilon
              ? (lodOpacity > fadeEpsilon ? 'near+lod' : 'near')
              : (lodOpacity > fadeEpsilon ? 'lod' : 'hidden');

            if (nearOpacity > fadeEpsilon) visibleNear += 1;
            if (lodOpacity > fadeEpsilon) visibleLod += 1;

            applyRenderSideOpacity(item, 'near', nearOpacity, dirtyBatches);
            applyRenderSideOpacity(item, 'lod', lodOpacity, dirtyBatches);
            collectRenderSideFrameVisibility(frameVisibility, item, 'near');
            collectRenderSideFrameVisibility(frameVisibility, item, 'lod');

            if (
              (nearOpacity > fadeEpsilon && nearOpacity < (1 - fadeEpsilon))
              || (lodOpacity > fadeEpsilon && lodOpacity < (1 - fadeEpsilon))
              || (nearShouldShow && (item.nearState?.streamAlpha ?? 1) < (1 - fadeEpsilon))
              || (lodShouldShow && (item.lodState?.streamAlpha ?? 1) < (1 - fadeEpsilon))
              || (!nearShouldShow && (item.nearState?.streamAlpha ?? 0) > fadeEpsilon)
              || (!lodShouldShow && (item.lodState?.streamAlpha ?? 0) > fadeEpsilon)
            ) {
              activeFades += 1;
            }
          }
        }
        for (const batch of dirtyBatches) {
          batch.mesh.instanceMatrix.needsUpdate = true;
          batch.mesh.boundingBox = null;
          batch.mesh.boundingSphere = null;
        }
        renderMetricsRef.current = {
          ...renderMetricsRef.current,
          activeChunks,
          frustumChunks,
          activeItems,
          visibleNear,
          visibleLod,
          visibleQueueMeshes: frameVisibility.visibleQueueMeshes.length,
          coronaCandidates: frameVisibility.coronaCandidates.length,
          shadowCandidates: frameVisibility.shadowCandidates.length,
        };
        frameVisibility.computed = true;
        activeFadeCountRef.current = activeFades;
        lodState.needsRefresh = activeFades > 0;
      }

      grid.visible = uiStateRef.current.showGrid;
      axes.visible = uiStateRef.current.showAxes;
      if (lastWireframeRef.current !== uiStateRef.current.wireframe) {
        applyWireframe(worldRootRef.current, uiStateRef.current.wireframe);
        jsrwSessionRef.current.getWaterRuntime()?.setWireframe(uiStateRef.current.wireframe);
        lastWireframeRef.current = uiStateRef.current.wireframe;
      }
      if (lastDisableVertexColorRef.current !== uiStateRef.current.disableVertexColor) {
        applyDisableVertexColor(worldRootRef.current, uiStateRef.current.disableVertexColor);
        lastDisableVertexColorRef.current = uiStateRef.current.disableVertexColor;
      }
      if (lastDisableBackfaceCullingRef.current !== uiStateRef.current.disableBackfaceCulling) {
        applyGlobalBackfaceCulling(worldRootRef.current, uiStateRef.current.disableBackfaceCulling);
        lastDisableBackfaceCullingRef.current = uiStateRef.current.disableBackfaceCulling;
      }
      if (lastRenderWaterRef.current !== uiStateRef.current.renderWater) {
        jsrwSessionRef.current.getWaterRuntime()?.setEnabled(uiStateRef.current.renderWater);
        lastRenderWaterRef.current = uiStateRef.current.renderWater;
      }

      const pipelineRuntimeContext = {
        activeBackend,
        worldGameVersion: worldGameVersionRef.current,
        distanceFade: DISTANCE_FADE_DEFAULTS,
        postFxDebugCapture: isWindowOpen('rendering'),
        timecycleCurrent,
        ambientColor: timecycleCurrent?.values?.ambient
          ? toThreeColorFromTimecycleValue(timecycleCurrent.values.ambient)
          : RW_PIPELINE_FALLBACK_AMBIENT,
        emissiveColor: timecycleCurrent?.values?.ambientBl
          ? toThreeColorFromTimecycleValue(timecycleCurrent.values.ambientBl)
          : RW_PIPELINE_FALLBACK_EMISSIVE,
        fallbackAmbient: RW_PIPELINE_FALLBACK_AMBIENT,
        fallbackEmissive: RW_PIPELINE_FALLBACK_EMISSIVE,
        fogColor: timecycleCurrent?.three?.fogColor?.isColor ? timecycleCurrent.three.fogColor : null,
        fogStart: Number.isFinite(timecycleCurrent?.values?.fogStart) ? timecycleCurrent.values.fogStart : null,
        fogEnd: Number.isFinite(timecycleCurrent?.values?.farClip) ? timecycleCurrent.values.farClip : null,
      };
      jsrwSessionRef.current.setBackend(activeBackend);
      jsrwSessionRef.current.setSelection(uiStateRef.current.pipelineDebug);
      const pipelineSelectionSignature = getPipelineSelectionSignature(
        uiStateRef.current.pipelineDebug,
        activeBackend,
        worldGameVersionRef.current,
      );
      if (pipelineSelectionSignature !== lastPipelineSelectionSignatureRef.current) {
        jsrwSessionRef.current.applyToRoot(worldRootRef.current, pipelineRuntimeContext);
        applyWireframe(worldRootRef.current, uiStateRef.current.wireframe);
        applyDisableVertexColor(worldRootRef.current, uiStateRef.current.disableVertexColor);
        applyGlobalBackfaceCulling(worldRootRef.current, uiStateRef.current.disableBackfaceCulling);
        lastPipelineSelectionSignatureRef.current = pipelineSelectionSignature;
        rwRenderQueueRef.current?.markDirty();
        jsrwSessionRef.current.getCoronaRuntime()?.markOccludersDirty?.();
        jsrwSessionRef.current.getShadowRuntime()?.markSceneMeshesDirty?.();
      } else {
        jsrwSessionRef.current.updateRuntime(pipelineRuntimeContext);
      }

      if (!renderResourcesReadyRef.current) {
        renderer.setRenderTarget(null);
        renderer.autoClear = true;
        renderer.setClearColor(DEFAULT_SCENE_BACKGROUND, 1);
        renderer.clear(true, true, true);
        renderer.autoClear = true;
      } else {

        const waterPipeline = jsrwSessionRef.current.getWaterRuntime();
        const coronaRuntime = jsrwSessionRef.current.getCoronaRuntime();
        const shadowRuntime = jsrwSessionRef.current.getShadowRuntime();
        const frameVisibility = frameVisibilityRef.current;
        const renderStages = uiStateRef.current.renderStages || FRAME_STAGE_DEBUG_DEFAULTS;
        coronaRuntime?.setEnabled(uiStateRef.current.render2dfx);
        shadowRuntime?.setEnabled(uiStateRef.current.render2dfx && uiStateRef.current.shadows.enabled);
        coronaRuntime?.setDebugShowAll(uiStateRef.current.debug2dfx);
        waterPipeline?.applySettings({
          uvSpeed: uiStateRef.current.waterUvSpeed,
          waveHeight: uiStateRef.current.waterWaveHeight,
          farAlpha: uiStateRef.current.waterAlpha,
        });
        coronaRuntime?.setViewport(viewportWidth, viewportHeight);
        coronaRuntime?.update(camera, {
          ...pipelineRuntimeContext,
          frameVisibility,
          timeMs: time,
          dt,
          viewportWidth,
          viewportHeight,
          forceRender2dfx: uiStateRef.current.forceRender2dfx,
          twoDfx: uiStateRef.current.twoDfx,
          trafficLights: uiStateRef.current.trafficLights,
        });
        shadowRuntime?.update(camera, {
          ...pipelineRuntimeContext,
          frameVisibility,
          timeMs: time,
          dt,
          viewportWidth,
          viewportHeight,
          forceRender2dfx: uiStateRef.current.forceRender2dfx,
          trafficLights: uiStateRef.current.trafficLights,
          shadows: uiStateRef.current.shadows,
        });
        const skyScene = skySceneRef.current;
        const skyCamera = skyCameraRef.current;
        const skyCloudScene = skyCloudSceneRef.current;
        const farBackgroundColor = skyBottomColor;
        try {
          const rwRenderQueue = rwRenderQueueRef.current;
          const postFxSceneTarget = renderStages.postFx
            ? jsrwSessionRef.current.beginPostFxSceneCapture({
              ...pipelineRuntimeContext,
              viewportWidth,
              viewportHeight,
            })
            : null;
          rwRenderQueue?.prepareFrame(camera, frameVisibility);
          const queueStats = rwRenderQueue?.debugStats || {};
          const hasBlendQueue = (queueStats.transparentCount || 0) > 0;
          const hasAdditiveQueue = (queueStats.additiveCount || 0) > 0;
          const hasOverlayQueue = (queueStats.overlayCount || 0) > 0;
          const transparentBuckets = [];
          if (renderStages.sceneTransparent && renderStages.sceneBlend && hasBlendQueue) transparentBuckets.push('transparent');
          if (renderStages.sceneTransparent && renderStages.sceneAdditive && hasAdditiveQueue) transparentBuckets.push('additive');
          if (renderStages.sceneTransparent && renderStages.sceneOverlay && hasOverlayQueue) transparentBuckets.push('overlay');
          renderer.setRenderTarget(postFxSceneTarget);
          renderer.autoClear = true;
          if (renderStages.skyDome && skyScene && skyCamera) {
            renderer.render(skyScene, skyCamera);
          } else {
            renderer.setClearColor(farBackgroundColor, 1);
            renderer.clear(true, true, true);
          }
          renderer.autoClear = false;
          renderer.clearDepth();
          if (renderStages.skyBackdrop) {
            skyFeature?.renderBackground(renderer);
          }
          if (renderStages.skyClouds && skyCloudScene) {
            renderer.render(skyCloudScene, camera);
            renderer.clearDepth();
          }
          if (waterPipeline?.hasRenderableWater() && uiStateRef.current.renderWater) {
            let waterStage = 'update';
            try {
              waterPipeline.update(camera, time, dt);

              if (renderStages.sceneOpaque) {
                waterStage = 'renderSceneOpaque';
                rwRenderQueue?.renderOpaque(renderer, camera, {
                  allowedBuckets: ['opaque', 'cutout'],
                  fog: scene.fog || null,
                });
              }

              if (renderStages.waterFar) {
                waterStage = 'renderFar';
                waterPipeline.renderFar(renderer, camera, null);
              }

              if (renderStages.waterNear) {
                waterStage = 'renderNear';
                waterPipeline.renderNear(renderer, camera);
              }

              if (renderStages.waterWavy) {
                waterStage = 'renderWavy';
                waterPipeline.renderWavy(renderer, camera);
              }

              if (renderStages.waterWake) {
                waterStage = 'renderWake';
                waterPipeline.renderWake(renderer, camera);
              }

              if (transparentBuckets.length > 0) {
                waterStage = 'renderSceneTransparent';
                rwRenderQueue?.renderTransparent(renderer, camera, {
                  allowedBuckets: transparentBuckets,
                  fog: scene.fog || null,
                });
              }
              if (renderStages.coronas) {
                coronaRuntime?.render(renderer, camera);
              }
              renderer.autoClear = true;
            } catch (waterError) {
              rwRenderQueue?.popCameraBucketMask(camera);
              rwRenderQueue?.popCameraBucketMask(camera);
              console.error('Water pipeline runtime error:', waterError);
              const farPos = waterPipeline?.farMesh?.geometry?.getAttribute?.('position')?.array?.byteLength ?? 'missing';
              const farUv = waterPipeline?.farMesh?.geometry?.getAttribute?.('uv')?.array?.byteLength ?? 'missing';
              const farIndex = waterPipeline?.farMesh?.geometry?.index?.array?.byteLength ?? 'missing';
              const nearPos = waterPipeline?.nearMesh?.geometry?.getAttribute?.('position')?.array?.byteLength ?? 'missing';
              const nearUv = waterPipeline?.nearMesh?.geometry?.getAttribute?.('uv')?.array?.byteLength ?? 'missing';
              const nearIndex = waterPipeline?.nearMesh?.geometry?.index?.array?.byteLength ?? 'missing';
              const nearNormal = waterPipeline?.nearMesh?.geometry?.getAttribute?.('normal')?.array?.byteLength ?? 'missing';
              const wakePos = waterPipeline?.wakeMesh?.geometry?.getAttribute?.('position')?.array?.byteLength ?? 'missing';
              pushConsoleLine('error', `Water runtime error @ ${waterStage}: ${formatConsoleArg(waterError)}`);
              pushConsoleLine(
                'error',
                `Water buffers: far.pos=${farPos} far.uv=${farUv} far.idx=${farIndex} near.pos=${nearPos} near.uv=${nearUv} near.idx=${nearIndex} near.normal=${nearNormal} wake.pos=${wakePos}`,
              );
              setStatus(`Water runtime error @ ${waterStage}: ${formatConsoleArg(waterError)}. Water disabled.`);
              jsrwSessionRef.current.disposeWaterRuntime();
              renderer.autoClear = false;
              const fallbackBuckets = [];
              if (renderStages.sceneOpaque) fallbackBuckets.push('opaque', 'cutout');
              fallbackBuckets.push(...transparentBuckets);
              if (fallbackBuckets.length > 0) {
                const opaqueBuckets = fallbackBuckets.filter((bucket) => bucket === 'opaque' || bucket === 'cutout');
                const transparentFallbackBuckets = fallbackBuckets.filter((bucket) => bucket !== 'opaque' && bucket !== 'cutout');
                if (opaqueBuckets.length > 0) {
                  rwRenderQueue?.renderOpaque(renderer, camera, {
                    allowedBuckets: opaqueBuckets,
                    fog: scene.fog || null,
                  });
                }
                if (transparentFallbackBuckets.length > 0) {
                  rwRenderQueue?.renderTransparent(renderer, camera, {
                    allowedBuckets: transparentFallbackBuckets,
                    fog: scene.fog || null,
                  });
                }
              }
              if (renderStages.coronas) {
                coronaRuntime?.render(renderer, camera);
              }
            }
          } else {
            renderer.autoClear = false;
            const sceneBuckets = [];
            if (renderStages.sceneOpaque) sceneBuckets.push('opaque', 'cutout');
            sceneBuckets.push(...transparentBuckets);
            if (sceneBuckets.length > 0) {
              const opaqueBuckets = sceneBuckets.filter((bucket) => bucket === 'opaque' || bucket === 'cutout');
              const transparentSceneBuckets = sceneBuckets.filter((bucket) => bucket !== 'opaque' && bucket !== 'cutout');
              if (opaqueBuckets.length > 0) {
                rwRenderQueue?.renderOpaque(renderer, camera, {
                  allowedBuckets: opaqueBuckets,
                  fog: scene.fog || null,
                });
              }
              if (transparentSceneBuckets.length > 0) {
                rwRenderQueue?.renderTransparent(renderer, camera, {
                  allowedBuckets: transparentSceneBuckets,
                  fog: scene.fog || null,
                });
              }
            }
            if (renderStages.coronas) {
              coronaRuntime?.render(renderer, camera);
            }
          }
          if (postFxSceneTarget && postFxSunCoronaEnabled && renderStages.sunBloom) {
            renderer.clearDepth();
            skyFeature?.renderSun(renderer, { mode: 'bloom' });
          }
          renderer.setRenderTarget(null);
          if (postFxSceneTarget) {
            jsrwSessionRef.current.renderPostFx(renderer, {
              ...pipelineRuntimeContext,
              viewportWidth,
              viewportHeight,
            });
          }
          if (renderStages.sunFinal) {
            renderer.clearDepth();
            skyFeature?.renderSun(renderer, { mode: 'full' });
          }

          const activeIcon = uiStateRef.current.gameVersion === 'SA' ? 'SA' : 'VCS';
          gameIconSprite.material.map = iconTextures[activeIcon];
          gameIconSprite.visible = showGameIconRef.current;
          const iconPx = 80;
          const padXPx = 20;
          const padYPx = 56;
          gameIconSprite.position.set(
            1 - ((2 * padXPx) / viewportWidth),
            1 - ((2 * padYPx) / viewportHeight),
            0,
          );
          gameIconSprite.scale.set(
            (2 * iconPx) / viewportWidth,
            (2 * iconPx) / viewportHeight,
            1,
          );
          if (renderStages.hud) {
            renderer.autoClear = false;
            renderer.clearDepth();
            renderer.render(hudScene, hudCamera);
            renderer.autoClear = true;
          }
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
        renderMetricsRef.current = {
          ...renderMetricsRef.current,
          transparentQueue: rwRenderQueueRef.current?.debugStats?.transparentCount ?? 0,
          additiveQueue: rwRenderQueueRef.current?.debugStats?.additiveCount ?? 0,
          overlayQueue: rwRenderQueueRef.current?.debugStats?.overlayCount ?? 0,
          drawCalls: renderer.info?.render?.calls ?? 0,
          triangles: renderer.info?.render?.triangles ?? 0,
        };
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
            if (ImGui.MenuItem('Load map')) {
              openMapPicker('imgui');
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
          try {
            ImGui.SetNextWindowPos(new Vec2(460, 270), ImGui.Cond.Once);
            ImGui.SetNextWindowSize(new Vec2(360, 180), ImGui.Cond.Once);
            ImGui.Begin(
              'Statistics',
              (value = isWindowOpen('statistics')) => setWindowOpen('statistics', value),
            );
            const fpsValues = fpsHistoryRef.current;
            let fpsMin = Number.POSITIVE_INFINITY;
            let fpsMax = 0;
            let fpsSum = 0;
            let fpsCount = 0;
            for (let i = 0; i < fpsValues.length; i += 1) {
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
            const renderMetrics = renderMetricsRef.current;
            ImGui.Text(`FPS: ${fpsCurrent.toFixed(1)} | avg ${fpsAvg.toFixed(1)} | min ${fpsCount > 0 ? fpsMin.toFixed(1) : '0.0'} | max ${fpsMax.toFixed(1)}`);
            ImGui.Text(`Draw Calls: ${renderMetrics.drawCalls}`);
            ImGui.Text(`Triangles: ${renderMetrics.triangles}`);
            ImGui.Text(`Chunks: ${renderMetrics.frustumChunks}/${statsRef.current.totalChunks}`);
            ImGui.Text(`Active Items: ${renderMetrics.activeItems}`);
            ImGui.Text(`Visible: near ${renderMetrics.visibleNear} | lod ${renderMetrics.visibleLod}`);
            ImGui.Text(`Transparent Queue: blend ${renderMetrics.transparentQueue} | add ${renderMetrics.additiveQueue} | overlay ${renderMetrics.overlayQueue}`);
            ImGui.Text(`Instancing: batches ${statsRef.current.instancedBatches} | placements ${statsRef.current.instancedItems}`);
            ImGui.Text(`Lighting: IDE 2DFX ${statsRef.current.ideEffects} | objects ${statsRef.current.lightObjects} | emitters ${statsRef.current.lightEmitters}`);
            ImGui.Text('FPS Graph');
            const fpsPlotValues = Array.from({ length: fpsValues.length }, (_, i) => {
              const idx = (fpsHistoryIndexRef.current + i) % fpsValues.length;
              const value = fpsValues[idx];
              return value > 0 ? value : fpsCurrent;
            });
            const fpsPlotMin = fpsCount > 0 ? Math.max(0, fpsMin * 0.9) : 0;
            const fpsPlotMax = Math.max(fpsPlotMin + 1, fpsMax * 1.1, fpsAvg * 1.1, fpsCurrent * 1.1, 60);
            ImGui.PlotLines(
              '##fps-plot',
              (values = fpsPlotValues, idx) => values[idx],
              fpsPlotValues,
              fpsPlotValues.length,
              0,
              '',
              fpsPlotMin,
              fpsPlotMax,
              new Vec2(-1, 120),
            );
            ImGui.End();
          } catch (error) {
            pushConsoleLine('error', `Statistics window error: ${formatConsoleArg(error)}`);
            setWindowOpen('statistics', false);
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
          ImGui_Impl.Shutdown();
          ImGui.DestroyContext();
        } catch {
          // Ignore context teardown errors during app shutdown.
        }
        imguiRef.current = { ImGui: null, ImGui_Impl: null, ready: false };
        imguiCaptureRef.current = { mouse: false, keyboard: false };
      }
      backendSwitchingRef.current = true;
      playerModeManager.destroy();
      orbitControls.dispose();

      if (renderer && typeof renderer.dispose === 'function') renderer.dispose();
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
      jsrwSessionRef.current.dispose();
      disposeWorld(worldRoot);
    };
  }, [
    activeBackend,
    applyRenderSideOpacity,
    clearWorld,
    hasLodRenderable,
    hasNearRenderable,
    hideRenderItemCompletely,
    isWindowOpen,
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
