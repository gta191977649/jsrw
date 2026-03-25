import { cloneRwMaterialDescriptor } from '../material/RwMaterialDescriptor.js';
import {
  cloneRWPipelineSelection,
  cloneRWPipelineSelections,
  resolveRWPipelineSelection,
} from './selection.js';
import {
  RW_PIPELINE_CATEGORY,
  RW_PIPELINE_SELECTION_DEFAULT,
  RW_PIPELINE_SELECTION_DEFAULTS,
} from './constants.js';
import {
  createThreeMaterialFromRW,
  getRWMaterialDescriptor,
} from '../../adapters/three/ThreeMaterialAdapter.js';
import { getDefaultRWPipelineRegistry } from '../../renderer/world/createDefaultPipelineRegistry.js';

function getNodeMaterials(node) {
  if (!node?.isMesh) return [];
  return Array.isArray(node.material) ? node.material.filter(Boolean) : (node.material ? [node.material] : []);
}

function setNodeMaterials(node, materials) {
  if (!node?.isMesh) return;
  node.material = Array.isArray(node.material) ? materials : materials[0] || null;
}

function disposeOwnedMaterials(materials) {
  for (const material of materials) {
    if (!material?.userData?.rwPipelineOwnedMaterial) continue;
    if (material.userData?.rwPipelineSharedMaterial) continue;
    material.dispose?.();
  }
}

const rwPipelineObjectIds = new WeakMap();
let rwPipelineNextObjectId = 1;

function getRWPipelineObjectId(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return 'null';
  let objectId = rwPipelineObjectIds.get(value);
  if (!objectId) {
    objectId = `obj_${rwPipelineNextObjectId}`;
    rwPipelineNextObjectId += 1;
    rwPipelineObjectIds.set(value, objectId);
  }
  return objectId;
}

function getDescriptorColorKey(color) {
  if (!color) return '1,1,1';
  const r = Number(color.r ?? color.x ?? 1);
  const g = Number(color.g ?? color.y ?? 1);
  const b = Number(color.b ?? color.z ?? 1);
  return `${r},${g},${b}`;
}

function getDescriptorCacheKey(profile, backendId, descriptor, geometry) {
  const surfaceProps = descriptor?.surfaceProps || {};
  const rwFlags = descriptor?.rwFlags || {};
  return JSON.stringify([
    profile?.id || 'none',
    backendId || 'DEFAULT',
    descriptor?.pipeline || 'default',
    getRWPipelineObjectId(descriptor?.map),
    getRWPipelineObjectId(descriptor?.alphaMap),
    descriptor?.textureName || '',
    descriptor?.maskName || '',
    descriptor?.alphaMode || 'opaque',
    descriptor?.alphaMapMode || 'ignore',
    descriptor?.opacity ?? 1,
    descriptor?.alphaRef ?? 0,
    descriptor?.transparent === true ? 1 : 0,
    descriptor?.depthTest === false ? 0 : 1,
    descriptor?.depthWrite === false ? 0 : 1,
    descriptor?.blending ?? 1,
    descriptor?.side ?? 2,
    descriptor?.wireframe ? 1 : 0,
    descriptor?.useVertexColors === false ? 0 : 1,
    rwFlags.forceIgnoreVertexColor ? 1 : 0,
    rwFlags.additive ? 1 : 0,
    rwFlags.noZWrite ? 1 : 0,
    descriptor?.fog === false ? 0 : 1,
    getDescriptorColorKey(descriptor?.color),
    surfaceProps.ambient ?? 1,
    surfaceProps.specular ?? 0,
    surfaceProps.diffuse ?? 1,
    geometry?.getAttribute?.('color') ? 1 : 0,
    geometry?.getAttribute?.('uv') ? 1 : 0,
  ]);
}

function resolveTargetMeta(node) {
  let cursor = node;
  while (cursor) {
    if (cursor.userData?.rwPipelineTarget) return cursor.userData.rwPipelineTarget;
    cursor = cursor.parent;
  }
  return null;
}

function captureBaseDescriptors(node) {
  const descriptors = getNodeMaterials(node)
    .map((material) => getRWMaterialDescriptor(material))
    .filter(Boolean)
    .map((descriptor) => cloneRwMaterialDescriptor(descriptor));
  if (descriptors.length === 0) return null;
  node.userData = {
    ...(node.userData || {}),
    rwPipelineBaseDescriptors: descriptors,
  };
  return descriptors;
}

