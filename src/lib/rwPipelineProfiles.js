import * as THREE from 'three';
import {
  cloneRWMaterialDescriptor,
  createThreeMaterialFromRW,
  getRWMaterialDescriptor,
  setRWMaterialDescriptor,
} from './RWRender';
import sharedLeedsBuildingFragmentShader from '../shaders/building/leeds/vcs/shared.fragment.glsl.js';
import leedsVcsPs2BuildingVertexShader from '../shaders/building/leeds/vcs/ps2.vertex.glsl.js';
import leedsVcsPspBuildingVertexShader from '../shaders/building/leeds/vcs/psp.vertex.glsl.js';

export const RW_PIPELINE_GAME = Object.freeze({
  DEFAULT: 'DEFAULT',
  VCS: 'VCS',
  SA: 'SA',
});

export const RW_PIPELINE_CATEGORY = Object.freeze({
  BUILDING: 'building',
});

export const RW_PIPELINE_PLATFORM = Object.freeze({
  DEFAULT: 'DEFAULT',
  PS2: 'PS2',
  PSP: 'PSP',
  PC: 'PC',
});

export const RW_PIPELINE_SELECTION_DEFAULT = Object.freeze({
  enabled: false,
  game: RW_PIPELINE_GAME.DEFAULT,
  category: RW_PIPELINE_CATEGORY.BUILDING,
  platform: RW_PIPELINE_PLATFORM.DEFAULT,
});

const RW_PIPELINE_GAME_OPTIONS = Object.freeze([
  RW_PIPELINE_GAME.DEFAULT,
  RW_PIPELINE_GAME.VCS,
  RW_PIPELINE_GAME.SA,
]);

const RW_PIPELINE_CATEGORY_OPTIONS = Object.freeze([
  RW_PIPELINE_CATEGORY.BUILDING,
]);

const RW_PIPELINE_PLATFORM_OPTIONS = Object.freeze({
  [RW_PIPELINE_GAME.DEFAULT]: [RW_PIPELINE_PLATFORM.DEFAULT],
  [RW_PIPELINE_GAME.VCS]: [RW_PIPELINE_PLATFORM.DEFAULT, RW_PIPELINE_PLATFORM.PS2, RW_PIPELINE_PLATFORM.PSP],
  [RW_PIPELINE_GAME.SA]: [RW_PIPELINE_PLATFORM.DEFAULT, RW_PIPELINE_PLATFORM.PS2, RW_PIPELINE_PLATFORM.PC],
});

function clampPipelineValue(value, validValues, fallback) {
  return validValues.includes(value) ? value : fallback;
}

export function cloneRWPipelineSelection(selection = RW_PIPELINE_SELECTION_DEFAULT) {
  const game = clampPipelineValue(
    String(selection.game || '').toUpperCase(),
    RW_PIPELINE_GAME_OPTIONS,
    RW_PIPELINE_SELECTION_DEFAULT.game,
  );
  const category = clampPipelineValue(
    String(selection.category || ''),
    RW_PIPELINE_CATEGORY_OPTIONS,
    RW_PIPELINE_SELECTION_DEFAULT.category,
  );
  const platform = clampPipelineValue(
    String(selection.platform || '').toUpperCase(),
    RW_PIPELINE_PLATFORM_OPTIONS[game] || RW_PIPELINE_PLATFORM_OPTIONS[RW_PIPELINE_GAME.DEFAULT],
    RW_PIPELINE_SELECTION_DEFAULT.platform,
  );
  return {
    enabled: Boolean(selection.enabled),
    game,
    category,
    platform,
  };
}

export function getRWPipelineGameOptions() {
  return [...RW_PIPELINE_GAME_OPTIONS];
}

export function getRWPipelineCategoryOptions() {
  return [...RW_PIPELINE_CATEGORY_OPTIONS];
}

export function getRWPipelinePlatformOptions(game, category = RW_PIPELINE_CATEGORY.BUILDING) {
  if (category !== RW_PIPELINE_CATEGORY.BUILDING) return [RW_PIPELINE_PLATFORM.DEFAULT];
  return [...(RW_PIPELINE_PLATFORM_OPTIONS[String(game || '').toUpperCase()] || [RW_PIPELINE_PLATFORM.DEFAULT])];
}

let sharedWhiteTexture = null;

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

