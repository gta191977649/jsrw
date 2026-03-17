import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { DFFLoader, TXDLoader } from './lib/jsrw';
import { playerController as createExternalPlayerController } from 'three-player-controller';
import { formatConsoleArg } from './lib/console';
import { buildFileIndex } from './lib/fileIndex';
import { WORLD_UP, gtaPlacementQuaternionToThree, gtaPositionToThree } from './lib/gtaTransforms';
import { normalizePath, parseGtaDat, parseIde, parseIpl } from './lib/gtaParsers';
import { parseTimecyc, sampleTimecyc, TIMECYCLE_FIELD_GROUPS, VCS_WEATHER_NAMES } from './lib/Timecycle';
import { IMGParser } from './lib/imgArchive';
import { buildLodMapping, isLodModel } from './lib/lod';
import { PlayerControllerAdapter } from './lib/playerControllerAdapter';
import { APP_MODE_EDITOR, APP_MODE_TEST, PlayerModeManager } from './lib/PlayerModeManager';
import {
  cloneRWMaterialDescriptor,
  createThreeMaterialFromRW,
  getRWMaterialDescriptor,
  applyDisableVertexColor,
  normalizeTextureDictionary,
  prepareTobjInstanceMaterials,
  toRWMaterial,
  tuneTransparentMaterial,
} from './lib/RWRender';
import RWPipelineController from './lib/RWPipelineController';
import {
  RW_PIPELINE_CATEGORY,
  RW_PIPELINE_PLATFORM,
  RW_PIPELINE_SELECTION_DEFAULTS,
  cloneRWPipelineSelections,
  createRWPipelineMaterialForProfile,
  getRWPipelineGameOptions,
  getRWPipelinePlatformOptions,
  resolveRWPipelineSelection,
} from './lib/rwPipelineProfiles';
import { RWRenderQueue } from './lib/RWRenderQueue';
import { RWWaterPipeline } from './lib/RWWaterPipeline';
import { RW_MOON_DEBUG_DEFAULTS } from './lib/RWMoonConstants';
import { RWMoonPipeline } from './lib/RWMoonPipeline';
import { RW_STARS_DEBUG_DEFAULTS } from './lib/RWStarsConstants';
import { RWStarsPipeline } from './lib/RWStarsPipeline';
import { RW_SUN_DEBUG_DEFAULTS } from './lib/RWSunConstants';
import { RWSunPipeline } from './lib/RWSunPipeline';
import { applyRwIdeFlagsToInstance, decodeRwIdeFlags } from './lib/rwFlags';
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
import { getWaterConfig, parseWaterproDat } from './lib/waterpro';
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
const ENABLE_WORLD_INSTANCING = true;
const STREAMING_BUILD_PLACEMENT_BUDGET = 8;
const STREAMING_BUILD_FRAME_BUDGET_MS = 8;
const RW_DISTANCE_FADE_WINDOW = 20;
const RW_STREAM_ALPHA_PER_SECOND = 3.2;
const RW_FADE_EPSILON = 0.001;
const HIDDEN_INSTANCE_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
const SKY_SMALL_STRIP_HEIGHT = 4 / 400;
const SKY_HORIZON_STRIP_HEIGHT = 48 / 400;
const SKY_DEFAULT_TOP = DEFAULT_SCENE_BACKGROUND.clone().offsetHSL(0, 0, -0.08);
const SKY_DEFAULT_BOTTOM = DEFAULT_SCENE_BACKGROUND.clone();
const SKY_DEFAULT_FOG = DEFAULT_SCENE_BACKGROUND.clone();
const RW_PIPELINE_FALLBACK_AMBIENT = new THREE.Color(1, 1, 1);
const RW_PIPELINE_FALLBACK_EMISSIVE = new THREE.Color(0, 0, 0);
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