function cloneDescriptorList(list) {
  return Array.isArray(list) ? list.map((descriptor) => cloneRwMaterialDescriptor(descriptor)) : [];
}

export class RWPipelineController {
  constructor(options = {}) {
    this.registry = options.registry || getDefaultRWPipelineRegistry();
    this.selections = cloneRWPipelineSelections(RW_PIPELINE_SELECTION_DEFAULTS);
    this.root = null;
    this.activeProfiles = new Map();
    this.activeImplementations = new Map();
    this.activeMaterials = new Set();
    this.materialCache = new Map();
    this.activeEffects = new Map();
    this.statusByCategory = {};
    for (const category of Object.values(RW_PIPELINE_CATEGORY)) {
      this.statusByCategory[category] = {
        enabled: false,
        selection: cloneRWPipelineSelection(RW_PIPELINE_SELECTION_DEFAULTS[category] || RW_PIPELINE_SELECTION_DEFAULT),
        profileId: null,
        profileLabel: 'Disabled',
        supported: true,
        warning: '',
        backend: 'WEBGL',
      };
    }
  }

  setSelection(categoryOrSelections, maybeSelection) {
    if (typeof categoryOrSelections === 'string') {
      this.selections[categoryOrSelections] = cloneRWPipelineSelection({
        ...(RW_PIPELINE_SELECTION_DEFAULTS[categoryOrSelections] || RW_PIPELINE_SELECTION_DEFAULT),
        ...(maybeSelection || {}),
        category: categoryOrSelections,
      });
      return;
    }
    this.selections = cloneRWPipelineSelections(categoryOrSelections);
  }

  setRoot(root) {
    this.root = root || null;
  }

  describeSelection(category = RW_PIPELINE_CATEGORY.BUILDING, runtimeContext = {}) {
    const selection = cloneRWPipelineSelection(this.selections[category] || RW_PIPELINE_SELECTION_DEFAULTS[category] || RW_PIPELINE_SELECTION_DEFAULT);
    const resolvedSelection = resolveRWPipelineSelection(selection, runtimeContext.worldGameVersion);
    const profile = this.registry.resolve({
      ...selection,
      category,
      worldGameVersion: runtimeContext.worldGameVersion,
    });
    const backend = String(runtimeContext.activeBackend || 'WebGL').toUpperCase();
    const implementation = this.registry.resolveBackendImplementation(profile, backend);
    const supported = !profile || Boolean(implementation);
    return {
      enabled: selection.enabled,
      selection: resolvedSelection,
      profile,
      implementation,
      supported,
      backend,
      warning: !selection.enabled
        ? ''
        : !profile
          ? 'No pipeline profile is registered for the current selection.'
          : !supported
            ? `The selected pipeline has no ${backend} implementation.`
            : '',
    };
  }

  describeSelections(runtimeContext = {}) {
    const next = {};
    for (const category of Object.values(RW_PIPELINE_CATEGORY)) {
      next[category] = this.describeSelection(category, runtimeContext);
    }
    return next;
  }

  syncEffect(category, description, runtimeContext) {
    const nextProfile = description?.supported ? description.profile : null;
    const nextImplementation = description?.supported ? description.implementation : null;
    const currentProfile = this.activeProfiles.get(category) || null;
    const currentImplementation = this.activeImplementations.get(category) || null;
    const currentEffect = this.activeEffects.get(category) || null;
    const selection = this.selections[category] || null;

    if (!nextProfile || !nextImplementation) {
      currentImplementation?.disposeEffect?.(currentEffect);
      this.activeEffects.delete(category);
      this.activeProfiles.delete(category);
      this.activeImplementations.delete(category);
      return;
    }

    let effect = currentEffect;
    if (!effect || currentProfile?.id !== nextProfile.id || currentImplementation !== nextImplementation) {
      currentImplementation?.disposeEffect?.(currentEffect);
      effect = nextImplementation.createEffect?.({ backend: runtimeContext.backend || null, runtimeContext }) || null;
      if (effect) this.activeEffects.set(category, effect);
    }

    this.activeProfiles.set(category, nextProfile);
    this.activeImplementations.set(category, nextImplementation);
    nextImplementation.applyConfig?.(effect, selection, runtimeContext);
    nextImplementation.updateRuntime?.(runtimeContext, effect);
  }

