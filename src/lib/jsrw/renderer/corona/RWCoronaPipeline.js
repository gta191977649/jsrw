import * as THREE from 'three';
import {
  calcScreenCoorsLikeRw,
  prepareRwSpriteTexture,
} from '../world/sky/RWSpriteUtils.js';
import { resolveTrafficLightPhase } from './TrafficLights.js';
import { getRWMaterialDescriptor } from '../../adapters/three/ThreeMaterialAdapter.js';
import {
  DISTANCE_FADE_DEFAULTS,
} from '../../gta/core/DistanceFade.js';
import { normalizeTraversalRoots } from '../../utils/worldUtils.js';
import RenderEntityController from '../common/RenderEntityController.js';

const TMP_POSITION = new THREE.Vector3();
const TMP_DIRECTION = new THREE.Vector3();
const TMP_RAY_ORIGIN = new THREE.Vector3();
const TMP_RAY_DIR = new THREE.Vector3();
const TMP_LOOK_TARGET = new THREE.Vector3();
const TMP_COLOR = new THREE.Color();
const TMP_CAMERA_FORWARD = new THREE.Vector3();
const TMP_SCALE = new THREE.Vector3();
const TMP_QUATERNION = new THREE.Quaternion();
const DEBUG_HELPER_GEOMETRY = new THREE.BoxGeometry(0.18, 0.18, 0.18);
const CORONA_QUAD_GEOMETRY = new THREE.PlaneGeometry(1, 1);
const MIN_LOS_INTERVAL_MS = 2000;
const DEFAULT_POINT_LIGHT_INTENSITY = 1.5;
const MAX_ACTIVE_CORONAS = 96;
const MAX_ACTIVE_CORONA_LIGHTS = 16;
const OFFSCREEN_FADE_MARGIN = 0;

function clamp01(value) {
  return THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
}

function wrapUv(value, mode) {
  if (mode === THREE.RepeatWrapping) return THREE.MathUtils.euclideanModulo(value, 1);
  if (mode === THREE.MirroredRepeatWrapping) {
    const wrapped = THREE.MathUtils.euclideanModulo(value, 2);
    return wrapped <= 1 ? wrapped : (2 - wrapped);
  }
  return THREE.MathUtils.clamp(value, 0, 1);
}

function sampleTextureAlpha(texture, uv) {
  if (!texture?.isTexture) return 1;
  const data = texture.image?.data;
  const width = Number(texture.image?.width) || 0;
  const height = Number(texture.image?.height) || 0;
  if (!data || width <= 0 || height <= 0 || !uv) return 1;
  const u = wrapUv(Number(uv.x) || 0, texture.wrapS);
  const v = wrapUv(Number(uv.y) || 0, texture.wrapT);
  const pixelX = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
  const pixelY = Math.min(height - 1, Math.max(0, Math.round((1 - v) * (height - 1))));
  const alphaIndex = ((pixelY * width) + pixelX) * 4 + 3;
  const alpha = data[alphaIndex];
  return Number.isFinite(alpha) ? (alpha / 255) : 1;
}

function resolveHitMaterial(hit) {
  const material = hit?.object?.material || null;
  if (!Array.isArray(material)) return material;
  const materialIndex = hit?.face?.materialIndex;
  if (Number.isInteger(materialIndex) && material[materialIndex]) return material[materialIndex];
  return material[0] || null;
}

function doesHitBlockLos(hit) {
  const material = resolveHitMaterial(hit);
  if (!material) return false;
  const descriptor = getRWMaterialDescriptor(material);
  const bucket = descriptor?.renderBucket || 'opaque';
  if (bucket === 'additive' || bucket === 'overlay') return false;
  if (bucket === 'opaque') return true;

  const baseOpacity = clamp01(material.opacity ?? descriptor?.opacity ?? 1);
  if (baseOpacity <= 0.01) return false;
  const uv = hit?.uv || null;
  const mapAlpha = sampleTextureAlpha(material.map, uv);
  const alphaMapAlpha = sampleTextureAlpha(material.alphaMap, uv);
  const effectiveAlpha = baseOpacity * mapAlpha * alphaMapAlpha;
  const alphaThreshold = Math.max(
    0.1,
    Number(material.alphaTest ?? descriptor?.alphaRef)
      || (bucket === 'cutout' ? 0.5 : 0.5),
  );

  if (bucket === 'cutout') return effectiveAlpha >= alphaThreshold;
  if (bucket === 'transparent') {
    if (!material.map && !material.alphaMap) return baseOpacity >= 0.95;
    return effectiveAlpha >= alphaThreshold;
  }
  return effectiveAlpha >= alphaThreshold;
}

function toVector3(value, fallback = [0, 0, 0]) {
  if (value?.isVector3) return value.clone();
  if (Array.isArray(value)) {
    return new THREE.Vector3(
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
    );
  }
  return new THREE.Vector3(
    Number(value?.x) || fallback[0] || 0,
    Number(value?.y) || fallback[1] || 0,
    Number(value?.z) || fallback[2] || 0,
  );
}