function clamp01(value) {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function computeSunLightIntensityFromState(sunState) {
  const sunElevation = Number(sunState?.gtaDirection?.z);
  if (!Number.isFinite(sunElevation)) return 0.8;
  const daylight = Math.sqrt(clamp01((sunElevation + 0.2) / 0.8));
  return THREE.MathUtils.lerp(0.15, 0.8, daylight);
}

function computeSunLightsMultFromState(sunState) {
  const bloomAlpha = clamp01(Number(sunState?.bigBloomFadeAlpha) || 0);
  return THREE.MathUtils.lerp(1.0, 0.72, bloomAlpha);
}

function computeSkyLightMultFromLightsMult(lightsMult) {
  const safeLightsMult = Math.max(0.35, Number(lightsMult) || 1);
  return (1 / safeLightsMult + 3) * 0.25;
}

function approachValue(current, target, delta) {
  if (current < target) return Math.min(current + delta, target);
  if (current > target) return Math.max(current - delta, target);
  return current;
}

function resolveRenderableDistance(value, fallback) {
  if (Number.isFinite(value) && value > 0) return value;
  return fallback;
}

function computeDistanceFadeAlpha(distance, endDistance) {
  if (!Number.isFinite(endDistance) || endDistance <= 0) return 1;
  if (distance <= endDistance) return 1;
  return clamp01((endDistance + RW_DISTANCE_FADE_WINDOW - distance) / RW_DISTANCE_FADE_WINDOW);
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
  const moonPipelineRef = useRef(null);
  const starsPipelineRef = useRef(null);
  const sunPipelineRef = useRef(null);
  const sunLightRef = useRef(null);
  const hemiLightRef = useRef(null);
  const worldRootRef = useRef(new THREE.Group());
  const rwRenderQueueRef = useRef(null);
  const rwWaterPipelineRef = useRef(null);
  const renderItemsRef = useRef([]);
  const renderChunksRef = useRef([]);
  const renderMetricsRef = useRef({
    activeChunks: 0,
    frustumChunks: 0,
    activeItems: 0,
    visibleNear: 0,
    visibleLod: 0,
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
  const rwPipelineControllerRef = useRef(new RWPipelineController());
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
    pipelineDebug: cloneRWPipelineSelections(RW_PIPELINE_SELECTION_DEFAULTS),
    appMode: APP_MODE_EDITOR,
    backendSelection: 'WebGL',
    windows: Object.fromEntries(WINDOW_DEFS.map((item) => [item.key, item.defaultVisible])),
  });
  const lastWireframeRef = useRef(false);
  const lastDisableVertexColorRef = useRef(false);
  const lastDisableBackfaceCullingRef = useRef(true);
  const lastRenderWaterRef = useRef(true);

  const [status, setStatus] = useState('Select an extracted GTA folder to begin.');
  const [activeBackend, setActiveBackend] = useState('WebGL');
  const [buildProgress, setBuildProgress] = useState({ active: false, current: 0, total: 0 });
  const [showGameIcon, setShowGameIcon] = useState(false);
  const [stats, setStats] = useState({
    files: 0,
    ideFiles: 0,
    iplFiles: 0,
    ideDefs: 0,
    iplInst: 0,
    loaded: 0,
    failed: 0,
    unresolved: 0,
    nearOnly: 0,
    totalChunks: 0,
    instancedBatches: 0,
    instancedItems: 0,
    queuedChunks: 0,
    readyChunks: 0,
  });
  const [consoleLines, setConsoleLines] = useState([]);
  const [failedModels, setFailedModels] = useState([]);
  const [loadedFiles, setLoadedFiles] = useState([]);
  const [selectedObject, setSelectedObject] = useState(null);
  const [selectedTextureDetail, setSelectedTextureDetail] = useState(null);
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
    const normalizedPath = normalizePath(String(path || '').trim());
    const normalizedDetail = String(detail || '').trim();
    if (!normalizedKind || !normalizedPath) return;
    setLoadedFiles((prev) => {
      const index = prev.findIndex((entry) => (
        entry.kind === normalizedKind
        && entry.path === normalizedPath
      ));
      if (index === -1) {
        return [...prev, { kind: normalizedKind, path: normalizedPath, detail: normalizedDetail }];
      }
      if (prev[index].detail === normalizedDetail) return prev;
      const next = [...prev];
      next[index] = { ...next[index], detail: normalizedDetail };
      return next;
    });
  }, []);

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
    rwWaterPipelineRef.current?.dispose();
    rwWaterPipelineRef.current = null;
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
    worldGameVersionRef.current = String(uiStateRef.current.gameVersion || 'VCS').toUpperCase();
    rwPipelineControllerRef.current.setRoot(worldRoot);
    rwPipelineControllerRef.current.applyToRoot(worldRoot, {
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
    setBuildProgress({ active: false, current: 0, total: 0 });
    setStats((prev) => ({
      ...prev,
      loaded: 0,
      failed: 0,
      unresolved: 0,
      nearOnly: 0,
      totalChunks: 0,
      instancedBatches: 0,
      instancedItems: 0,
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

    try {
      clearWorld();
      worldGameVersionRef.current = buildGameVersion;
      setLoadedFiles([]);
      setFailedModels([]);
      setShowGameIcon(false);
      setStatus('Parsing gta.dat, IDE and IPL...');
      pushConsoleLine('info', 'Start building world');
      await yieldToBrowser();
      const parseStartTime = performance.now();

    const trackAndResolveFile = (kind, pathHint, options = {}) => {
      const {
        declaredDetail = 'declared',
        foundDetail = 'found',
        missingDetail = 'missing',
        warnOnMissing = true,
      } = options;
      const requestedPath = normalizePath(pathHint);
      if (declaredDetail) pushLoadedFile(kind, requestedPath, declaredDetail);
      const file = fileIndex.findByPathHint(requestedPath);
      if (!file) {
        pushLoadedFile(kind, requestedPath, missingDetail);
        if (warnOnMissing) pushConsoleLine('warn', `${kind} missing: ${requestedPath}`);
        return null;
      }
      const resolvedPath = normalizePath(file.webkitRelativePath || file.name || requestedPath);
      pushLoadedFile(kind, resolvedPath, foundDetail);
      return { file, requestedPath, resolvedPath };
    };

      const gtaDatRecord = trackAndResolveFile('DAT', 'data/gta.dat', {
        declaredDetail: 'required',
        foundDetail: 'loaded',
        missingDetail: 'missing',
        warnOnMissing: false,
      });
      const gtaDatFile = gtaDatRecord?.file ?? null;
      if (!gtaDatFile) {
        setStatus('gta.dat not found in uploaded files.');
        pushConsoleLine('error', 'gta.dat not found in selected folder');
        return;
      }

      const gtaDat = parseGtaDat(await gtaDatFile.text());
      pushConsoleLine(
        'info',
        `gta.dat parsed: IDE ${gtaDat.idePaths.length}, IPL ${gtaDat.iplPaths.length}, IMG ${gtaDat.imgPaths?.length || 0}, IMAGEPATH ${gtaDat.imagePaths?.length || 0}`,
      );

      const imgParser = new IMGParser();
      const imgPaths = [];
      const imgPathSet = new Set();
      const registerImgPath = (pathHint) => {
        const normalized = String(pathHint || '').trim().replaceAll('\\', '/').toLowerCase();
        if (!normalized || imgPathSet.has(normalized)) return;
        imgPathSet.add(normalized);
        imgPaths.push(normalized);
      };
      registerImgPath('models/gta3.img');
      for (const path of gtaDat.imgPaths || []) registerImgPath(path);

      for (const imgPath of imgPaths) {
      const imgRecord = trackAndResolveFile('IMG', imgPath, {
        foundDetail: 'found',
        missingDetail: 'missing img',
      });
      if (!imgRecord) {
        continue;
      }
      const dirPath = imgPath.replace(/\.img$/i, '.dir');
      const dirRecord = trackAndResolveFile('DIR', dirPath, {
        foundDetail: 'found',
        missingDetail: 'missing dir',
        warnOnMissing: false,
      });
      if (!dirRecord) {
        pushLoadedFile('IMG', imgPath, 'missing dir');
        pushConsoleLine('warn', `IMG directory missing: ${dirPath}`);
        continue;
      }
      try {
        const parsed = await imgParser.appendArchive(imgRecord.file, dirRecord.file, imgPath);
        pushLoadedFile('IMG', imgPath, `${parsed.total} entries`);
        pushConsoleLine(
          'info',
          `IMG loaded: ${imgPath} (${parsed.total} entries${parsed.overridden > 0 ? `, override ${parsed.overridden}` : ''})`,
        );
      } catch (error) {
        pushConsoleLine('error', `IMG parse failed: ${imgPath} (${formatConsoleArg(error)})`);
      }
      }

      if ((gtaDat.imagePaths || []).length > 0) {
        for (const imagePath of gtaDat.imagePaths) {
          pushLoadedFile('IMAGEPATH', imagePath, 'ignored');
        }
        pushConsoleLine('info', 'IMAGEPATH entries are ignored. Textures are resolved by IDE TXD only.');
      }

      const ideById = new Map();
      const ideByModel = new Map();
      let parsedIdeFiles = 0;

      for (const pathHint of gtaDat.idePaths) {
      const ideRecord = trackAndResolveFile('IDE', pathHint, {
        foundDetail: 'found',
        missingDetail: 'missing',
      });
      if (!ideRecord) {
        continue;
      }
      pushConsoleLine('info', `Loading IDE: ${ideRecord.requestedPath}`);

      const parsed = parseIde(await ideRecord.file.text());
      parsedIdeFiles += 1;
      pushLoadedFile('IDE', ideRecord.resolvedPath, 'loaded');

      for (const [id, def] of parsed.byId.entries()) ideById.set(id, def);
      for (const [name, def] of parsed.byModel.entries()) ideByModel.set(name, def);
      }

      let parsedIplFiles = 0;
      const placements = [];

      for (const pathHint of gtaDat.iplPaths) {
      const iplRecord = trackAndResolveFile('IPL', pathHint, {
        foundDetail: 'found',
        missingDetail: 'missing',
      });
      if (!iplRecord) {
        continue;
      }
      pushConsoleLine('info', `Loading IPL: ${iplRecord.requestedPath}`);

      const parsed = parseIpl(await iplRecord.file.text(), { gameVersion: uiStateRef.current.gameVersion });
      const placementBaseIndex = placements.length;
      for (const placement of parsed) {
        if (Number.isInteger(placement.lod) && placement.lod >= 0) {
          placement.lod += placementBaseIndex;
        } else {
          placement.lod = -1;
        }
      }
      parsedIplFiles += 1;
      pushLoadedFile('IPL', iplRecord.resolvedPath, 'loaded');
      placements.push(...parsed);
      }
      pushConsoleLine('info', `IDE/IPL parsed in ${(performance.now() - parseStartTime).toFixed(1)} ms`);

      const timecycRecord = trackAndResolveFile('DAT', 'data/timecyc.dat', {
        declaredDetail: 'optional',
        foundDetail: 'loaded',
        missingDetail: 'missing optional',
        warnOnMissing: false,
      });
      if (timecycRecord) {
        try {
          const parsedTimecycle = parseTimecyc(await timecycRecord.file.text(), {
            gameVersion: uiStateRef.current.gameVersion,
          });
          const previousControls = timecycleStateRef.current?.controls || {};
          const weatherNames = Array.isArray(parsedTimecycle.weatherNames) && parsedTimecycle.weatherNames.length > 0
            ? parsedTimecycle.weatherNames
            : [...VCS_WEATHER_NAMES];
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
            sourcePath: timecycRecord.resolvedPath,
            data: parsedTimecycle,
            current,
            weatherNames,
            controls,
          };
          pushConsoleLine(
            'info',
            `timecyc.dat loaded: ${parsedTimecycle.hours} hours x ${weatherNames.length} weathers (${timecycRecord.resolvedPath})`,
          );
        } catch (error) {
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
          pushConsoleLine('warn', `timecyc.dat parse failed: ${formatConsoleArg(error)}`);
        }
      } else {
        pushConsoleLine('warn', 'timecyc.dat not found. Fog/timecycle disabled.');
      }

      totalObjectsRef.current = placements.length;

      setStats({
        files: fileIndex.count,
        ideFiles: parsedIdeFiles,
        iplFiles: parsedIplFiles,
        ideDefs: ideByModel.size,
        iplInst: placements.length,
        loaded: 0,
        failed: 0,
        unresolved: 0,
        nearOnly: 0,
        totalChunks: 0,
        instancedBatches: 0,
        instancedItems: 0,
      });

      const txdLoader = new TXDLoader();
      const txdMetadataByNameRef = { current: new Map() };
      if (!txdLoader.__rwMetaPatched) {
      const baseReadTextureNative = txdLoader.readTextureNative.bind(txdLoader);
      txdLoader.readTextureNative = function patchedReadTextureNative(...args) {
        const parsed = baseReadTextureNative(...args);
        if (parsed?.name) {
          txdMetadataByNameRef.current.set(String(parsed.name).toLowerCase(), {
            compression: parsed.compression,
            d3dFormat: parsed.d3dFormat,
            rasterFormat: parsed.rasterFormat,
            platformId: parsed.platformId,
            width: parsed.width,
            height: parsed.height,
            hasAlpha: parsed.hasAlpha,
          });
        }
        return parsed;
      };
      const baseParse = txdLoader.parse.bind(txdLoader);
      txdLoader.parse = function patchedParse(...args) {
        txdMetadataByNameRef.current = new Map();
        return baseParse(...args);
      };
      txdLoader.__rwMetaPatched = true;
      }
      const modelCache = new Map();
      const txdCache = new Map();
      let pendingWaterPipeline = null;

      const getTextureDict = async (txdName) => {
      if (!txdName) return null;
      if (txdCache.has(txdName)) return txdCache.get(txdName);

      try {
        const txdFromFile = fileIndex.findByBasename(`${txdName}.txd`);
        let txdBuffer = null;
        let txdSource = '';
        if (txdFromFile) {
          txdBuffer = await txdFromFile.arrayBuffer();
          txdSource = normalizePath(txdFromFile.webkitRelativePath || txdFromFile.name || `${txdName}.txd`);
        } else {
          const txdFromImg = imgParser.getAssetBytes(`${txdName}.txd`);
          if (!txdFromImg) {
            txdCache.set(txdName, null);
            pushConsoleLine('warn', `TXD missing: ${txdName}.txd (file + IMG)`);
            return null;
          }
          txdBuffer = txdFromImg.buffer.slice(
            txdFromImg.byteOffset,
            txdFromImg.byteOffset + txdFromImg.byteLength,
          );
          txdSource = imgParser.getAssetSource(`${txdName}.txd`) || 'unknown IMG';
        }
        const txd = normalizeTextureDictionary(txdLoader.parse(txdBuffer), {
          metadataByName: txdMetadataByNameRef.current,
        });
        txdCache.set(txdName, txd);
        pushConsoleLine('info', `TXD loaded: ${txdName}.txd (${txdSource})`);
        return txd;
      } catch {
        txdCache.set(txdName, null);
        pushConsoleLine('error', `TXD parse failed: ${txdName}.txd`);
        return null;
      }
      };

      const tryBuildWater = async () => {
      const waterConfig = getWaterConfig(uiStateRef.current.gameVersion);
      if (waterConfig.source !== 'waterpro') {
        pushConsoleLine(
          'warn',
          `${waterConfig.gameVersion} uses water.dat in librw/euryopa. waterpro.dat loading is skipped, so water rendering is disabled.`,
        );
        return;
      }

      const waterRecord = trackAndResolveFile('DAT', 'data/waterpro.dat', {
        declaredDetail: 'optional',
        foundDetail: 'loaded',
        missingDetail: 'missing optional',
        warnOnMissing: false,
      });
      if (!waterRecord) {
        pushConsoleLine('warn', 'waterpro.dat not found. Water rendering disabled.');
        return;
      }

      try {
        setStatus('Building water...');
        await yieldToBrowser();
        const waterStartTime = performance.now();
        const parsed = parseWaterproDat(await waterRecord.file.arrayBuffer());
        const waterTextureName = String(waterConfig.textureName || '').toLowerCase();

        const pipeline = new RWWaterPipeline({
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

        void (async () => {
          const particleTxd = await getTextureDict('particle');
          if (buildTokenRef.current !== token) return;
          const waterTextureEntry = particleTxd?.get?.(waterTextureName) || null;
          const waterTexture = waterTextureEntry?.texture || waterTextureEntry || null;
          const lowCloudTextures = ['cloud1', 'cloud2', 'cloud3']
            .map((name) => particleTxd?.get?.(name)?.texture || particleTxd?.get?.(name) || null)
            .filter(Boolean);
          const fluffyCloudTexture = particleTxd?.get?.('cloudmasked')?.texture || particleTxd?.get?.('cloudmasked') || null;
          const fluffyHighlightTexture = particleTxd?.get?.('cloudhilit')?.texture || particleTxd?.get?.('cloudhilit') || null;

          if (!waterTexture) {
            pushConsoleLine('warn', `Water texture missing: particle/${waterConfig.textureName}. Using flat color water.`);
          } else {
            pendingWaterPipeline?.setTexture(waterTexture);
            pushConsoleLine('info', `Water texture applied: particle/${waterConfig.textureName}`);
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
          moonPipelineRef.current?.setTexture(moonTexture);
          starsPipelineRef.current?.setTexture(starTexture);
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
          sunPipelineRef.current?.setTextureSet(sunTextures);
          if (sunTextures.star && sunTextures.hex && sunTextures.circle && sunTextures.ring) {
            pushConsoleLine('info', 'Sun textures applied: particle/coronastar, coronahex, coronacircle, coronaringa');
          } else {
            pushConsoleLine('warn', 'Some sun textures are missing in particle.txd. Fallback procedural sprites remain in use for missing entries.');
          }
        })();
      } catch (error) {
        pushConsoleLine('error', `waterpro.dat parse failed: ${formatConsoleArg(error)}`);
      }
      };

      await tryBuildWater();

      const getModelTemplate = async (modelName, txdName) => {
      const key = makeAssetKey(modelName, txdName);
      if (modelCache.has(key)) return modelCache.get(key);

      const pending = (async () => {
        const dffLoader = new DFFLoader();
        const txd = await getTextureDict(txdName);
        if (txd) dffLoader.setTextureDictionary(txd);

        const dffFromFile = fileIndex.findByBasename(`${modelName}.dff`);
        let dffBuffer = null;
        let dffSource = '';
        if (dffFromFile) {
          dffBuffer = await dffFromFile.arrayBuffer();
          dffSource = normalizePath(dffFromFile.webkitRelativePath || dffFromFile.name || `${modelName}.dff`);
        } else {
          const dffFromImg = imgParser.getAssetBytes(`${modelName}.dff`);
          if (!dffFromImg) {
            pushConsoleLine('error', `DFF missing: ${modelName}.dff (file + IMG)`);
            throw new Error(`Missing DFF: ${modelName}.dff`);
          }
          dffBuffer = dffFromImg.buffer.slice(
            dffFromImg.byteOffset,
            dffFromImg.byteOffset + dffFromImg.byteLength,
          );
          dffSource = imgParser.getAssetSource(`${modelName}.dff`) || 'unknown IMG';
        }

        const template = dffLoader.parse(dffBuffer);
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
        pushConsoleLine('info', `DFF loaded: ${modelName}.dff (${dffSource})`);
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
    let instancedItems = 0;

    const getRenderChunk = (anchor) => {
      const chunkKey = getChunkKeyFromPosition(anchor);
      if (renderChunkMap.has(chunkKey)) return renderChunkMap.get(chunkKey);
      const chunk = {
        key: chunkKey,
        center: getChunkCenterFromKey(chunkKey),
        items: [],
        active: false,
        boundsMin: new THREE.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
        boundsMax: new THREE.Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY),
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
      item.chunkKey = chunk.key;
      return item;
    };

    const buildRenderSideState = (obj, handles, drawDistanceValue, defaultIsTobj) => {
      const firstHandle = Array.isArray(handles) && handles.length > 0 ? handles[0] : null;
      const placementMatrix = obj?.userData?.placementMatrix || firstHandle?.placementMatrix || null;
      return {
        streamAlpha: (obj || firstHandle) ? 0 : 1,
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

    const buildObjectDetail = (ide, placement, lodKind, model) => ({
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
    });

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

    const tryBuildInstancedHandles = async (placement, lodKind, anchor) => {
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

    const buildPlacementObject = async (placement, lodKind, anchor) => {
      const ide = ideByModel.get(placement.modelName) ?? ideById.get(placement.id);
      if (!ide) {
        unresolved += 1;
        pushConsoleLine('error', `Missing IDE def for placement: model=${placement.modelName} id=${placement.id}`, 'build');
        return null;
      }

      try {
        const model = await getModelTemplate(ide.modelName, ide.txdName);
        const worldMatrix = buildPlacementWorldMatrix(placement, anchor);

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
        const nearObj = await buildPlacementObject(placement, 'near', anchor);
        const lodObj = await buildPlacementObject(lodPlacement, 'lod', lodAnchor);
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
        const nearInstanced = await tryBuildInstancedHandles(placement, 'near', anchor);
        const nearObj = nearInstanced ? null : await buildPlacementObject(placement, 'near', anchor);
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
        const lodInstanced = await tryBuildInstancedHandles(placement, 'lod', anchor);
        const lodObj = lodInstanced ? null : await buildPlacementObject(placement, 'lod', anchor);
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
          chunk.boundingSphere.center.copy(chunk.center);
          chunk.boundingSphere.radius = CHUNK_SPHERE_PADDING;
          continue;
        }
        const sphereCenter = chunk.boundsMin.clone().add(chunk.boundsMax).multiplyScalar(0.5);
        let radiusSq = 0;
        for (const item of chunk.items) {
          radiusSq = Math.max(radiusSq, sphereCenter.distanceToSquared(item.anchor));
        }
        chunk.boundingSphere.center.copy(sphereCenter);
        chunk.boundingSphere.radius = Math.sqrt(radiusSq) + CHUNK_SPHERE_PADDING;
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

      rwWaterPipelineRef.current?.dispose();
      rwWaterPipelineRef.current = pendingWaterPipeline;
      renderItemsRef.current = renderItems;
      renderChunksRef.current = Array.from(renderChunkMap.values());
      rwPipelineControllerRef.current.setRoot(worldRoot);
      rwPipelineControllerRef.current.applyToRoot(worldRoot, {
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
      setStats((prev) => ({
        ...prev,
        loaded,
        failed,
        unresolved,
        totalChunks: renderChunkMap.size,
        instancedBatches: instancedBatchMap.size,
        instancedItems,
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
    setStatus(`Indexed ${index.count} files. Click Build World.`);
  }, [pushConsoleLine]);

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
    rwPipelineControllerRef.current.applyToObject(proxy, {
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
    const moonPipeline = new RWMoonPipeline();
    const starsPipeline = new RWStarsPipeline();
    const sunPipeline = new RWSunPipeline();

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
    moonPipelineRef.current = moonPipeline;
    starsPipelineRef.current = starsPipeline;
    sunPipelineRef.current = sunPipeline;
    rwRenderQueueRef.current = new RWRenderQueue(worldRootRef.current);
    rwPipelineControllerRef.current.setRoot(worldRootRef.current);
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
      if (!rendererReady) return;
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
      moonPipeline.setViewport(width * dpr, height * dpr);
      starsPipeline.setViewport(width * dpr, height * dpr);
      sunPipeline.setViewport(width * dpr, height * dpr);
    };

    resize();
    window.addEventListener('resize', resize);

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
      const lowCloudAlpha = THREE.MathUtils.clamp(1 - Math.max(cloudCoverage, foggyness, extraSunnyness), 0, 1) * 0.42;
      const fluffyCloudAlpha = THREE.MathUtils.clamp(1 - Math.max(foggyness, extraSunnyness), 0, 1) * 0.5;
      const sunPipeline = sunPipelineRef.current;
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
      const moonPipeline = moonPipelineRef.current;
      const starsPipeline = starsPipelineRef.current;
      moonPipeline?.setViewport(viewportWidth, viewportHeight);
      starsPipeline?.setViewport(viewportWidth, viewportHeight);
      sunPipeline?.setViewport(viewportWidth, viewportHeight);
      const moonSettings = uiStateRef.current.moon;
      moonPipeline?.update(camera, timecycleCurrent, moonSettings);
      const starsSettings = uiStateRef.current.stars;
      starsPipeline?.update(camera, timecycleCurrent, starsSettings);
      const sunSettings = uiStateRef.current.sun;
      const sunMetrics = sunPipeline?.updateSunMetrics(camera, timecycleCurrent, sunSettings) ?? null;
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
        sprite.material.color.copy(lowCloudColor);
        sprite.material.opacity = lowCloudAlpha;
      }
      const fluffyCloudSprites = fluffyCloudSpritesRef.current;
      const fluffyHighlightSprites = fluffyHighlightSpritesRef.current;
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
        if (sunMetrics?.onScreen && sunSettings.enabled) {
          const spriteNdc = sprite.position.clone().project(camera);
          const spriteScreenX = (spriteNdc.x * 0.5 + 0.5) * viewportWidth;
          const spriteScreenY = (-spriteNdc.y * 0.5 + 0.5) * viewportHeight;
          const distanceToSun = Math.hypot(spriteScreenX - sunMetrics.screenX, spriteScreenY - sunMetrics.screenY);
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
              highlightSprite.material.opacity = THREE.MathUtils.clamp(highlight, 0, 1);
              highlightSprite.material.rotation = 1.7 - Math.atan2(spriteScreenX - sunMetrics.screenX, spriteScreenY - sunMetrics.screenY);
            }
          }
          if (distanceToSun < viewportWidth * sunSettings.cloudBlockRadius) {
            sunBlockedByClouds = true;
          }
        }
        sprite.material.opacity = fluffyCloudAlpha;
        sprite.material.rotation = cloudMotion.individualRotation;
        if (highlightSprite) {
          highlightSprite.scale.setScalar(sprite.scale.x * (30 / 55));
        }
      }
      const sunState = sunPipeline?.update(
        camera,
        worldRootRef.current,
        timecycleCurrent,
        sunSettings,
        dt,
        time,
        sunBlockedByClouds,
        sunMetrics,
      );
      const sunLightsMult = computeSunLightsMultFromState(sunState);
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
          const chunkInFrustum = chunkInRange && chunkFrustum.intersectsSphere(chunk.boundingSphere);
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
          for (const item of chunk.items) {
            const distSq = camera.position.distanceToSquared(item.anchor);
            const hasNear = hasNearRenderable(item);
            const hasLod = hasLodRenderable(item);
            const tobjAllowed = !item.isTobj || showTobjs;
            const dist = Math.sqrt(distSq);
            if (!tobjAllowed || dist > (renderingDistance + RW_DISTANCE_FADE_WINDOW)) {
              hideRenderItemCompletely(item, dirtyBatches);
              continue;
            }

            const pairedItem = hasNear && hasLod;
            const nearEndDistance = Math.min(
              resolveRenderableDistance(
                pairedItem
                  ? (showLods ? drawDistance : renderingDistance)
                  : item.nearState?.drawDistance,
                renderingDistance,
              ),
              renderingDistance,
            );
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
              const nearFadeRange = dist <= (drawDistance + RW_DISTANCE_FADE_WINDOW);
              const lodVisibleRange = dist <= (lodEndDistance + RW_DISTANCE_FADE_WINDOW);

              if (nearFadeRange && item.nearState) {
                item.nearState.streamAlpha = approachValue(
                  item.nearState.streamAlpha,
                  1,
                  dt * RW_STREAM_ALPHA_PER_SECOND,
                );
              }
              if (lodVisibleRange && item.lodState) {
                item.lodState.streamAlpha = approachValue(
                  item.lodState.streamAlpha,
                  1,
                  dt * RW_STREAM_ALPHA_PER_SECOND,
                );
              }

              const nearStreamAlpha = item.nearState?.streamAlpha ?? 1;
              const lodStreamAlpha = item.lodState?.streamAlpha ?? 1;
              const nearDistanceAlpha = nearCoreRange ? 1 : computeDistanceFadeAlpha(dist, drawDistance);
              const lodDistanceAlpha = lodVisibleRange ? computeDistanceFadeAlpha(dist, lodEndDistance) : 0;

              nearOpacity = nearFadeRange ? clamp01(nearStreamAlpha * nearDistanceAlpha) : 0;
              if (nearCoreRange) {
                lodOpacity = lodVisibleRange
                  ? clamp01((nearStreamAlpha < (1 - RW_FADE_EPSILON) ? 1 : 0) * lodStreamAlpha * lodDistanceAlpha)
                  : 0;
              } else {
                lodOpacity = lodVisibleRange ? clamp01(lodStreamAlpha * lodDistanceAlpha) : 0;
              }
              nearShouldShow = nearOpacity > RW_FADE_EPSILON;
              lodShouldShow = lodOpacity > RW_FADE_EPSILON;
            } else {
              nearShouldShow = hasNear
                && !forceLodOnly
                && dist <= (nearEndDistance + RW_DISTANCE_FADE_WINDOW);
              const lodShouldShowBase = hasLod
                && (
                  forceLodOnly
                  || (!showLods && !hasNear)
                  || (showLods && (!hasNear || dist > drawDistance))
                );

              if (nearShouldShow && item.nearState) {
                item.nearState.streamAlpha = approachValue(
                  item.nearState.streamAlpha,
                  1,
                  dt * RW_STREAM_ALPHA_PER_SECOND,
                );
              }
              const nearDistanceAlpha = nearShouldShow
                ? computeDistanceFadeAlpha(dist, nearEndDistance)
                : 0;
              nearOpacity = nearShouldShow
                ? clamp01((item.nearState?.streamAlpha ?? 1) * nearDistanceAlpha)
                : 0;

              lodShouldShow = hasLod
                && dist <= (lodEndDistance + RW_DISTANCE_FADE_WINDOW)
                && lodShouldShowBase;
              if (lodShouldShow && item.lodState) {
                item.lodState.streamAlpha = approachValue(
                  item.lodState.streamAlpha,
                  1,
                  dt * RW_STREAM_ALPHA_PER_SECOND,
                );
              }
              const lodDistanceAlpha = lodShouldShow
                ? computeDistanceFadeAlpha(dist, lodEndDistance)
                : 0;
              lodOpacity = lodShouldShow
                ? clamp01((item.lodState?.streamAlpha ?? 1) * lodDistanceAlpha)
                : 0;
            }

            item.mode = nearOpacity > RW_FADE_EPSILON
              ? (lodOpacity > RW_FADE_EPSILON ? 'near+lod' : 'near')
              : (lodOpacity > RW_FADE_EPSILON ? 'lod' : 'hidden');

            if (nearOpacity > RW_FADE_EPSILON) visibleNear += 1;
            if (lodOpacity > RW_FADE_EPSILON) visibleLod += 1;

            applyRenderSideOpacity(item, 'near', nearOpacity, dirtyBatches);
            applyRenderSideOpacity(item, 'lod', lodOpacity, dirtyBatches);

            if (
              (nearOpacity > RW_FADE_EPSILON && nearOpacity < (1 - RW_FADE_EPSILON))
              || (lodOpacity > RW_FADE_EPSILON && lodOpacity < (1 - RW_FADE_EPSILON))
              || (nearShouldShow && (item.nearState?.streamAlpha ?? 1) < (1 - RW_FADE_EPSILON))
              || (lodShouldShow && (item.lodState?.streamAlpha ?? 1) < (1 - RW_FADE_EPSILON))
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
          activeChunks,
          frustumChunks,
          activeItems,
          visibleNear,
          visibleLod,
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
        };
        activeFadeCountRef.current = activeFades;
        lodState.needsRefresh = activeFades > 0;
      }

      grid.visible = uiStateRef.current.showGrid;
      axes.visible = uiStateRef.current.showAxes;
      if (lastWireframeRef.current !== uiStateRef.current.wireframe) {
        applyWireframe(worldRootRef.current, uiStateRef.current.wireframe);
        rwWaterPipelineRef.current?.setWireframe(uiStateRef.current.wireframe);
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
        rwWaterPipelineRef.current?.setEnabled(uiStateRef.current.renderWater);
        lastRenderWaterRef.current = uiStateRef.current.renderWater;
      }

      const pipelineRuntimeContext = {
        activeBackend,
        worldGameVersion: worldGameVersionRef.current,
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
      rwPipelineControllerRef.current.setSelection(uiStateRef.current.pipelineDebug);
      const pipelineSelectionSignature = getPipelineSelectionSignature(
        uiStateRef.current.pipelineDebug,
        activeBackend,
        worldGameVersionRef.current,
      );
      if (pipelineSelectionSignature !== lastPipelineSelectionSignatureRef.current) {
        rwPipelineControllerRef.current.applyToRoot(worldRootRef.current, pipelineRuntimeContext);
        applyWireframe(worldRootRef.current, uiStateRef.current.wireframe);
        applyDisableVertexColor(worldRootRef.current, uiStateRef.current.disableVertexColor);
        applyGlobalBackfaceCulling(worldRootRef.current, uiStateRef.current.disableBackfaceCulling);
        lastPipelineSelectionSignatureRef.current = pipelineSelectionSignature;
        rwRenderQueueRef.current?.markDirty();
      } else {
        rwPipelineControllerRef.current.updateRuntime(pipelineRuntimeContext);
      }

      const waterPipeline = rwWaterPipelineRef.current;
      waterPipeline?.applySettings({
        uvSpeed: uiStateRef.current.waterUvSpeed,
        waveHeight: uiStateRef.current.waterWaveHeight,
        farAlpha: uiStateRef.current.waterAlpha,
      });
      const postFxSelection = uiStateRef.current.pipelineDebug?.[RW_PIPELINE_CATEGORY.POSTFX];
      const postFxSunCoronaEnabled = (
        postFxSelection?.config?.enableBigBloomSunEffect
        ?? postFxSelection?.config?.enableSunCorona
        ?? true
      );
      const skyScene = skySceneRef.current;
      const skyCamera = skyCameraRef.current;
      const skyCloudScene = skyCloudSceneRef.current;
      const farBackgroundColor = skyBottomColor;
      try {
        const rwRenderQueue = rwRenderQueueRef.current;
        const postFxSceneTarget = rwPipelineControllerRef.current.beginPostFxSceneCapture({
          ...pipelineRuntimeContext,
          viewportWidth,
          viewportHeight,
        });
        rwRenderQueue?.prepareFrame(camera);
        renderer.setRenderTarget(postFxSceneTarget);
        renderer.autoClear = true;
        if (skyScene && skyCamera) {
          renderer.render(skyScene, skyCamera);
        } else {
          renderer.setClearColor(farBackgroundColor, 1);
          renderer.clear(true, true, true);
        }
        renderer.autoClear = false;
        renderer.clearDepth();
        moonPipeline?.render(renderer);
        starsPipeline?.render(renderer);
        if (skyCloudScene) {
          renderer.render(skyCloudScene, camera);
          renderer.clearDepth();
        }
        if (waterPipeline?.hasRenderableWater() && uiStateRef.current.renderWater) {
          let waterStage = 'update';
          try {
            waterPipeline.update(camera, time, dt);

            waterStage = 'renderSceneOpaque';
            rwRenderQueue?.pushCameraBucketMask(camera, ['opaque', 'cutout']);
            renderer.render(scene, camera);
            rwRenderQueue?.popCameraBucketMask(camera);

            waterStage = 'renderFar';
            waterPipeline.renderFar(renderer, camera, null);

            waterStage = 'renderNear';
            waterPipeline.renderNear(renderer, camera);

            waterStage = 'renderWavy';
            waterPipeline.renderWavy(renderer, camera);

            waterStage = 'renderWake';
            waterPipeline.renderWake(renderer, camera);

            waterStage = 'renderSceneTransparent';
            rwRenderQueue?.pushCameraBucketMask(camera, ['transparent', 'additive', 'overlay']);
            renderer.render(scene, camera);
            rwRenderQueue?.popCameraBucketMask(camera);
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
            rwWaterPipelineRef.current?.dispose();
            rwWaterPipelineRef.current = null;
            renderer.autoClear = false;
            rwRenderQueue?.pushCameraBucketMask(camera, ['opaque', 'cutout', 'transparent', 'additive', 'overlay']);
            renderer.render(scene, camera);
            rwRenderQueue?.popCameraBucketMask(camera);
          }
        } else {
          renderer.autoClear = false;
          rwRenderQueue?.pushCameraBucketMask(camera, ['opaque', 'cutout', 'transparent', 'additive', 'overlay']);
          renderer.render(scene, camera);
          rwRenderQueue?.popCameraBucketMask(camera);
        }
        if (postFxSceneTarget && postFxSunCoronaEnabled) {
          renderer.clearDepth();
          sunPipeline?.render(renderer, { mode: 'bloom' });
        }
        renderer.setRenderTarget(null);
        if (postFxSceneTarget) {
          rwPipelineControllerRef.current.renderPostFx(renderer, {
            ...pipelineRuntimeContext,
            viewportWidth,
            viewportHeight,
          });
        }
        renderer.clearDepth();
        sunPipeline?.render(renderer, { mode: 'full' });

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
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(hudScene, hudCamera);
        renderer.autoClear = true;
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
            if (ImGui.MenuItem('Load map')) {
              fileInputRef.current?.click();
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
        ImGui.Text('draw dist: LOD switch distance (near model <-> LOD)');
        ImGui.PushItemWidth(-1);
        ImGui.SliderInt(
          'draw dist',
          (value = Math.round(uiStateRef.current.drawDistance)) => {
            uiStateRef.current.drawDistance = value;
            return value;
          },
          20,
          3000,
        );
        const currentFarClip = timecycleStateRef.current?.current?.values?.farClip;
        ImGui.Text('far clip: max visible distance (timecyc-driven when loaded)');
        if (Number.isFinite(currentFarClip)) ImGui.BeginDisabled();
        ImGui.SliderInt(
          'Far Clip',
          (value = Math.round(Number.isFinite(currentFarClip) ? currentFarClip : uiStateRef.current.renderingDistance)) => {
            if (!Number.isFinite(currentFarClip)) uiStateRef.current.renderingDistance = value;
            return Math.round(Number.isFinite(currentFarClip) ? currentFarClip : value);
          },
          50,
          20000,
        );
        if (Number.isFinite(currentFarClip)) ImGui.EndDisabled();
        ImGui.Text('lod dist multiplier: VC horizon strip scale');
        ImGui.SliderFloat(
          'LOD Dist Multiplier',
          (value = uiStateRef.current.lodDistMultiplier) => {
            uiStateRef.current.lodDistMultiplier = value;
            return value;
          },
          0,
          4,
          '%.2f',
        );
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
                ImGui.SliderInt(
                  '##time-of-day',
                  (value = ((tcControls.hour * 60) + tcControls.minute)) => {
                    const totalMinutes = Math.max(0, Math.min(1439, Math.round(value)));
                    tcControls.hour = Math.floor(totalMinutes / 60);
                    tcControls.minute = totalMinutes % 60;
                    return totalMinutes;
                  },
                  0,
                  1439,
                  `${String(tcControls.hour).padStart(2, '0')}:${String(tcControls.minute).padStart(2, '0')}`,
                );
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
                ImGui.SliderFloat(
                  '##weather-blend',
                  (value = tcControls.weatherBlend) => {
                    tcControls.weatherBlend = Math.max(0, Math.min(1, value));
                    return tcControls.weatherBlend;
                  },
                  0,
                  1,
                  '%.3f',
                );
              });
              if (tcData.extraColourCount > 0 && tcData.extraColourWeatherIndex >= 0) {
                timecycleRow('Extra Colour', () => {
                  ImGui.SliderInt(
                    '##extra-colour',
                    (value = tcControls.extraColour) => {
                      tcControls.extraColour = Math.max(-1, Math.min((tcData.extraColourCount * tcData.hours) - 1, Math.round(value)));
                      return tcControls.extraColour;
                    },
                    -1,
                    (tcData.extraColourCount * tcData.hours) - 1,
                    tcControls.extraColour < 0 ? 'Disabled' : `Hour ${tcControls.extraColour % tcData.hours}`,
                  );
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
            }
            if (ImGui.CollapsingHeader('Transform', defaultOpen)) {
              ImGui.Text(
                `Position: ${detail.position.x.toFixed(3)}, ${detail.position.y.toFixed(3)}, ${detail.position.z.toFixed(3)}`,
              );
              ImGui.Text(
                `Rotation(q): ${detail.rotation.x.toFixed(6)}, ${detail.rotation.y.toFixed(6)}, ${detail.rotation.z.toFixed(6)}, ${detail.rotation.w.toFixed(6)}`,
              );
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
            const rendererInfo = rendererRef.current?.info?.render;
            const renderMetrics = renderMetricsRef.current;
            ImGui.Text(`FPS: ${fpsCurrent.toFixed(1)} | avg ${fpsAvg.toFixed(1)} | min ${fpsCount > 0 ? fpsMin.toFixed(1) : '0.0'} | max ${fpsMax.toFixed(1)}`);
            ImGui.Text(`Draw Calls: ${rendererInfo?.calls ?? renderMetrics.drawCalls}`);
            ImGui.Text(`Triangles: ${rendererInfo?.triangles ?? renderMetrics.triangles}`);
            ImGui.Text(`Chunks: ${renderMetrics.frustumChunks}/${statsRef.current.totalChunks}`);
            ImGui.Text(`Active Items: ${renderMetrics.activeItems}`);
            ImGui.Text(`Visible: near ${renderMetrics.visibleNear} | lod ${renderMetrics.visibleLod}`);
            ImGui.Text(`Instancing: batches ${statsRef.current.instancedBatches} | placements ${statsRef.current.instancedItems}`);
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
                if (detail === 'declared' || detail === 'required' || detail === 'found') return false;
                if (detail.includes('missing')) return false;
                return true;
              });
              const start = Math.max(0, files.length - 1000);
              let text = files
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
                const renderWaterSliderRow = (id, label, getter, setter, min, max, format = '%.2f') => {
                  ImGui.PushID(id);
                  ImGui.Columns(2, `water-row-${id}`, false);
                  ImGui.SetColumnWidth(0, 170);
                  ImGui.PushItemWidth(-1);
                  ImGui.SliderFloat(
                    '##value',
                    (value = getter()) => {
                      setter(value);
                      return value;
                    },
                    min,
                    max,
                    format,
                  );
                  ImGui.PopItemWidth();
                  ImGui.NextColumn();
                  ImGui.AlignTextToFramePadding();
                  ImGui.TextUnformatted(label);
                  ImGui.Columns(1);
                  ImGui.PopID();
                };
                renderWaterSliderRow(
                  'uv-speed',
                  'Texture Scroll Speed',
                  () => uiStateRef.current.waterUvSpeed,
                  (value) => { uiStateRef.current.waterUvSpeed = value; },
                  0,
                  4,
                );
                renderWaterSliderRow(
                  'wave-height',
                  'Wave Height Scale',
                  () => uiStateRef.current.waterWaveHeight,
                  (value) => { uiStateRef.current.waterWaveHeight = value; },
                  0,
                  100,
                  '%.0f',
                );
                renderWaterSliderRow(
                  'water-alpha',
                  'Fallback Alpha',
                  () => uiStateRef.current.waterAlpha,
                  (value) => { uiStateRef.current.waterAlpha = value; },
                  0,
                  1,
                );
                ImGui.TextWrapped('RW alignment: wind is pinned to 0, so the default wave profile uses the original 0.3 baseline swell with no weather-driven boost.');
              }
              if (ImGui.CollapsingHeader('Sky', defaultOpen)) {
                const renderSkySliderRow = (id, label, getter, setter, min, max, format = '%.2f') => {
                  ImGui.PushID(id);
                  ImGui.Columns(2, `sky-row-${id}`, false);
                  ImGui.SetColumnWidth(0, 170);
                  ImGui.PushItemWidth(-1);
                  ImGui.SliderFloat(
                    '##value',
                    (value = getter()) => {
                      setter(value);
                      return value;
                    },
                    min,
                    max,
                    format,
                  );
                  ImGui.PopItemWidth();
                  ImGui.NextColumn();
                  ImGui.AlignTextToFramePadding();
                  ImGui.TextUnformatted(label);
                  ImGui.Columns(1);
                  ImGui.PopID();
                };
                renderSkySliderRow(
                  'lod-dist-multiplier',
                  'LOD Dist Multiplier',
                  () => uiStateRef.current.lodDistMultiplier,
                  (value) => { uiStateRef.current.lodDistMultiplier = value; },
                  0,
                  4,
                );
              }
              {
                const gameOptions = getRWPipelineGameOptions();
                const pipelineDebug = uiStateRef.current.pipelineDebug;
                const renderPostFxSliderRow = (id, label, getter, setter, min, max, format) => {
                  ImGui.PushID(id);
                  ImGui.Columns(2, `postfx-row-${id}`, false);
                  ImGui.SetColumnWidth(0, 170);
                  ImGui.PushItemWidth(-1);
                  ImGui.SliderFloat(
                    '##value',
                    (value = getter()) => {
                      setter(value);
                      return value;
                    },
                    min,
                    max,
                    format,
                  );
                  ImGui.PopItemWidth();
                  ImGui.NextColumn();
                  ImGui.AlignTextToFramePadding();
                  ImGui.TextUnformatted(label);
                  ImGui.Columns(1);
                  ImGui.PopID();
                };
                const renderPipelineDebugSection = (category, label, description) => {
                  const selection = pipelineDebug[category];
                  const status = rwPipelineControllerRef.current.describeSelection(category, {
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
                    const liveRadiosityLimit = hasLiveTimecyclePostFx
                      ? Number(timecyclePostFxValues.radiosityLimit)
                      : selection.config.trailsLimit;
                    const liveRadiosityIntensity = hasLiveTimecyclePostFx
                      ? Number(timecyclePostFxValues.radiosityIntensity)
                      : selection.config.trailsIntensity;
                    const liveBlurOffset = hasLiveTimecyclePostFx
                      ? Number(timecyclePostFxValues.blurOffset)
                      : selection.config.blurOffset;
                    const liveBlurIntensity = hasLiveTimecyclePostFx
                      ? ((Number(timecyclePostFxValues.postfx1?.a ?? timecyclePostFxValues.blurAlpha) || 0) * 0.8 / 255)
                      : selection.config.blurIntensity;
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
                    if (hasLiveTimecyclePostFx) ImGui.BeginDisabled();
                    renderPostFxSliderRow(`postfx-${category}-trails-limit`, 'Radiosity Limit', () => liveRadiosityLimit, (value) => { selection.config.trailsLimit = Math.round(value); }, 0, 255, '%.0f');
                    renderPostFxSliderRow(`postfx-${category}-trails-intensity`, 'Radiosity Intensity', () => liveRadiosityIntensity, (value) => { selection.config.trailsIntensity = Math.round(value); }, 0, 63, '%.0f');
                    renderPostFxSliderRow(`postfx-${category}-blur-offset`, 'Blur Offset', () => liveBlurOffset, (value) => { selection.config.blurOffset = value; }, 0, 8, '%.2f');
                    renderPostFxSliderRow(`postfx-${category}-blur-intensity`, 'Blur Intensity', () => liveBlurIntensity, (value) => { selection.config.blurIntensity = value; }, 0, 1, '%.3f');
                    if (hasLiveTimecyclePostFx) ImGui.EndDisabled();
                    renderPostFxSliderRow(`postfx-${category}-history-intensity`, 'Trails Intensity', () => selection.config.historyIntensity, (value) => { selection.config.historyIntensity = value; }, 0, 1, '%.3f');
                    if (hasLiveTimecyclePostFx) {
                      ImGui.TextDisabled('Radiosity/blur sliders are timecyc-driven and update live.');
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
                    const postFxEffect = rwPipelineControllerRef.current?.getActiveEffect?.(RW_PIPELINE_CATEGORY.POSTFX) || null;
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
              const renderSunSliderRow = (id, label, getter, setter, min, max, format = '%.2f') => {
                ImGui.PushID(id);
                ImGui.Columns(2, `sun-row-${id}`, false);
                ImGui.SetColumnWidth(0, 170);
                ImGui.PushItemWidth(-1);
                ImGui.SliderFloat(
                  '##value',
                  (value = getter()) => {
                    setter(value);
                    return value;
                  },
                  min,
                  max,
                  format,
                );
                ImGui.PopItemWidth();
                ImGui.NextColumn();
                ImGui.AlignTextToFramePadding();
                ImGui.TextUnformatted(label);
                ImGui.Columns(1);
                ImGui.PopID();
              };
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
              renderSunSliderRow('distance', 'Sun Distance', () => sunSettings.distance, (value) => { sunSettings.distance = value; }, 50, 1000, '%.0f');
              renderSunSliderRow('core-size-scale', 'Core Size Scale', () => sunSettings.coreSizeScale, (value) => { sunSettings.coreSizeScale = value; }, 0, 4);
              renderSunSliderRow('core-size-bias', 'Core Size Bias', () => sunSettings.coreSizeBias, (value) => { sunSettings.coreSizeBias = value; }, 0, 32);
              renderSunSliderRow('core-jitter', 'Core Jitter', () => sunSettings.coreJitterAmplitude, (value) => { sunSettings.coreJitterAmplitude = value; }, 0, 8);
              renderSunSliderRow('corona-size-scale', 'Corona Size Scale', () => sunSettings.coronaSizeScale, (value) => { sunSettings.coronaSizeScale = value; }, 0, 64);
              renderSunSliderRow('flare-scale', 'Flare Scale', () => sunSettings.flareScale, (value) => { sunSettings.flareScale = value; }, 0, 4);
              renderSunSliderRow('flare-offset-scale', 'Flare Offset Scale', () => sunSettings.flareOffsetScale, (value) => { sunSettings.flareOffsetScale = value; }, 0, 4);
              renderSunSliderRow('flare-alpha-scale', 'Flare Alpha Scale', () => sunSettings.flareAlphaScale, (value) => { sunSettings.flareAlphaScale = value; }, 0, 4);
              renderSunSliderRow('core-alpha', 'Core Alpha', () => sunSettings.coreAlpha, (value) => { sunSettings.coreAlpha = value; }, 0, 2);
              renderSunSliderRow('corona-alpha', 'Corona Alpha', () => sunSettings.coronaAlpha, (value) => { sunSettings.coronaAlpha = value; }, 0, 2);
              renderSunSliderRow('fade-speed', 'Fade Speed', () => sunSettings.fadeSpeed, (value) => { sunSettings.fadeSpeed = value; }, 0, 8);
              renderSunSliderRow('occlusion-interval', 'Occlusion Interval ms', () => sunSettings.occlusionCheckIntervalMs, (value) => { sunSettings.occlusionCheckIntervalMs = value; }, 16, 2000, '%.0f');
              renderSunSliderRow('cloud-highlight-radius', 'Cloud Highlight Radius', () => sunSettings.cloudHighlightRadius, (value) => { sunSettings.cloudHighlightRadius = value; }, 0.01, 1);
              renderSunSliderRow('cloud-highlight-strength', 'Cloud Highlight Strength', () => sunSettings.cloudHighlightStrength, (value) => { sunSettings.cloudHighlightStrength = value; }, 0, 2);
              renderSunSliderRow('cloud-block-radius', 'Cloud Block Radius', () => sunSettings.cloudBlockRadius, (value) => { sunSettings.cloudBlockRadius = value; }, 0.01, 0.5);
              ImGui.TextWrapped('RW mapping: core/corona sizes come from timecycle sun size, flares follow RW corona positions, and cloud blocking fades the corona path instead of using postprocess god rays.');
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('MOON')) {
              const renderMoonSliderRow = (id, label, getter, setter, min, max, format = '%.2f') => {
                ImGui.PushID(id);
                ImGui.Columns(2, `moon-row-${id}`, false);
                ImGui.SetColumnWidth(0, 170);
                ImGui.PushItemWidth(-1);
                ImGui.SliderFloat(
                  '##value',
                  (value = getter()) => {
                    setter(value);
                    return value;
                  },
                  min,
                  max,
                  format,
                );
                ImGui.PopItemWidth();
                ImGui.NextColumn();
                ImGui.AlignTextToFramePadding();
                ImGui.TextUnformatted(label);
                ImGui.Columns(1);
                ImGui.PopID();
              };
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
              renderMoonSliderRow('offset-x', 'Offset X', () => moonSettings.offsetX, (value) => { moonSettings.offsetX = value; }, -300, 300, '%.0f');
              renderMoonSliderRow('offset-y', 'Offset Y', () => moonSettings.offsetY, (value) => { moonSettings.offsetY = value; }, -300, 300, '%.0f');
              renderMoonSliderRow('offset-z', 'Offset Z', () => moonSettings.offsetZ, (value) => { moonSettings.offsetZ = value; }, -100, 100, '%.0f');
              renderMoonSliderRow('moon-size-index', 'Moon Size Index', () => moonSettings.moonSizeIndex, (value) => { moonSettings.moonSizeIndex = value; }, 0, 7, '%.0f');
              renderMoonSliderRow('base-scale', 'Base Scale', () => moonSettings.baseScale, (value) => { moonSettings.baseScale = value; }, 0, 32);
              renderMoonSliderRow('small-scale', 'Small Moon Scale', () => moonSettings.smallMoonScale, (value) => { moonSettings.smallMoonScale = value; }, 0, 16);
              renderMoonSliderRow('brightness-scale', 'Brightness Scale', () => moonSettings.brightnessScale, (value) => { moonSettings.brightnessScale = value; }, 0, 4);
              renderMoonSliderRow('fade-center', 'Fade Center Minutes', () => moonSettings.fadeCenterMinutes, (value) => { moonSettings.fadeCenterMinutes = value; }, 0, 1440, '%.0f');
              renderMoonSliderRow('fade-window', 'Fade Window Minutes', () => moonSettings.fadeWindowMinutes, (value) => { moonSettings.fadeWindowMinutes = value; }, 1, 720, '%.0f');
              ImGui.TextWrapped('RW mapping: moon is rendered in the clouds pass with particle/coronamoon, a camera-relative offset, weather coverage dimming, and the original 3AM-centered fade window.');
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('STARS')) {
              const renderStarsSliderRow = (id, label, getter, setter, min, max, format = '%.2f') => {
                ImGui.PushID(id);
                ImGui.Columns(2, `stars-row-${id}`, false);
                ImGui.SetColumnWidth(0, 170);
                ImGui.PushItemWidth(-1);
                ImGui.SliderFloat(
                  '##value',
                  (value = getter()) => {
                    setter(value);
                    return value;
                  },
                  min,
                  max,
                  format,
                );
                ImGui.PopItemWidth();
                ImGui.NextColumn();
                ImGui.AlignTextToFramePadding();
                ImGui.TextUnformatted(label);
                ImGui.Columns(1);
                ImGui.PopID();
              };
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
              renderStarsSliderRow('brightness-scale', 'Brightness Scale', () => starsSettings.brightnessScale, (value) => { starsSettings.brightnessScale = value; }, 0, 4);
              renderStarsSliderRow('logo-offset-x', 'Logo Offset X', () => starsSettings.logoOffsetX, (value) => { starsSettings.logoOffsetX = value; }, -300, 300, '%.0f');
              renderStarsSliderRow('logo-offset-y', 'Logo Offset Y', () => starsSettings.logoOffsetY, (value) => { starsSettings.logoOffsetY = value; }, -300, 300, '%.0f');
              renderStarsSliderRow('logo-offset-z', 'Logo Offset Z', () => starsSettings.logoOffsetZ, (value) => { starsSettings.logoOffsetZ = value; }, -100, 100, '%.0f');
              renderStarsSliderRow('logo-span-y', 'Logo Span Y', () => starsSettings.logoSpanY, (value) => { starsSettings.logoSpanY = value; }, 0, 180, '%.0f');
              renderStarsSliderRow('logo-span-z', 'Logo Span Z', () => starsSettings.logoSpanZ, (value) => { starsSettings.logoSpanZ = value; }, 0, 180, '%.0f');
              renderStarsSliderRow('star-scale', 'Star Scale', () => starsSettings.starScale, (value) => { starsSettings.starScale = value; }, 0, 4);
              renderStarsSliderRow('sparkle-offset-y', 'Sparkle Offset Y', () => starsSettings.sparkleOffsetY, (value) => { starsSettings.sparkleOffsetY = value; }, -180, 180, '%.0f');
              renderStarsSliderRow('sparkle-scale', 'Sparkle Scale', () => starsSettings.sparkleScale, (value) => { starsSettings.sparkleScale = value; }, 0, 16);
              renderStarsSliderRow('sparkle-min', 'Sparkle Min Flicker', () => starsSettings.sparkleMinFlicker, (value) => { starsSettings.sparkleMinFlicker = value; }, 0, 1);
              renderStarsSliderRow('sparkle-range', 'Sparkle Flicker Range', () => starsSettings.sparkleFlickerRange, (value) => { starsSettings.sparkleFlickerRange = value; }, 0, 1);
              ImGui.TextWrapped('RW mapping: stars are the fixed Rockstar-logo sprite pattern from Clouds.cpp plus the flickering star, using particle/coronastar and the original night visibility curve with weather coverage dimming.');
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
      moonPipelineRef.current?.dispose();
      moonPipelineRef.current = null;
      starsPipelineRef.current?.dispose();
      starsPipelineRef.current = null;
      sunPipelineRef.current?.dispose();
      sunPipelineRef.current = null;
      skyQuad.geometry.dispose();
      skyMaterial.dispose();
      imguiGlRef.current = null;
      rwWaterPipelineRef.current?.dispose();
      rwWaterPipelineRef.current = null;
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
            webkitdirectory="true"
            directory="true"
            onChange={onPickFolder}
          />
        </label>

        <button type="button" onClick={rebuildWorld}>Build World</button>
        <button type="button" onClick={clearWorld}>Clear</button>
        <p>{fileSummary}</p>
        <p>{status}</p>
      </div>
    </div>
  );
}

export default App;