  updateStatuses(descriptions) {
    for (const category of Object.values(RW_PIPELINE_CATEGORY)) {
      const description = descriptions[category];
      const activeProfile = this.activeProfiles.get(category) || null;
      this.statusByCategory[category] = {
        enabled: description.selection.enabled,
        selection: description.selection,
        profileId: activeProfile?.id || null,
        profileLabel: activeProfile?.label || (description.selection.enabled ? 'None' : 'Disabled'),
        supported: description.supported,
        warning: description.warning,
        backend: description.backend,
      };
    }
  }

  applyToRoot(root = this.root, runtimeContext = {}) {
    this.setRoot(root);
    const descriptions = this.describeSelections(runtimeContext);
    const buildingDescription = descriptions[RW_PIPELINE_CATEGORY.BUILDING];
    const activeBuildingProfile = buildingDescription.profile && buildingDescription.supported ? buildingDescription.profile : null;
    const activeBuildingImplementation = buildingDescription.profile && buildingDescription.supported ? buildingDescription.implementation : null;
    this.activeProfiles.set(RW_PIPELINE_CATEGORY.BUILDING, activeBuildingProfile);
    this.activeImplementations.set(RW_PIPELINE_CATEGORY.BUILDING, activeBuildingImplementation);
    this.syncEffect(RW_PIPELINE_CATEGORY.POSTFX, descriptions[RW_PIPELINE_CATEGORY.POSTFX], runtimeContext);
    this.activeMaterials.clear();
    if (root?.traverse) {
      root.traverse((node) => {
        this.applyToNode(node, activeBuildingProfile, activeBuildingImplementation, runtimeContext);
      });
    }
    this.updateStatuses(descriptions);
  }

  applyToObject(object3D, runtimeContext = {}) {
    if (!object3D?.traverse) return;
    const description = this.describeSelection(RW_PIPELINE_CATEGORY.BUILDING, runtimeContext);
    const activeProfile = description.profile && description.supported ? description.profile : null;
    const activeImplementation = description.profile && description.supported ? description.implementation : null;
    object3D.traverse((node) => {
      this.applyToNode(node, activeProfile, activeImplementation, runtimeContext);
    });
    this.activeProfiles.set(RW_PIPELINE_CATEGORY.BUILDING, activeProfile);
    this.activeImplementations.set(RW_PIPELINE_CATEGORY.BUILDING, activeImplementation);
    this.statusByCategory[RW_PIPELINE_CATEGORY.BUILDING] = {
      enabled: description.selection.enabled,
      selection: description.selection,
      profileId: activeProfile?.id || null,
      profileLabel: activeProfile?.label || (description.selection.enabled ? 'None' : 'Disabled'),
      supported: description.supported,
      warning: description.warning,
      backend: description.backend,
    };
  }

  applyToNode(node, activeProfile, activeImplementation, runtimeContext) {
    if (!node?.isMesh || node.userData?.rwIsSelectionOverlay) return;
    const targetMeta = resolveTargetMeta(node);
    let baseDescriptors = cloneDescriptorList(node.userData?.rwPipelineBaseDescriptors);
    if (baseDescriptors.length === 0) baseDescriptors = captureBaseDescriptors(node) || [];
    if (!baseDescriptors.length) return;
    const shouldUseProfile = Boolean(activeProfile && activeImplementation && activeProfile.isApplicable(targetMeta));
    const currentMaterials = getNodeMaterials(node);
    if (!shouldUseProfile) {
      if (currentMaterials.some((material) => material?.userData?.rwPipelineMaterial)) {
        const restored = baseDescriptors.map((descriptor) => {
          const material = createThreeMaterialFromRW(cloneRwMaterialDescriptor(descriptor), node.geometry);
          material.userData = {
            ...(material.userData || {}),
            rwPipelineOwnedMaterial: true,
          };
          return material;
        });
        setNodeMaterials(node, restored);
        disposeOwnedMaterials(currentMaterials);
      }
      return;
    }
    const nextMaterials = baseDescriptors.map((descriptor) => {
      const material = this.getCachedPipelineMaterial(activeProfile, activeImplementation, {
        descriptor,
        geometry: node.geometry,
        targetMeta,
        runtimeContext,
      });
      this.activeMaterials.add(material);
      return material;
    });
    setNodeMaterials(node, nextMaterials);
    for (const material of currentMaterials) this.activeMaterials.delete(material);
    disposeOwnedMaterials(currentMaterials);
  }