function normalizeEmitterColor(color) {
  const r = Number(color?.r);
  const g = Number(color?.g);
  const b = Number(color?.b);
  return {
    r: THREE.MathUtils.clamp(Number.isFinite(r) ? (r > 1 ? (r / 255) : r) : 1, 0, 1),
    g: THREE.MathUtils.clamp(Number.isFinite(g) ? (g > 1 ? (g / 255) : g) : 1, 0, 1),
    b: THREE.MathUtils.clamp(Number.isFinite(b) ? (b > 1 ? (b / 255) : b) : 1, 0, 1),
    a: THREE.MathUtils.clamp(Number.isFinite(Number(color?.a)) ? (Number(color.a) > 1 ? (Number(color.a) / 255) : Number(color.a)) : 1, 0, 1),
  };
}

function hashEmitterId(id) {
  const text = String(id || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function calculateSpotAngle(directionAngle) {
  const normalized = THREE.MathUtils.clamp(1 - (Number(directionAngle) || 0), -1, 1);
  return THREE.MathUtils.clamp(Math.acos(normalized), THREE.MathUtils.degToRad(5), THREE.MathUtils.degToRad(85));
}

function isNightHour(hour) {
  const normalizedHour = ((Math.floor(Number(hour) || 0) % 24) + 24) % 24;
  return normalizedHour > 18 || normalizedHour < 7;
}

function shouldEmitterBeActive(entry, runtimeContext) {
  if (runtimeContext?.forceRender2dfx && entry?.emitter?.sourceType === '2dfx') {
    return { active: true, flicker: false };
  }
  if (entry?.emitter?.sourceType === 'trafficLight' && runtimeContext?.trafficLights?.enabled === false) {
    return { active: false, flicker: false };
  }
  const mode = String(entry.emitter.visibilityMode || 'always').toLowerCase();
  const hour = Number(runtimeContext?.timecycleCurrent?.hour) || 0;
  const timeMs = Number(runtimeContext?.timeMs) || 0;
  switch (mode) {
    case 'always':
      return { active: true, flicker: false };
    case 'night':
      return { active: isNightHour(hour), flicker: false };
    case 'flicker': {
      const active = ((timeMs ^ entry.randomSeed) & 0x60) !== 0 || (((timeMs >> 11) ^ entry.randomSeed) & 3) !== 0;
      return { active, flicker: !active };
    }
    case 'flicker-night': {
      if (!isNightHour(hour)) return { active: false, flicker: false };
      const active = ((timeMs ^ entry.randomSeed) & 0x60) !== 0 || (((timeMs >> 11) ^ entry.randomSeed) & 3) !== 0;
      return { active, flicker: !active };
    }
    case 'flash1':
      return { active: ((timeMs + entry.flashOffset1) & 0x200) !== 0, flicker: false };
    case 'flash1-night':
      return { active: isNightHour(hour) && (((timeMs + entry.flashOffset1) & 0x200) !== 0), flicker: false };
    case 'flash2':
      return { active: ((timeMs + entry.flashOffset2) & 0x400) !== 0, flicker: false };
    case 'flash2-night':
      return { active: isNightHour(hour) && (((timeMs + entry.flashOffset2) & 0x400) !== 0), flicker: false };
    case 'flash3':
      return { active: ((timeMs + entry.flashOffset3) & 0x800) !== 0, flicker: false };
    case 'flash3-night':
      return { active: isNightHour(hour) && (((timeMs + entry.flashOffset3) & 0x800) !== 0), flicker: false };
    case 'random-flicker':
      if (entry.randomSeed > 16) return { active: true, flicker: false };
      return shouldEmitterBeActive({ ...entry, emitter: { ...entry.emitter, visibilityMode: 'flicker' } }, runtimeContext);
    case 'random-flicker-night':
      if (!isNightHour(hour)) return { active: false, flicker: false };
      if (entry.randomSeed > 16) return { active: true, flicker: false };
      return shouldEmitterBeActive({ ...entry, emitter: { ...entry.emitter, visibilityMode: 'flicker' } }, runtimeContext);
    case 'traffic-light':
      if (
        resolveTrafficLightPhase(
          timeMs,
          entry.emitter.trafficLightType,
          runtimeContext?.trafficLights,
        )
        !== String(entry.emitter.trafficLightPhase || '').toLowerCase()
      ) {
        return { active: false, flicker: false };
      }
      if (
        runtimeContext?.trafficLights?.ignoreFacing === true
        || cameraMatchesTrafficLightFacingRule(runtimeContext?.camera, entry.emitter)
      ) {
        return { active: true, flicker: false };
      }
      return {
        active: false,
        flicker: false,
      };
    default:
      return { active: true, flicker: false };
  }
}

function cameraMatchesTrafficLightFacingRule(camera, emitter) {
  const facingRule = String(emitter?.trafficLightFacingRule || 'always').toLowerCase();
  if (facingRule === 'always') return true;
  const forward = toVector3(emitter?.trafficLightForward, [0, 1, 0]).normalize();
  if (!camera?.getWorldDirection) return true;
  camera.getWorldDirection(TMP_CAMERA_FORWARD);
  const dot = TMP_CAMERA_FORWARD.dot(forward);
  switch (facingRule) {
    case 'lt-zero':
      return dot < 0;
    case 'lte-zero':
      return dot <= 0;
    case 'gt-zero':
      return dot > 0;
    case 'gte-zero':
      return dot >= 0;
    default:
      return true;
  }
}

function createCoronaBatchMaterial(map, depthTest) {
  const material = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    depthTest,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    vertexColors: true,
    blending: THREE.CustomBlending,
  });
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquation = THREE.AddEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float instanceOpacity;
attribute float instanceRotation;
varying float vInstanceOpacity;`,
      )
      .replace(
        '#include <begin_vertex>',
        `float rwSin = sin(instanceRotation);
float rwCos = cos(instanceRotation);
mat2 rwRotation = mat2(rwCos, rwSin, -rwSin, rwCos);
vec3 transformed = vec3(rwRotation * position.xy, position.z);
vInstanceOpacity = instanceOpacity;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vInstanceOpacity;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.a *= vInstanceOpacity;`,
      );
  };
  material.customProgramCacheKey = () => `rw-corona-batch-${depthTest ? 'depth' : 'nodepth'}`;
  return material;
}

export class RWCoronaPipeline {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.enableDebugHelpers = options.enableDebugHelpers === true;
    this.root = null;
    this.textureDictionary = null;
    this.viewportWidth = 1;
    this.viewportHeight = 1;
    this.renderScene = new THREE.Scene();
    this.spriteRoot = new THREE.Group();
    this.lightRoot = new THREE.Group();
    this.debugRoot = new THREE.Group();
    this.spriteRoot.name = 'rw_corona_sprites';
    this.spriteRoot.userData = {
      ...(this.spriteRoot.userData || {}),
      rwCoronaAux: true,
    };
    this.lightRoot.name = 'rw_corona_lights';
    this.lightRoot.userData = {
      ...(this.lightRoot.userData || {}),
      rwCoronaAux: true,
    };
    this.debugRoot.name = 'rw_corona_debug';
    this.debugRoot.userData = {
      ...(this.debugRoot.userData || {}),
      rwCoronaAux: true,
    };
    this.debugShowAll = false;
    this.entries = [];
    this.entryByEmitter = new WeakMap();
    this.activeEntries = new Set();
    this.spriteBatches = new Map();
    this.debugStats = {
      entryCount: 0,
      candidateCount: 0,
      activeCount: 0,
    };
    this.raycaster = new THREE.Raycaster();
    this.cachedOccluderMeshes = null;
    this.occludersDirty = true;
    this.renderScene.autoUpdate = false;
    this.renderScene.add(this.spriteRoot);
    this.renderScene.add(this.debugRoot);
    this.setRoot(options.root || null);
    this.setTextureDictionary(options.textureDictionary || null);
    this.setViewport(options.viewportWidth || 1, options.viewportHeight || 1);
    this.setEmitters(options.emitters || []);
  }

  setRoot(root) {
    const nextRoots = normalizeTraversalRoots(root);
    const nextAttachmentRoot = nextRoots[0] || null;
    const sameRoots = Array.isArray(this.roots)
      && this.roots.length === nextRoots.length
      && this.roots.every((entry, index) => entry === nextRoots[index]);
    if (sameRoots && this.root === nextAttachmentRoot) return this.root;
    if (this.lightRoot.parent) {
      this.lightRoot.parent.remove(this.lightRoot);
    }
    this.roots = nextRoots;
    this.root = nextAttachmentRoot;
    this.occludersDirty = true;
    this.cachedOccluderMeshes = null;
    if (this.root) {
      this.root.add(this.lightRoot);
    }
    return this.root;
  }

  markOccludersDirty() {
    this.occludersDirty = true;
    this.cachedOccluderMeshes = null;
  }

  getOccluderMeshes() {
    if (!Array.isArray(this.roots) || this.roots.length === 0) return [];
    if (!this.occludersDirty && Array.isArray(this.cachedOccluderMeshes)) return this.cachedOccluderMeshes;
    const occluders = [];
    for (const root of this.roots) {
      root.updateMatrixWorld(true);
      root.traverse((object) => {
        if (!object?.isMesh || !object.geometry) return;
        let current = object;
        while (current) {
          if (current.userData?.rwCoronaAux || current.userData?.rwShadowAux || current.userData?.rwQueueProxy) return;
          if (current === root) break;
          current = current.parent;
        }
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        let blocksLos = false;
        for (const material of materials) {
          const bucket = getRWMaterialDescriptor(material)?.renderBucket || 'opaque';
          if (bucket === 'opaque' || bucket === 'cutout' || bucket === 'transparent') {
            blocksLos = true;
            break;
          }
        }
        if (!blocksLos) return;
        occluders.push(object);
      });
    }
    this.cachedOccluderMeshes = occluders;
    this.occludersDirty = false;
    return occluders;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      for (const entry of this.entries) {
        if (entry.light) entry.light.visible = false;
      }
      this.resetSpriteBatches();
    }
  }

  setDebugShowAll(enabled) {
    this.debugShowAll = Boolean(enabled);
    this.debugRoot.visible = this.debugShowAll;
    for (const entry of this.entries) {
      if (entry.helperMesh) entry.helperMesh.visible = this.enableDebugHelpers && this.debugShowAll;
      if (entry.helperLine) entry.helperLine.visible = this.enableDebugHelpers && this.debugShowAll;
    }
  }

  setViewport(width, height) {
    this.viewportWidth = Math.max(1, Number(width) || 1);
    this.viewportHeight = Math.max(1, Number(height) || 1);
  }

  setTextureDictionary(textureDictionary) {
    this.textureDictionary = textureDictionary || null;
    for (const batch of this.spriteBatches.values()) {
      if (batch?.mesh?.material) {
        batch.mesh.material.map = this.resolveTexture(batch.textureKey);
        batch.mesh.material.needsUpdate = true;
      }
    }
  }

  resolveTexture(textureKey, options = {}) {
    const fallbackToCorona = options.fallbackToCorona !== false;
    const normalizedKey = String(textureKey || '').trim().toLowerCase();
    if (!normalizedKey || !this.textureDictionary?.get) return null;
    const textureKeys = normalizedKey === 'corona' || !fallbackToCorona
      ? [normalizedKey]
      : [normalizedKey, 'corona'];
    for (const key of textureKeys) {
      const textureEntry = this.textureDictionary.get(key);
      const texture = textureEntry?.texture || textureEntry || null;
      const prepared = prepareRwSpriteTexture(texture);
      if (prepared) return prepared;
    }
    return null;
  }

  setEmitters(emitters = []) {
    this.disposeEntries();
    this.entryByEmitter = new WeakMap();
    this.activeEntries.clear();
    this.entries = (emitters || []).map((emitter, index) => this.createEntry(emitter, index)).filter(Boolean);
    for (const entry of this.entries) {
      this.entryByEmitter.set(entry.emitter, entry);
    }
    this.debugStats.entryCount = this.entries.length;
  }

  getFrameEntries(frameVisibility = null) {
    if (frameVisibility?.computed !== true) {
      return this.entries;
    }
    const frameVisibilityCandidates = Array.isArray(frameVisibility?.coronaCandidates)
      ? frameVisibility.coronaCandidates
      : [];
    const entries = [];
    const seen = new Set();
    for (const emitter of frameVisibilityCandidates) {
      const entry = this.entryByEmitter.get(emitter);
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      entries.push(entry);
    }
    for (const entry of this.activeEntries) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      entries.push(entry);
    }
    return entries;
  }

  createEntry(emitter, index) {
    if (!emitter) return null;
    const entry = {
      emitter,
      index,
      randomSeed: hashEmitterId(emitter.id ?? index) & 0xFFFF,
      flashOffset1: index * 0x80,
      flashOffset2: index * 0x100,
      flashOffset3: index * 0x200,
      fadeAlpha: 0,
      streamAlpha: 0,
      lastLosCheckMs: 0,
      losVisible: true,
      light: null,
      lightTarget: null,
      helperMesh: null,
      helperLine: null,
      lastScreen: null,
      lightState: null,
      spriteState: null,
    };

    const lightBundle = this.createLightBundle(emitter);
    if (lightBundle?.light) {
      entry.light = lightBundle.light;
      entry.light.visible = false;
      entry.light.userData = {
        ...(entry.light.userData || {}),
        rwCoronaAux: true,
        rwCoronaEmitterId: emitter.id,
      };
      this.lightRoot.add(entry.light);
      if (lightBundle.target) {
        entry.lightTarget = lightBundle.target;
        entry.lightTarget.userData = {
          ...(entry.lightTarget.userData || {}),
          rwCoronaAux: true,
        };
        this.lightRoot.add(entry.lightTarget);
        if ('target' in entry.light) entry.light.target = entry.lightTarget;
      }
    }

    if (this.enableDebugHelpers) {
      const helperMaterial = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        toneMapped: false,
      });
      const helperMesh = new THREE.Mesh(DEBUG_HELPER_GEOMETRY, helperMaterial);
      helperMesh.visible = false;
      helperMesh.frustumCulled = false;
      helperMesh.userData = {
        ...(helperMesh.userData || {}),
        rwCoronaAux: true,
        rwCoronaEmitterId: emitter.id,
      };
      this.debugRoot.add(helperMesh);
      entry.helperMesh = helperMesh;

      if (emitter.direction) {
        const lineGeometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, -1),
        ]);
        const lineMaterial = new THREE.LineBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.75,
          toneMapped: false,
        });
        const helperLine = new THREE.Line(lineGeometry, lineMaterial);
        helperLine.visible = this.debugShowAll;
        helperLine.userData = {
          ...(helperLine.userData || {}),
          rwCoronaAux: true,
          rwCoronaEmitterId: emitter.id,
        };
        this.debugRoot.add(helperLine);
        entry.helperLine = helperLine;
      }
    }

    return entry;
  }

  getSpriteBatchKey(textureKey, depthTest) {
    return `${String(textureKey || '').trim().toLowerCase()}|${depthTest ? '1' : '0'}`;
  }

  ensureSpriteBatchCapacity(textureKey, depthTest, requiredCount) {
    const key = this.getSpriteBatchKey(textureKey, depthTest);
    const targetCount = Math.max(1, Math.floor(Number(requiredCount) || 1));
    let batch = this.spriteBatches.get(key) || null;
    if (batch && batch.capacity >= targetCount) {
      return batch;
    }

    const nextCapacity = batch
      ? Math.max(targetCount, batch.capacity * 2)
      : Math.max(8, targetCount);
    const geometry = CORONA_QUAD_GEOMETRY.clone();
    const opacityAttr = new THREE.InstancedBufferAttribute(new Float32Array(nextCapacity), 1);
    opacityAttr.setUsage(THREE.DynamicDrawUsage);
    const rotationAttr = new THREE.InstancedBufferAttribute(new Float32Array(nextCapacity), 1);
    rotationAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('instanceOpacity', opacityAttr);
    geometry.setAttribute('instanceRotation', rotationAttr);

    const material = createCoronaBatchMaterial(this.resolveTexture(textureKey), depthTest);
    const mesh = new THREE.InstancedMesh(geometry, material, nextCapacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 90;
    mesh.layers.disableAll();
    mesh.layers.enable(0);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData = {
      ...(mesh.userData || {}),
      rwCoronaAux: true,
      rwCoronaBatch: true,
      rwCoronaTextureKey: textureKey,
    };
    if (mesh.instanceColor) {
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }

    if (batch?.mesh) {
      const prevMesh = batch.mesh;
      const prevCount = Math.min(batch.capacity, nextCapacity);
      if (prevMesh.instanceMatrix?.array) {
        mesh.instanceMatrix.array.set(prevMesh.instanceMatrix.array.subarray(0, prevCount * 16));
      }
      if (prevMesh.instanceColor?.array && mesh.instanceColor?.array) {
        mesh.instanceColor.array.set(prevMesh.instanceColor.array.subarray(0, prevCount * 3));
      }
      opacityAttr.array.set(batch.opacityAttr.array.subarray(0, prevCount));
      rotationAttr.array.set(batch.rotationAttr.array.subarray(0, prevCount));
      if (prevMesh.parent) prevMesh.parent.remove(prevMesh);
      prevMesh.geometry?.dispose?.();
      prevMesh.material?.dispose?.();
    }

    this.spriteRoot.add(mesh);
    batch = {
      key,
      textureKey,
      depthTest,
      mesh,
      opacityAttr,
      rotationAttr,
      capacity: nextCapacity,
    };
    this.spriteBatches.set(key, batch);
    return batch;
  }

  resetSpriteBatches() {
    for (const batch of this.spriteBatches.values()) {
      batch.mesh.count = 0;
      batch.mesh.visible = false;
    }
  }

  createLightBundle(emitter) {
    const lightDescriptor = emitter?.light;
    const kind = String(lightDescriptor?.kind || '').toLowerCase();
    if (!kind) return null;

    switch (kind) {
      case 'point':
        return {
          light: new THREE.PointLight(0xffffff, 0, Math.max(0, Number(lightDescriptor.range) || 0), 2),
        };
      case 'ambient':
        return {
          light: new THREE.AmbientLight(0xffffff, 0),
        };
      case 'directional':
        return {
          light: new THREE.DirectionalLight(0xffffff, 0),
          target: new THREE.Object3D(),
        };
      case 'spot':
      case 'spotsoft':
        return {
          light: new THREE.SpotLight(
            0xffffff,
            0,
            Math.max(0, Number(lightDescriptor.range) || 0),
            calculateSpotAngle(lightDescriptor.directionAngle),
            kind === 'spotsoft' ? 0.5 : 0,
            2,
          ),
          target: new THREE.Object3D(),
        };
      default:
        return null;
    }
  }

  computeLosVisible(entry, camera, timeMs) {
    if (!entry.emitter.losCheck || !this.root) return true;
    if ((timeMs - entry.lastLosCheckMs) < MIN_LOS_INTERVAL_MS) return entry.losVisible;
    const occluders = this.getOccluderMeshes();
    if (occluders.length === 0) {
      entry.losVisible = true;
      entry.lastLosCheckMs = timeMs;
      return true;
    }

    TMP_POSITION.copy(toVector3(entry.emitter.position));
    TMP_RAY_ORIGIN.copy(camera.position);
    TMP_RAY_DIR.copy(TMP_POSITION).sub(TMP_RAY_ORIGIN);
    const distance = TMP_RAY_DIR.length();
    if (distance <= 0.0001) {
      entry.losVisible = true;
      entry.lastLosCheckMs = timeMs;
      return true;
    }
    TMP_RAY_DIR.multiplyScalar(1 / distance);
    this.raycaster.set(TMP_RAY_ORIGIN, TMP_RAY_DIR);
    this.raycaster.near = 0.01;
    this.raycaster.far = Math.max(0.01, distance - 0.5);

    const hits = this.raycaster.intersectObjects(occluders, false);
    const blockingHit = hits.find((hit) => doesHitBlockLos(hit)) || null;

    entry.losVisible = !blockingHit;
    entry.lastLosCheckMs = timeMs;
    return entry.losVisible;
  }

  update(camera, runtimeContext = {}) {
    this.setViewport(runtimeContext.viewportWidth || this.viewportWidth, runtimeContext.viewportHeight || this.viewportHeight);
    const updateContext = {
      ...runtimeContext,
      camera,
    };
    const timecycleValues = runtimeContext?.timecycleCurrent?.values || {};
    const foggyness = clamp01(runtimeContext?.timecycleCurrent?.foggyness ?? runtimeContext?.foggyness ?? 0);
    const spriteBrightnessValue = Number(timecycleValues.spriteBrightness);
    const spriteBrightness = Math.max(0, Number.isFinite(spriteBrightnessValue) ? spriteBrightnessValue : 1);
    const spriteSize = Math.max(0.5, Number(timecycleValues.spriteSize) || 1);
    const fadeConfig = runtimeContext?.distanceFade || DISTANCE_FADE_DEFAULTS;
    const timeMs = Number(runtimeContext?.timeMs) || 0;
    const sourceEntries = this.getFrameEntries(runtimeContext?.frameVisibility);
    const candidateEntries = [];
    const nextActiveEntries = new Set();
    const lightAssignments = [];
    const spriteAssignments = [];

    for (const entry of sourceEntries) {
      const emitter = entry.emitter;
      const visibility = shouldEmitterBeActive(entry, updateContext);
      const distance = camera.position.distanceTo(toVector3(emitter.position));
      const drawDistance = Math.max(0, Number(emitter.drawDistance) || 0);
      const withinDrawDistance = RenderEntityController.isWithinDrawDistance(distance, drawDistance, fadeConfig);
      const wantsShow = visibility.active && withinDrawDistance;
      if (wantsShow || RenderEntityController.isActive(entry, fadeConfig)) {
        candidateEntries.push({
          entry,
          visibility,
          distance,
          drawDistance,
          withinDrawDistance,
          wantsShow,
        });
      } else {
        if (entry.light) entry.light.visible = false;
      }
    }

    let activeBudget = Math.max(0, Math.floor(Number(runtimeContext?.twoDfx?.maxActiveCoronas) || MAX_ACTIVE_CORONAS));
    const selectedEntries = RenderEntityController.selectClosest(candidateEntries, activeBudget, fadeConfig);

    for (const item of candidateEntries) {
      const { entry, visibility, distance, drawDistance, withinDrawDistance } = item;
      const emitter = entry.emitter;
      let targetStreamAlpha = visibility.active && withinDrawDistance ? 1 : 0;
      if (!selectedEntries.has(entry)) targetStreamAlpha = 0;

      if (targetStreamAlpha > 0 && emitter.longDistance) {
        if (distance < 35) {
          targetStreamAlpha = 0;
        } else if (distance < 50) {
          targetStreamAlpha *= clamp01((distance - 35) / 15);
        }
      }

      const losVisible = targetStreamAlpha > 0 ? this.computeLosVisible(entry, camera, timeMs) : true;
      if (!losVisible) targetStreamAlpha = 0;

      const needsScreenTest = emitter.textureKey && (
        targetStreamAlpha > 0
        || entry.fadeAlpha > DISTANCE_FADE_DEFAULTS.epsilon
        || entry.streamAlpha > DISTANCE_FADE_DEFAULTS.epsilon
      );
      const currentScreen = needsScreenTest
        ? calcScreenCoorsLikeRw(camera, toVector3(emitter.position), this.viewportWidth, this.viewportHeight, true)
        : null;
      let screen = currentScreen;
      let screenVisible = Boolean(screen);
      if (emitter.textureKey && !screen) targetStreamAlpha = 0;
      if (emitter.textureKey && screen) {
        const offscreen = (
          screen.x < -OFFSCREEN_FADE_MARGIN
          || screen.x > (this.viewportWidth + OFFSCREEN_FADE_MARGIN)
          || screen.y < -OFFSCREEN_FADE_MARGIN
          || screen.y > (this.viewportHeight + OFFSCREEN_FADE_MARGIN)
        );
        if (offscreen) {
          targetStreamAlpha = 0;
          screenVisible = false;
        }
      } else if (emitter.textureKey) {
        screenVisible = false;
      }

      RenderEntityController.updateFade(entry, {
        targetVisible: targetStreamAlpha > 0,
        distance,
        drawDistance,
        dt: Number(runtimeContext?.dt) || 0,
        config: fadeConfig,
        extraAlpha: 1,
      });
      if (emitter.textureKey && screenVisible && screen && entry.fadeAlpha > DISTANCE_FADE_DEFAULTS.epsilon) {
        entry.lastScreen = {
          x: screen.x,
          y: screen.y,
          z: screen.z,
          recipZ: screen.recipZ,
          spriteW: screen.spriteW,
          spriteH: screen.spriteH,
        };
      } else if (emitter.textureKey && entry.fadeAlpha > DISTANCE_FADE_DEFAULTS.epsilon && entry.lastScreen) {
        screen = entry.lastScreen;
      }

      entry.spriteState = null;
      entry.lightState = null;
      if (emitter.textureKey) {
        const visible = this.enabled && entry.fadeAlpha > DISTANCE_FADE_DEFAULTS.epsilon && screenVisible;
        if (visible && screen) {
          const color = normalizeEmitterColor(emitter.color);
          const coronaAlpha = clamp01((Number(emitter.alpha) || 255) / 255);
          const trafficLightSettings = runtimeContext?.trafficLights || null;
          const trafficLightColorScale = emitter.sourceType === 'trafficLight'
            ? (spriteBrightness * Math.max(0, Number(trafficLightSettings?.brightnessScale) || 0.7))
            : 1;
          const fogScale = (foggyness * Math.min(screen.z, 40) / 40) + 1;
          const trafficLightSizeScale = emitter.sourceType === 'trafficLight'
            ? spriteSize * Math.max(0.1, Number(trafficLightSettings?.sizeScale) || 1.75)
            : 1;
          const worldSize = Math.max(0.01, Number(emitter.size) || 1) * trafficLightSizeScale * fogScale * 2;
          entry.spriteState = {
            textureKey: emitter.textureKey,
            depthTest: emitter.losCheck !== true,
            position: toVector3(emitter.position),
            scale: worldSize,
            color: {
              r: (color.r * trafficLightColorScale) / fogScale,
              g: (color.g * trafficLightColorScale) / fogScale,
              b: (color.b * trafficLightColorScale) / fogScale,
            },
            opacity: clamp01(entry.fadeAlpha * coronaAlpha),
            rotation: 20 * screen.recipZ,
            emitterId: emitter.id,
          };
          spriteAssignments.push(entry);
        } else if (entry.fadeAlpha <= DISTANCE_FADE_DEFAULTS.epsilon) {
          entry.lastScreen = null;
        }
      }

      if (entry.light) {
        const lightDescriptor = emitter.light || {};
        const visible = this.enabled
          && selectedEntries.has(entry)
          && visibility.active
          && withinDrawDistance
          && losVisible
          && entry.fadeAlpha > DISTANCE_FADE_DEFAULTS.epsilon;
        const color = normalizeEmitterColor(emitter.color);
        TMP_COLOR.setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace);
        const brightnessScale = lightDescriptor.colorScale === 'spriteBrightness'
          ? spriteBrightness
          : 1;
        if (visible) {
          entry.lightState = {
            distance,
            color: TMP_COLOR.clone(),
            intensity: (Number(lightDescriptor.intensity) || DEFAULT_POINT_LIGHT_INTENSITY) * brightnessScale * entry.fadeAlpha,
            position: toVector3(emitter.position),
            range: Math.max(0, Number(lightDescriptor.range) || 0),
            angle: calculateSpotAngle(lightDescriptor.directionAngle),
            penumbra: clamp01(Number(lightDescriptor.penumbra) || 0),
            direction: entry.lightTarget ? toVector3(emitter.direction, [0, 0, -1]).normalize() : null,
          };
          lightAssignments.push(entry);
        } else {
          entry.light.visible = false;
        }
      }

      if (entry.helperMesh) {
        entry.helperMesh.visible = this.enableDebugHelpers && this.debugShowAll;
        entry.helperMesh.position.copy(toVector3(emitter.position));
      }
      if (entry.helperLine) {
        const color = normalizeEmitterColor(emitter.color);
        const helperDirection = toVector3(emitter.direction, [0, 0, -1]).normalize();
        entry.helperLine.visible = this.enableDebugHelpers && this.debugShowAll;
        entry.helperLine.position.copy(toVector3(emitter.position));
        entry.helperLine.scale.setScalar(Math.max(1.5, Math.min(6, Number(emitter.radius) || Number(emitter.drawDistance) * 0.02 || 2.5)));
        TMP_LOOK_TARGET.copy(helperDirection).add(entry.helperLine.position);
        entry.helperLine.lookAt(TMP_LOOK_TARGET);
        entry.helperLine.material.color.setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace);
      }

      if (
        entry.fadeAlpha > DISTANCE_FADE_DEFAULTS.epsilon
        || entry.streamAlpha > DISTANCE_FADE_DEFAULTS.epsilon
        || entry.light?.visible
      ) {
        nextActiveEntries.add(entry);
      }
    }

    lightAssignments.sort((left, right) => left.lightState.distance - right.lightState.distance);
    const maxActiveLights = Math.max(
      0,
      Math.min(
        Math.floor(Number(runtimeContext?.twoDfx?.maxActiveCoronaLights) || MAX_ACTIVE_CORONA_LIGHTS),
        lightAssignments.length,
      ),
    );
    for (let index = 0; index < lightAssignments.length; index += 1) {
      const entry = lightAssignments[index];
      const lightState = entry.lightState;
      if (!entry.light || !lightState || index >= maxActiveLights) {
        if (entry.light) entry.light.visible = false;
        continue;
      }
      entry.light.color.copy(lightState.color);
      entry.light.visible = true;
      entry.light.intensity = lightState.intensity;
      entry.light.position.copy(lightState.position);
      if ('distance' in entry.light) {
        entry.light.distance = lightState.range;
      }
      if ('angle' in entry.light) {
        entry.light.angle = lightState.angle;
      }
      if ('penumbra' in entry.light) {
        entry.light.penumbra = lightState.penumbra;
      }
      if (entry.lightTarget && lightState.direction) {
        TMP_LOOK_TARGET.copy(lightState.position).addScaledVector(lightState.direction, Math.max(1, lightState.range || 10));
        entry.lightTarget.position.copy(TMP_LOOK_TARGET);
        entry.lightTarget.updateMatrixWorld(true);
      }
    }

    this.resetSpriteBatches();
    const spriteAssignmentsByBatch = new Map();
    for (const entry of spriteAssignments) {
      const spriteState = entry.spriteState;
      if (!spriteState) continue;
      const batchKey = this.getSpriteBatchKey(spriteState.textureKey, spriteState.depthTest);
      const batchEntries = spriteAssignmentsByBatch.get(batchKey) || [];
      batchEntries.push(spriteState);
      spriteAssignmentsByBatch.set(batchKey, batchEntries);
    }
    TMP_QUATERNION.copy(camera.quaternion);
    for (const [, batchEntries] of spriteAssignmentsByBatch.entries()) {
      const firstState = batchEntries[0];
      const batch = this.ensureSpriteBatchCapacity(firstState.textureKey, firstState.depthTest, batchEntries.length);
      batch.mesh.visible = batchEntries.length > 0;
      batch.mesh.count = batchEntries.length;
      for (let index = 0; index < batchEntries.length; index += 1) {
        const spriteState = batchEntries[index];
        TMP_SCALE.set(spriteState.scale, spriteState.scale, 1);
        TMP_POSITION.copy(spriteState.position);
        batch.mesh.setMatrixAt(index, new THREE.Matrix4().compose(TMP_POSITION, TMP_QUATERNION, TMP_SCALE));
        batch.mesh.setColorAt(index, TMP_COLOR.setRGB(
          spriteState.color.r,
          spriteState.color.g,
          spriteState.color.b,
          THREE.SRGBColorSpace,
        ));
        batch.opacityAttr.array[index] = spriteState.opacity;
        batch.rotationAttr.array[index] = spriteState.rotation;
      }
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
      batch.opacityAttr.needsUpdate = true;
      batch.rotationAttr.needsUpdate = true;
    }

    for (const entry of sourceEntries) {
      if (selectedEntries.has(entry)) continue;
      if (entry.light) entry.light.visible = false;
      if (
        entry.fadeAlpha > DISTANCE_FADE_DEFAULTS.epsilon
        || entry.streamAlpha > DISTANCE_FADE_DEFAULTS.epsilon
      ) {
        nextActiveEntries.add(entry);
      }
    }
    this.activeEntries = nextActiveEntries;
    this.debugStats.candidateCount = candidateEntries.length;
    this.debugStats.activeCount = this.activeEntries.size;
  }

  render(renderer, camera) {
    if (!renderer || !camera || !this.enabled) return;
    this.renderScene.updateMatrixWorld(true);
    renderer.render(this.renderScene, camera);
  }

  disposeEntries() {
    for (const entry of this.entries) {
      if (entry.light?.parent) entry.light.parent.remove(entry.light);
      if (entry.lightTarget?.parent) entry.lightTarget.parent.remove(entry.lightTarget);
      if (entry.helperMesh?.parent) entry.helperMesh.parent.remove(entry.helperMesh);
      if (entry.helperMesh?.material) entry.helperMesh.material.dispose();
      if (entry.helperLine?.parent) entry.helperLine.parent.remove(entry.helperLine);
      if (entry.helperLine?.geometry) entry.helperLine.geometry.dispose();
      if (entry.helperLine?.material) entry.helperLine.material.dispose();
      entry.light?.dispose?.();
      entry.lightTarget = null;
      entry.light = null;
      entry.helperMesh = null;
      entry.helperLine = null;
      entry.lightState = null;
      entry.spriteState = null;
    }
    this.entries = [];
    this.entryByEmitter = new WeakMap();
    this.activeEntries.clear();
    this.resetSpriteBatches();
  }

  dispose() {
    this.disposeEntries();
    for (const batch of this.spriteBatches.values()) {
      if (batch?.mesh?.parent) batch.mesh.parent.remove(batch.mesh);
      batch?.mesh?.geometry?.dispose?.();
      batch?.mesh?.material?.dispose?.();
    }
    this.spriteBatches.clear();
    if (this.lightRoot.parent) this.lightRoot.parent.remove(this.lightRoot);
    if (this.spriteRoot.parent) this.spriteRoot.parent.remove(this.spriteRoot);
    if (this.debugRoot.parent) this.debugRoot.parent.remove(this.debugRoot);
  }
}

export default RWCoronaPipeline;
