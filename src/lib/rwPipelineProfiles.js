import * as THREE from 'three';
import {
  cloneRWMaterialDescriptor,
  createThreeMaterialFromRW,
  getRWMaterialDescriptor,
  setRWMaterialDescriptor,
} from './RWRender';
import { RWPostFxPipeline } from './RWPostFxPipeline';

export const RW_PIPELINE_GAME = Object.freeze({
  DEFAULT: 'DEFAULT',
  VCS: 'VCS',
  LCS: 'LCS',
  SA: 'SA',
});

export const RW_PIPELINE_CATEGORY = Object.freeze({
  BUILDING: 'building',
  POSTFX: 'postfx',
});

export const RW_PIPELINE_PLATFORM = Object.freeze({
  DEFAULT: 'DEFAULT',
  PS2: 'PS2',
  PSP: 'PSP',
  PC: 'PC',
  VCS: 'VCS',
  LCS: 'LCS',
});

export const RW_PIPELINE_SELECTION_DEFAULT = Object.freeze({
  enabled: false,
  game: RW_PIPELINE_GAME.DEFAULT,
  category: RW_PIPELINE_CATEGORY.BUILDING,
  platform: RW_PIPELINE_PLATFORM.PS2,
});

export const RW_PIPELINE_SELECTION_DEFAULTS = Object.freeze({
  [RW_PIPELINE_CATEGORY.BUILDING]: Object.freeze({
    enabled: false,
    game: RW_PIPELINE_GAME.DEFAULT,
    category: RW_PIPELINE_CATEGORY.BUILDING,
    platform: RW_PIPELINE_PLATFORM.PS2,
  }),
  [RW_PIPELINE_CATEGORY.POSTFX]: Object.freeze({
    enabled: false,
    game: RW_PIPELINE_GAME.DEFAULT,
    category: RW_PIPELINE_CATEGORY.POSTFX,
    platform: RW_PIPELINE_PLATFORM.VCS,
    config: Object.freeze({
      trailsLimit: 80,
      trailsIntensity: 38,
      radiosityResolutionDivisor: 4,
      blurOffset: 2.1,
      blurIntensity: (39.0 * 0.8) / 255.0,
      historyIntensity: 32 / 255.0,
      enableTrails: true,
      enableColorFilter: false,
      enableBigBloomSunEffect: true,
      enableRadiosity: true,
      enableBlur: true,
      debugView: 'final',
    }),
  }),
});

const RW_PIPELINE_GAME_OPTIONS = Object.freeze([
  RW_PIPELINE_GAME.DEFAULT,
  RW_PIPELINE_GAME.VCS,
  RW_PIPELINE_GAME.LCS,
  RW_PIPELINE_GAME.SA,
]);

const RW_PIPELINE_CATEGORY_OPTIONS = Object.freeze([
  RW_PIPELINE_CATEGORY.BUILDING,
  RW_PIPELINE_CATEGORY.POSTFX,
]);

const RW_PIPELINE_PLATFORM_OPTIONS = Object.freeze({
  [RW_PIPELINE_CATEGORY.BUILDING]: Object.freeze({
    [RW_PIPELINE_GAME.DEFAULT]: [RW_PIPELINE_PLATFORM.PS2, RW_PIPELINE_PLATFORM.PSP, RW_PIPELINE_PLATFORM.PC, RW_PIPELINE_PLATFORM.DEFAULT],
    [RW_PIPELINE_GAME.VCS]: [RW_PIPELINE_PLATFORM.DEFAULT, RW_PIPELINE_PLATFORM.PS2, RW_PIPELINE_PLATFORM.PSP],
    [RW_PIPELINE_GAME.LCS]: [RW_PIPELINE_PLATFORM.DEFAULT, RW_PIPELINE_PLATFORM.PS2, RW_PIPELINE_PLATFORM.PSP],
    [RW_PIPELINE_GAME.SA]: [RW_PIPELINE_PLATFORM.DEFAULT, RW_PIPELINE_PLATFORM.PS2, RW_PIPELINE_PLATFORM.PC],
  }),
  [RW_PIPELINE_CATEGORY.POSTFX]: Object.freeze({
    [RW_PIPELINE_GAME.DEFAULT]: [RW_PIPELINE_PLATFORM.VCS, RW_PIPELINE_PLATFORM.LCS, RW_PIPELINE_PLATFORM.DEFAULT],
    [RW_PIPELINE_GAME.VCS]: [RW_PIPELINE_PLATFORM.VCS, RW_PIPELINE_PLATFORM.DEFAULT],
    [RW_PIPELINE_GAME.LCS]: [RW_PIPELINE_PLATFORM.LCS, RW_PIPELINE_PLATFORM.DEFAULT],
    [RW_PIPELINE_GAME.SA]: [RW_PIPELINE_PLATFORM.DEFAULT],
  }),
});