  getCachedPipelineMaterial(profile, implementation, input) {
    const backendId = String(input?.runtimeContext?.activeBackend || 'WebGL').toUpperCase();
    const cacheKey = getDescriptorCacheKey(profile, backendId, input?.descriptor, input?.geometry);
    let material = this.materialCache.get(cacheKey);
    if (!material) {
      material = implementation.createMaterial(input);
      implementation.updateMaterial?.(material, input?.runtimeContext);
      material.userData = {
        ...(material.userData || {}),
        rwPipelineOwnedMaterial: true,
        rwPipelineSharedMaterial: true,
        rwPipelineCacheKey: cacheKey,
        rwPipelineBackend: backendId,
      };
      this.materialCache.set(cacheKey, material);
      return material;
    }
    implementation.updateMaterial?.(material, input?.runtimeContext);
    return material;
  }

  updateRuntime(runtimeContext = {}) {
    const buildingImplementation = this.activeImplementations.get(RW_PIPELINE_CATEGORY.BUILDING);
    const activeBuildingProfile = this.activeProfiles.get(RW_PIPELINE_CATEGORY.BUILDING);
    if (activeBuildingProfile && buildingImplementation) {
      if (typeof buildingImplementation.updateRuntime === 'function') {
        buildingImplementation.updateRuntime(runtimeContext);
      } else {
        for (const material of this.activeMaterials) {
          if (!material?.userData?.rwPipelineMaterial) continue;
          buildingImplementation.updateMaterial?.(material, runtimeContext);
        }
      }
    }
    const postFxImplementation = this.activeImplementations.get(RW_PIPELINE_CATEGORY.POSTFX);
    const postFxEffect = this.activeEffects.get(RW_PIPELINE_CATEGORY.POSTFX) || null;
    if (postFxImplementation) {
      postFxImplementation.applyConfig?.(postFxEffect, this.selections[RW_PIPELINE_CATEGORY.POSTFX] || null, runtimeContext);
      postFxImplementation.updateRuntime?.(runtimeContext, postFxEffect);
    }
  }

  renderPostFx(renderer, runtimeContext = {}) {
    const effect = this.activeEffects.get(RW_PIPELINE_CATEGORY.POSTFX);
    const implementation = this.activeImplementations.get(RW_PIPELINE_CATEGORY.POSTFX);
    if (!effect || !implementation) return;
    implementation.applyConfig?.(effect, this.selections[RW_PIPELINE_CATEGORY.POSTFX] || null, runtimeContext);
    implementation.updateRuntime?.(runtimeContext, effect);
    effect.render?.(renderer, runtimeContext);
  }

  beginPostFxSceneCapture(runtimeContext = {}) {
    const effect = this.activeEffects.get(RW_PIPELINE_CATEGORY.POSTFX);
    if (!effect || typeof effect.beginSceneCapture !== 'function') return null;
    return effect.beginSceneCapture(runtimeContext);
  }

  hasActivePostFx() {
    return Boolean(this.activeProfiles.get(RW_PIPELINE_CATEGORY.POSTFX) && this.activeEffects.get(RW_PIPELINE_CATEGORY.POSTFX));
  }

  getActiveEffect(category) {
    return this.activeEffects.get(category) || null;
  }

  getStats() {
    return {
      activeMaterialCount: this.activeMaterials.size,
      cachedMaterialCount: this.materialCache.size,
    };
  }

  getStatus(category = RW_PIPELINE_CATEGORY.BUILDING) {
    return {
      ...this.statusByCategory[category],
      selection: cloneRWPipelineSelection(this.statusByCategory[category]?.selection),
    };
  }

  getStatuses() {
    const next = {};
    for (const category of Object.values(RW_PIPELINE_CATEGORY)) next[category] = this.getStatus(category);
    return next;
  }
}

export default RWPipelineController;
