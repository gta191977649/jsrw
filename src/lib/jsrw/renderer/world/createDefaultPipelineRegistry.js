import * as THREE from 'three';
import { uniform } from 'three/tsl';
import { cloneRwMaterialDescriptor } from '../../core/material/RwMaterialDescriptor.js';
import {
  RW_PIPELINE_CATEGORY,
  RW_PIPELINE_GAME,
  RW_PIPELINE_PLATFORM,
  RW_PIPELINE_SELECTION_DEFAULTS,
} from '../../core/pipeline/constants.js';
import { RWPipelineRegistry } from '../../core/pipeline/registry.js';
import {
  createThreeMaterialFromRW,
  getRWMaterialDescriptor,
  setRWMaterialDescriptor,
} from '../../adapters/three/ThreeMaterialAdapter.js';
import { PostFxRuntime } from '../postfx/PostFxRuntime.js';
import { createRwBuildingNodeMaterial } from '../../../../shaders/rw-building.node.js';

let sharedWhiteTexture = null;
let defaultRegistry = null;

function getSharedWhiteTexture() {
  if (sharedWhiteTexture) return sharedWhiteTexture;
  const data = new Uint8Array([255, 255, 255, 255]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  texture.name = '__rw_pipeline_white__';
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  sharedWhiteTexture = texture;
  return sharedWhiteTexture;
}

function ensureVertexColors(geometry) {
  if (!geometry?.isBufferGeometry) return false;
  const existing = geometry.getAttribute('color');
  if (existing) return true;
  const position = geometry.getAttribute('position');
  if (!position || !Number.isFinite(position.count) || position.count <= 0) return false;
  const colors = new Float32Array(position.count * 4);
  for (let index = 0; index < position.count; index += 1) {
    const offset = index * 4;
    colors[offset + 0] = 1;
    colors[offset + 1] = 1;
    colors[offset + 2] = 1;
    colors[offset + 3] = 1;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  return true;
}

function ensureUvs(geometry) {
  if (!geometry?.isBufferGeometry) return false;
  const existing = geometry.getAttribute('uv');
  if (existing) return true;
  const position = geometry.getAttribute('position');
  if (!position || !Number.isFinite(position.count) || position.count <= 0) return false;
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
  return true;
}

function cloneSurfaceProps(surfaceProps) {
  return {
    ambient: Number.isFinite(surfaceProps?.ambient) ? surfaceProps.ambient : 1,
    specular: Number.isFinite(surfaceProps?.specular) ? surfaceProps.specular : 0,
    diffuse: Number.isFinite(surfaceProps?.diffuse) ? surfaceProps.diffuse : 1,
  };
}

function updateMaterialColorVector(target, source) {
  if (!target) return;
  const r = Number(source?.r ?? source?.x ?? 1);
  const g = Number(source?.g ?? source?.y ?? 1);
  const b = Number(source?.b ?? source?.z ?? 1);
  if (typeof target.set === 'function') {
    target.set(r, g, b);
    return;
  }
  target.x = r;
  target.y = g;
  target.z = b;
}

function createLeedsVcsBuildingMaterial(profile, input) {
  const descriptor = cloneRwMaterialDescriptor(input.descriptor);
  ensureVertexColors(input.geometry);
  ensureUvs(input.geometry);
  const sharedUniforms = profile.sharedUniforms;
  const material = createRwBuildingNodeMaterial({
    descriptor,
    sharedUniforms,
    surfaceEmissiveScale: Number(profile.config?.surfaceEmissiveScale) || 0,
    platformVariant: profile.platform === RW_PIPELINE_PLATFORM.PSP ? 1 : 0,
    fallbackTexture: getSharedWhiteTexture(),
  });
  const pipelineDescriptor = cloneRwMaterialDescriptor(descriptor);
  pipelineDescriptor.pipeline = profile.id;
  pipelineDescriptor.surfaceProps = cloneSurfaceProps(descriptor.surfaceProps);
  setRWMaterialDescriptor(material, pipelineDescriptor);
  material.userData = {
    ...(material.userData || {}),
    rwPipelineOwnedMaterial: true,
    rwPipelineMaterial: true,
    rwPipelineProfileId: profile.id,
    rwPipelineCategory: profile.category,
    rwPipelineGame: profile.game,
    rwPipelinePlatform: profile.platform,
    rwPipelineUsesThreeFog: true,
  };
  return material;
}

function updateLeedsVcsBuildingMaterial(profile, material) {
  const descriptor = getRWMaterialDescriptor(material);
  const uniforms = material.userData?.rwPipelineUniforms;
  if (!material || !uniforms) return;
  uniforms.uSurfaceEmissiveScale.value = Number(profile.config?.surfaceEmissiveScale) || 0;
  uniforms.uUseVertexColor.value = !descriptor?.rwFlags?.forceIgnoreVertexColor && descriptor?.useVertexColors !== false ? 1 : 0;
  uniforms.uPlatformVariant.value = profile.platform === RW_PIPELINE_PLATFORM.PSP ? 1 : 0;
  uniforms.uColorScale.value = descriptor?.map ? (255 / 128) : 1;
  uniforms.uMap.value = descriptor?.map || getSharedWhiteTexture();
  material.map = descriptor?.map || getSharedWhiteTexture();
  material.transparent = descriptor?.transparent === true;
  material.depthTest = descriptor?.depthTest !== false;
  material.depthWrite = descriptor?.depthWrite !== false;
  material.blending = descriptor?.blending ?? THREE.NormalBlending;
  material.side = descriptor?.side ?? THREE.DoubleSide;
  material.wireframe = Boolean(descriptor?.wireframe);
  material.opacity = descriptor?.opacity ?? 1;
  material.alphaTest = descriptor?.alphaRef ?? 0;
  material.fog = true;
}

function updateLeedsVcsBuildingRuntime(profile, runtimeContext = {}) {
  const ambientValue = runtimeContext.ambientColor || runtimeContext.fallbackAmbient || new THREE.Color(1, 1, 1);
  const emissiveValue = runtimeContext.emissiveColor || runtimeContext.fallbackEmissive || new THREE.Color(0, 0, 0);
  updateMaterialColorVector(profile.sharedUniforms.uAmb?.value, ambientValue);
  updateMaterialColorVector(profile.sharedUniforms.uEmiss?.value, emissiveValue);
}

function createLeedsVcsBuildingProfile(options) {
  return {
    kind: 'material',
    id: options.id,
    label: options.label,
    game: RW_PIPELINE_GAME.VCS,
    category: RW_PIPELINE_CATEGORY.BUILDING,
    platform: options.platform,
    config: {
      surfaceEmissiveScale: options.surfaceEmissiveScale,
    },
    sharedUniforms: {
      uAmb: uniform(new THREE.Vector3(1, 1, 1)),
      uEmiss: uniform(new THREE.Vector3(0, 0, 0)),
    },
    isApplicable(targetMeta) {
      return Boolean(targetMeta && targetMeta.category === RW_PIPELINE_CATEGORY.BUILDING && targetMeta.game === RW_PIPELINE_GAME.VCS && targetMeta.isTobj !== true);
    },
    backends: {
      WEBGL: {
        createMaterial(input) {
          return createLeedsVcsBuildingMaterial(this.profile, input);
        },
        updateMaterial(material, runtimeContext) {
          updateLeedsVcsBuildingMaterial(this.profile, material, runtimeContext);
        },
        updateRuntime(runtimeContext) {
          updateLeedsVcsBuildingRuntime(this.profile, runtimeContext);
        },
      },
      WEBGPU: {
        createMaterial(input) {
          return createLeedsVcsBuildingMaterial(this.profile, input);
        },
        updateMaterial(material, runtimeContext) {
          updateLeedsVcsBuildingMaterial(this.profile, material, runtimeContext);
        },
        updateRuntime(runtimeContext) {
          updateLeedsVcsBuildingRuntime(this.profile, runtimeContext);
        },
      },
    },
  };
}

function createVcsPostFxProfile(options) {
  return {
    kind: 'postfx',
    id: options.id,
    label: options.label,
    game: RW_PIPELINE_GAME.VCS,
    category: RW_PIPELINE_CATEGORY.POSTFX,
    platform: RW_PIPELINE_PLATFORM.VCS,
    config: {
      ...(options.config || {}),
    },
    isApplicable() {
      return true;
    },
    backends: {
      WEBGL: {
        createEffect({ backend }) {
          return new PostFxRuntime({
            backend,
            config: this.profile.config,
          });
        },
        applyConfig(effect, selection) {
          effect?.setConfig?.({
            ...this.profile.config,
            ...(selection?.config || {}),
          });
        },
        updateRuntime(runtimeContext, effect) {
          effect?.setBackend?.(runtimeContext.backend || null);
          effect?.updateRuntime(runtimeContext);
        },
        disposeEffect(effect) {
          effect?.dispose?.();
        },
      },
      WEBGPU: {
        createEffect({ backend }) {
          return new PostFxRuntime({
            backend,
            config: this.profile.config,
          });
        },
        applyConfig(effect, selection) {
          effect?.setConfig?.({
            ...this.profile.config,
            ...(selection?.config || {}),
          });
        },
        updateRuntime(runtimeContext, effect) {
          effect?.setBackend?.(runtimeContext.backend || null);
          effect?.updateRuntime(runtimeContext);
        },
        disposeEffect(effect) {
          effect?.dispose?.();
        },
      },
    },
  };
}

function bindBackendImplementations(registry) {
  for (const profile of registry.list()) {
    for (const implementation of Object.values(profile.backends || {})) {
      if (!implementation) continue;
      implementation.profile = profile;
    }
  }
}

export function createDefaultRWPipelineRegistry() {
  const registry = new RWPipelineRegistry();
  registry.register(createLeedsVcsBuildingProfile({
    id: 'leeds-vcs-building-ps2',
    label: 'Leeds / VCS / Building / PS2',
    platform: RW_PIPELINE_PLATFORM.PS2,
    surfaceEmissiveScale: 0.5,
  }));
  registry.register(createLeedsVcsBuildingProfile({
    id: 'leeds-vcs-building-psp',
    label: 'Leeds / VCS / Building / PSP',
    platform: RW_PIPELINE_PLATFORM.PSP,
    surfaceEmissiveScale: 1.0,
  }));
  registry.register(createVcsPostFxProfile({
    id: 'vcs-postfx-vcs',
    label: 'VCS / PostFX / VCS',
    config: RW_PIPELINE_SELECTION_DEFAULTS[RW_PIPELINE_CATEGORY.POSTFX].config,
  }));
  bindBackendImplementations(registry);
  return registry;
}

export function getDefaultRWPipelineRegistry() {
  if (!defaultRegistry) defaultRegistry = createDefaultRWPipelineRegistry();
  return defaultRegistry;
}

export function createRWPipelineMaterialForProfile(profileId, input) {
  const profile = getDefaultRWPipelineRegistry().get(profileId);
  const requestedBackend = String(
    input?.runtimeContext?.activeBackend
    || input?.activeBackend
    || input?.backendId
    || 'WEBGL',
  ).toUpperCase();
  const implementation = profile?.backends?.[requestedBackend]
    || profile?.backends?.WEBGL
    || profile?.backends?.WEBGPU
    || null;
  if (!profile || !implementation?.createMaterial) return null;
  const material = implementation.createMaterial(input);
  implementation.updateMaterial?.(material, input?.runtimeContext);
  material.userData = {
    ...(material.userData || {}),
    rwPipelineBackend: requestedBackend,
  };
  return material;
}

export function createBasicMaterialFromDescriptor(descriptor, geometry) {
  return createThreeMaterialFromRW(cloneRwMaterialDescriptor(descriptor), geometry);
}