function clampPipelineValue(value, validValues, fallback) {
  return validValues.includes(value) ? value : fallback;
}

function getSelectionDefault(category = RW_PIPELINE_CATEGORY.BUILDING) {
  return RW_PIPELINE_SELECTION_DEFAULTS[category] || RW_PIPELINE_SELECTION_DEFAULT;
}

function getPlatformOptionsFor(category, game) {
  const categoryOptions = RW_PIPELINE_PLATFORM_OPTIONS[category] || RW_PIPELINE_PLATFORM_OPTIONS[RW_PIPELINE_CATEGORY.BUILDING];
  return categoryOptions[String(game || '').toUpperCase()] || categoryOptions[RW_PIPELINE_GAME.DEFAULT] || [RW_PIPELINE_PLATFORM.DEFAULT];
}

export function cloneRWPipelineSelection(selection = RW_PIPELINE_SELECTION_DEFAULT) {
  const defaultSelection = getSelectionDefault(String(selection?.category || RW_PIPELINE_CATEGORY.BUILDING));
  const game = clampPipelineValue(
    String(selection.game || '').toUpperCase(),
    RW_PIPELINE_GAME_OPTIONS,
    defaultSelection.game,
  );
  const category = clampPipelineValue(
    String(selection.category || ''),
    RW_PIPELINE_CATEGORY_OPTIONS,
    defaultSelection.category,
  );
  const platform = clampPipelineValue(
    String(selection.platform || '').toUpperCase(),
    getPlatformOptionsFor(category, game),
    defaultSelection.platform,
  );
  return {
    enabled: Boolean(selection.enabled),
    game,
    category,
    platform,
    ...(defaultSelection.config || selection?.config
      ? {
        config: {
          ...(defaultSelection.config || {}),
          ...(selection?.config || {}),
        },
      }
      : {}),
  };
}

export function cloneRWPipelineSelections(selections = RW_PIPELINE_SELECTION_DEFAULTS) {
  const next = {};
  for (const category of RW_PIPELINE_CATEGORY_OPTIONS) {
    next[category] = cloneRWPipelineSelection({
      ...getSelectionDefault(category),
      ...(selections?.[category] || {}),
      category,
    });
  }
  return next;
}

export function getRWPipelineGameOptions() {
  return [...RW_PIPELINE_GAME_OPTIONS];
}

export function getRWPipelineCategoryOptions() {
  return [...RW_PIPELINE_CATEGORY_OPTIONS];
}

export function getRWPipelinePlatformOptions(game, category = RW_PIPELINE_CATEGORY.BUILDING) {
  return [...getPlatformOptionsFor(category, game)];
}

export function resolveRWPipelineSelection(selection, worldGameVersion) {
  const normalized = cloneRWPipelineSelection(selection);
  const resolvedGame = normalized.game === RW_PIPELINE_GAME.DEFAULT
    ? clampPipelineValue(
      String(worldGameVersion || '').toUpperCase(),
      RW_PIPELINE_GAME_OPTIONS.filter((option) => option !== RW_PIPELINE_GAME.DEFAULT),
      RW_PIPELINE_GAME.VCS,
    )
    : normalized.game;

  const validPlatforms = getPlatformOptionsFor(normalized.category, resolvedGame);
  const resolvedPlatform = validPlatforms.includes(normalized.platform)
    ? normalized.platform
    : (validPlatforms[0] || RW_PIPELINE_PLATFORM.DEFAULT);

  return {
    ...normalized,
    game: resolvedGame,
    platform: resolvedPlatform,
  };
}