function ensureUniform(uniforms, key, fallbackFactory) {
  const current = uniforms[key];
  if (current && typeof current === 'object' && 'value' in current) {
    return current;
  }
  const fallbackValue = typeof fallbackFactory === 'function' ? fallbackFactory() : fallbackFactory;
  const next = { value: fallbackValue };
  uniforms[key] = next;
  return next;
}

function ensureLeedsUniforms(uniforms) {
  ensureUniform(uniforms, 'diffuse', () => new THREE.Color(0xffffff));
  ensureUniform(uniforms, 'opacity', 1);
  ensureUniform(uniforms, 'map', () => getSharedWhiteTexture());
  ensureUniform(uniforms, 'mapTransform', () => new THREE.Matrix3());
  ensureUniform(uniforms, 'alphaMap', null);
  ensureUniform(uniforms, 'alphaMapTransform', () => new THREE.Matrix3());
  ensureUniform(uniforms, 'alphaTest', 0);
  ensureUniform(uniforms, 'uColorScale', 1);
  ensureUniform(uniforms, 'uAmb', () => new THREE.Vector3(1, 1, 1));
  ensureUniform(uniforms, 'uEmiss', () => new THREE.Vector3(0, 0, 0));
  ensureUniform(uniforms, 'uSurfaceEmissiveScale', 0);
  ensureUniform(uniforms, 'uUseVertexColor', false);
  ensureUniform(uniforms, 'uFogEnabled', false);
  ensureUniform(uniforms, 'uFogColor', () => new THREE.Color(0, 0, 0));
  ensureUniform(uniforms, 'uFogFar', 1);
  ensureUniform(uniforms, 'uFogRange', 0);
  return uniforms;
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

function createLeedsVcsBuildingMaterial(profile, input) {
  const descriptor = cloneRWMaterialDescriptor(input.descriptor);
  ensureVertexColors(input.geometry);
  ensureUvs(input.geometry);

  const hasTexture = Boolean(descriptor.map?.isTexture);
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.common,
    {
      uColorScale: { value: hasTexture ? (255 / 128) : 1 },
      uAmb: { value: new THREE.Vector3(1, 1, 1) },
      uEmiss: { value: new THREE.Vector3(0, 0, 0) },
      uSurfaceEmissiveScale: { value: Number(profile.config?.surfaceEmissiveScale) || 0 },
      uUseVertexColor: { value: !descriptor.rwFlags?.forceIgnoreVertexColor && descriptor.useVertexColors !== false },
      uFogEnabled: { value: false },
      uFogColor: { value: new THREE.Color(0, 0, 0) },
      uFogFar: { value: 1 },
      uFogRange: { value: 0 },
    },
  ]);
  ensureLeedsUniforms(uniforms);
  uniforms.map.value = descriptor.map || getSharedWhiteTexture();
  uniforms.opacity.value = descriptor.opacity ?? 1;
  uniforms.alphaTest.value = descriptor.alphaRef ?? 0;
  const material = new THREE.ShaderMaterial({
    name: descriptor.name || '',
    uniforms,
    vertexShader: profile.shaders.vertex,
    fragmentShader: profile.shaders.fragment,
    side: descriptor.side,
    transparent: descriptor.transparent,
    depthTest: descriptor.depthTest !== false,
    depthWrite: descriptor.depthWrite !== false,
    blending: descriptor.blending ?? THREE.NormalBlending,
    vertexColors: true,
    fog: false,
    toneMapped: false,
    wireframe: Boolean(descriptor.wireframe),
  });

  material.opacity = descriptor.opacity ?? 1;
  material.alphaTest = descriptor.alphaRef ?? 0;
  material.extensions = { derivatives: false };
  material.customProgramCacheKey = () => profile.id;

  const pipelineDescriptor = cloneRWMaterialDescriptor(descriptor);
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
    rwPipelineBackend: profile.backend,
  };

  return material;
}

function updateMaterialColorVector(target, source) {
  if (!target) return;
  const r = Number(source?.r ?? source?.x ?? 1);
  const g = Number(source?.g ?? source?.y ?? 1);
  const b = Number(source?.b ?? source?.z ?? 1);
  target.set(r, g, b);
}