export function resolveRWPipelineSelections(selections, worldGameVersion) {
  const next = {};
  const normalizedSelections = cloneRWPipelineSelections(selections);
  for (const category of RW_PIPELINE_CATEGORY_OPTIONS) {
    next[category] = resolveRWPipelineSelection(normalizedSelections[category], worldGameVersion);
  }
  return next;
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
  const sharedUniforms = profile.sharedUniforms;

  const material = new THREE.MeshBasicMaterial({
    name: descriptor.name || '',
    map: descriptor.map || getSharedWhiteTexture(),
    alphaMap: null,
    color: new THREE.Color(1, 1, 1),
    transparent: descriptor.transparent,
    opacity: descriptor.opacity ?? 1,
    alphaTest: descriptor.alphaRef ?? 0,
    side: descriptor.side,
    depthTest: descriptor.depthTest !== false,
    depthWrite: descriptor.depthWrite !== false,
    blending: descriptor.blending ?? THREE.NormalBlending,
    vertexColors: true,
    fog: true,
    toneMapped: false,
    wireframe: Boolean(descriptor.wireframe),
  });
  material.color.setRGB(1, 1, 1);
  material.userData = {
    ...(material.userData || {}),
    rwPipelineUniforms: {
      uColorScale: { value: descriptor.map ? (255 / 128) : 1 },
      uAmb: sharedUniforms.uAmb,
      uEmiss: sharedUniforms.uEmiss,
      uSurfaceEmissiveScale: { value: Number(profile.config?.surfaceEmissiveScale) || 0 },
      uUseVertexColor: { value: !descriptor.rwFlags?.forceIgnoreVertexColor && descriptor.useVertexColors !== false },
      uPlatformVariant: { value: profile.platform === RW_PIPELINE_PLATFORM.PSP ? 1 : 0 },
    },
  };
  material.onBeforeCompile = (shader) => {
    const pipelineUniforms = material.userData?.rwPipelineUniforms || {};
    shader.uniforms.uColorScale = pipelineUniforms.uColorScale;
    shader.uniforms.uAmb = pipelineUniforms.uAmb;
    shader.uniforms.uEmiss = pipelineUniforms.uEmiss;
    shader.uniforms.uSurfaceEmissiveScale = pipelineUniforms.uSurfaceEmissiveScale;
    shader.uniforms.uUseVertexColor = pipelineUniforms.uUseVertexColor;
    shader.uniforms.uPlatformVariant = pipelineUniforms.uPlatformVariant;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uAmb;
uniform vec3 uEmiss;
uniform float uSurfaceEmissiveScale;
uniform bool uUseVertexColor;
uniform int uPlatformVariant;
varying vec4 rwPipelineColor;
vec4 rwPipelineReadVertexColor(void) {
  if (!uUseVertexColor) return vec4(1.0);
  #if defined( USE_COLOR_ALPHA )
    return color;
  #elif defined( USE_COLOR )
    return vec4(color.rgb, 1.0);
  #else
    return vec4(1.0);
  #endif
}
vec4 rwPipelineApplyLeedsProfile(vec4 vertexColor) {
  if (uPlatformVariant == 1) {
    vec3 vertexRgb = vertexColor.rgb;
    vec3 ambientRgb = uAmb;
    vec3 emissiveRgb = uEmiss;
    vertexRgb = ((vertexRgb - 0.5) * max(1.5, 0.0)) + 0.5;
    vertexRgb += 0.25;
    vertexRgb = max(vertexRgb, vec3(0.0));
    ambientRgb = ((ambientRgb - 0.5) * max(1.2, 0.0)) + 0.5;
    ambientRgb += 0.1;
    ambientRgb = max(ambientRgb, vec3(0.0));
    emissiveRgb = ((emissiveRgb - 0.5) * max(1.25, 0.0)) + 0.5;
    emissiveRgb += 0.05;
    emissiveRgb = max(emissiveRgb, vec3(0.0));
    return clamp(vec4(emissiveRgb + (vertexRgb * ambientRgb), vertexColor.a), 0.0, 1.0);
  }
  vec4 outputColor = vertexColor;
  outputColor.rgb *= uAmb;
  outputColor.rgb += uEmiss * uSurfaceEmissiveScale;
  return clamp(outputColor, 0.0, 1.0);
}`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
rwPipelineColor = rwPipelineApplyLeedsProfile(rwPipelineReadVertexColor());`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uColorScale;
varying vec4 rwPipelineColor;`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  sampledDiffuseColor.rgb *= uColorScale;
  diffuseColor *= sampledDiffuseColor;
#endif`,
      )
      .replace(
        '#include <color_fragment>',
        'diffuseColor *= rwPipelineColor;',
      );

    material.userData.rwPipelineCompiledShader = shader;
  };
  material.customProgramCacheKey = () => `${profile.id}:${profile.platform}`;

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
    rwPipelineUsesThreeFog: true,
  };

  return material;
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
  if ('r' in target || 'g' in target || 'b' in target) {
    target.r = r;
    target.g = g;
    target.b = b;
    return;
  }
  target.x = r;
  target.y = g;
  target.z = b;
}

function updateLeedsVcsBuildingMaterial(profile, material) {
  const descriptor = getRWMaterialDescriptor(material);
  const uniforms = material.userData?.rwPipelineUniforms;
  if (!material || !uniforms) return;
  uniforms.uSurfaceEmissiveScale.value = Number(profile.config?.surfaceEmissiveScale) || 0;
  uniforms.uUseVertexColor.value = !descriptor?.rwFlags?.forceIgnoreVertexColor && descriptor?.useVertexColors !== false;
  uniforms.uPlatformVariant.value = profile.platform === RW_PIPELINE_PLATFORM.PSP ? 1 : 0;
  uniforms.uColorScale.value = descriptor?.map ? (255 / 128) : 1;
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
    backend: 'WebGL',
    config: {
      surfaceEmissiveScale: options.surfaceEmissiveScale,
    },
    sharedUniforms: {
      uAmb: { value: new THREE.Vector3(1, 1, 1) },
      uEmiss: { value: new THREE.Vector3(0, 0, 0) },
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
    updateRuntime(runtimeContext) {
      updateLeedsVcsBuildingRuntime(this, runtimeContext);
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
    backend: 'WebGL',
    config: {
      ...(options.config || {}),
    },
    isApplicable() {
      return true;
    },
    createEffect() {
      return new RWPostFxPipeline(this.config);
    },
    applyConfig(effect, selection) {
      effect?.setConfig?.({
        ...this.config,
        ...(selection?.config || {}),
      });
    },
    updateRuntime(runtimeContext, effect) {
      effect?.updateRuntime(runtimeContext);
    },
    disposeEffect(effect) {
      effect?.dispose?.();
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

  get(profileId) {
    return this.profiles.get(profileId) || null;
  }

  resolve(selection) {
    const normalized = resolveRWPipelineSelection(selection, selection?.worldGameVersion);
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
  return registry;
}

let defaultRWPipelineRegistry = null;

export function getDefaultRWPipelineRegistry() {
  if (!defaultRWPipelineRegistry) {
    defaultRWPipelineRegistry = createDefaultRWPipelineRegistry();
  }
  return defaultRWPipelineRegistry;
}

export function createRWPipelineMaterialForProfile(profileId, input) {
  const profile = getDefaultRWPipelineRegistry().get(profileId);
  if (!profile || typeof profile.createMaterial !== 'function') return null;
  const material = profile.createMaterial(input);
  profile.updateMaterial(material, input?.runtimeContext);
  return material;
}

export function createBasicMaterialFromDescriptor(descriptor, geometry) {
  return createThreeMaterialFromRW(cloneRWMaterialDescriptor(descriptor), geometry);
}