function updateLeedsVcsBuildingMaterial(profile, material, runtimeContext = {}) {
  if (!material?.uniforms) return;
  const descriptor = getRWMaterialDescriptor(material);
  const uniforms = ensureLeedsUniforms(material.uniforms);
  const ambientValue = runtimeContext.ambientColor || runtimeContext.fallbackAmbient || new THREE.Color(1, 1, 1);
  const emissiveValue = runtimeContext.emissiveColor || runtimeContext.fallbackEmissive || new THREE.Color(0, 0, 0);

  updateMaterialColorVector(uniforms.uAmb?.value, ambientValue);
  updateMaterialColorVector(uniforms.uEmiss?.value, emissiveValue);
  uniforms.uSurfaceEmissiveScale.value = Number(profile.config?.surfaceEmissiveScale) || 0;
  uniforms.uUseVertexColor.value = !descriptor?.rwFlags?.forceIgnoreVertexColor && descriptor?.useVertexColors !== false;
  uniforms.opacity.value = descriptor?.opacity ?? material.opacity ?? 1;
  uniforms.alphaTest.value = descriptor?.alphaRef ?? material.alphaTest ?? 0;
  uniforms.uColorScale.value = descriptor?.map ? (255 / 128) : 1;
  uniforms.map.value = descriptor?.map || getSharedWhiteTexture();
  uniforms.uFogEnabled.value = false;
  uniforms.uFogRange.value = 0;
  uniforms.uFogFar.value = 1;
  if (uniforms.uFogColor?.value?.setRGB) {
    uniforms.uFogColor.value.setRGB(0, 0, 0);
  }

  material.transparent = descriptor?.transparent === true;
  material.depthTest = descriptor?.depthTest !== false;
  material.depthWrite = descriptor?.depthWrite !== false;
  material.blending = descriptor?.blending ?? THREE.NormalBlending;
  material.side = descriptor?.side ?? THREE.DoubleSide;
  material.wireframe = Boolean(descriptor?.wireframe);
  material.opacity = descriptor?.opacity ?? 1;
  material.uniformsNeedUpdate = true;
}

function createLeedsVcsBuildingProfile(options) {
  return {
    id: options.id,
    label: options.label,
    game: RW_PIPELINE_GAME.VCS,
    category: RW_PIPELINE_CATEGORY.BUILDING,
    platform: options.platform,
    backend: 'WebGL',
    config: {
      surfaceEmissiveScale: options.surfaceEmissiveScale,
    },
    shaders: {
      vertex: options.vertexShader,
      fragment: sharedLeedsBuildingFragmentShader,
    },
    isApplicable(targetMeta) {
      return Boolean(
        targetMeta
        && targetMeta.category === RW_PIPELINE_CATEGORY.BUILDING
        && targetMeta.game === RW_PIPELINE_GAME.VCS
        && targetMeta.isTobj !== true,
      );
    },
    createMaterial(input) {
      return createLeedsVcsBuildingMaterial(this, input);
    },
    updateMaterial(material, runtimeContext) {
      updateLeedsVcsBuildingMaterial(this, material, runtimeContext);
    },
  };
}

export class RWPipelineRegistry {
  constructor() {
    this.profiles = new Map();
  }

  register(profile) {
    if (!profile?.id) {
      throw new Error('RWPipelineRegistry: profile.id is required');
    }
    this.profiles.set(profile.id, profile);
    return profile;
  }

  list() {
    return [...this.profiles.values()];
  }

  resolve(selection) {
    const normalized = cloneRWPipelineSelection(selection);
    if (!normalized.enabled) return null;
    for (const profile of this.profiles.values()) {
      if (
        profile.game === normalized.game
        && profile.category === normalized.category
        && profile.platform === normalized.platform
      ) {
        return profile;
      }
    }
    return null;
  }
}

export function createDefaultRWPipelineRegistry() {
  const registry = new RWPipelineRegistry();
  registry.register(createLeedsVcsBuildingProfile({
    id: 'leeds-vcs-building-ps2',
    label: 'Leeds / VCS / Building / PS2',
    platform: RW_PIPELINE_PLATFORM.PS2,
    surfaceEmissiveScale: 0.5,
    vertexShader: leedsVcsPs2BuildingVertexShader,
  }));
  registry.register(createLeedsVcsBuildingProfile({
    id: 'leeds-vcs-building-psp',
    label: 'Leeds / VCS / Building / PSP',
    platform: RW_PIPELINE_PLATFORM.PSP,
    surfaceEmissiveScale: 1.0,
    vertexShader: leedsVcsPspBuildingVertexShader,
  }));
  return registry;
}

export function createBasicMaterialFromDescriptor(descriptor, geometry) {
  return createThreeMaterialFromRW(cloneRWMaterialDescriptor(descriptor), geometry);
}
