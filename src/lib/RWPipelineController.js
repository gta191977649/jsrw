import {
  cloneRWMaterialDescriptor,
  createThreeMaterialFromRW,
  getRWMaterialDescriptor,
} from './RWRender';
import {
  RW_PIPELINE_CATEGORY,
  RW_PIPELINE_SELECTION_DEFAULT,
  RW_PIPELINE_SELECTION_DEFAULTS,
  cloneRWPipelineSelection,
  cloneRWPipelineSelections,
  getDefaultRWPipelineRegistry,
  resolveRWPipelineSelection,
} from './rwPipelineProfiles';

function cloneDescriptorList(list) {
  return Array.isArray(list) ? list.map((descriptor) => cloneRWMaterialDescriptor(descriptor)) : [];
}

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

function getDescriptorCacheKey(profile, descriptor, geometry) {
  const surfaceProps = descriptor?.surfaceProps || {};
  const rwFlags = descriptor?.rwFlags || {};
  return JSON.stringify([
    profile?.id || 'none',
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
  const materials = getNodeMaterials(node);
  const descriptors = materials
    .map((material) => getRWMaterialDescriptor(material))
    .filter(Boolean)
    .map((descriptor) => cloneRWMaterialDescriptor(descriptor));
  if (descriptors.length === 0) return null;
  node.userData = {
    ...(node.userData || {}),
    rwPipelineBaseDescriptors: descriptors,
  };
  return descriptors;
}

export class RWPipelineController {
  constructor(registry = getDefaultRWPipelineRegistry()) {
    this.registry = registry;
    this.selections = cloneRWPipelineSelections(RW_PIPELINE_SELECTION_DEFAULTS);
    this.root = null;
    this.activeProfiles = new Map();
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
        backend: 'WebGL',
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

  getStatus(category = RW_PIPELINE_CATEGORY.BUILDING) {
    return {
      ...this.statusByCategory[category],
      selection: cloneRWPipelineSelection(this.statusByCategory[category]?.selection),
    };
  }

  getStatuses() {
    const next = {};
    for (const category of Object.values(RW_PIPELINE_CATEGORY)) {
      next[category] = this.getStatus(category);
    }
    return next;
  }

  describeSelection(category = RW_PIPELINE_CATEGORY.BUILDING, runtimeContext = {}) {
    const selection = cloneRWPipelineSelection(this.selections[category] || RW_PIPELINE_SELECTION_DEFAULTS[category] || RW_PIPELINE_SELECTION_DEFAULT);
    const resolvedSelection = resolveRWPipelineSelection(selection, runtimeContext.worldGameVersion);
    const profile = this.registry.resolve({
      ...selection,
      category,
      worldGameVersion: runtimeContext.worldGameVersion,
    });
    const backend = String(runtimeContext.activeBackend || 'WebGL');
    const supported = !profile || profile.backend === backend;
    return {
      enabled: selection.enabled,
      selection: resolvedSelection,
      profile,
      supported,
      backend,
      warning: !selection.enabled
        ? ''
        : !profile
          ? 'No pipeline profile is registered for the current selection.'
          : !supported
            ? `The selected pipeline only supports ${profile.backend}.`
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

  syncEffect(category, nextProfile, runtimeContext) {
    const currentProfile = this.activeProfiles.get(category) || null;
    const currentEffect = this.activeEffects.get(category) || null;
    const selection = this.selections[category] || null;

    if (!nextProfile) {
      if (currentEffect) {
        currentProfile?.disposeEffect?.(currentEffect);
        this.activeEffects.delete(category);
      }
      this.activeProfiles.delete(category);
      return;
    }

    let effect = currentEffect;
    if (!effect || currentProfile?.id !== nextProfile.id) {
      currentProfile?.disposeEffect?.(currentEffect);
      effect = nextProfile.createEffect?.() || null;
      if (effect) this.activeEffects.set(category, effect);
    }

    this.activeProfiles.set(category, nextProfile);
    nextProfile.applyConfig?.(effect, selection, runtimeContext);
    nextProfile.updateRuntime?.(runtimeContext, effect);
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
    const activeBuildingProfile = descriptions[RW_PIPELINE_CATEGORY.BUILDING].profile && descriptions[RW_PIPELINE_CATEGORY.BUILDING].supported
      ? descriptions[RW_PIPELINE_CATEGORY.BUILDING].profile
      : null;
    const activePostFxProfile = descriptions[RW_PIPELINE_CATEGORY.POSTFX].profile && descriptions[RW_PIPELINE_CATEGORY.POSTFX].supported
      ? descriptions[RW_PIPELINE_CATEGORY.POSTFX].profile
      : null;

    this.activeProfiles.set(RW_PIPELINE_CATEGORY.BUILDING, activeBuildingProfile);
    this.syncEffect(RW_PIPELINE_CATEGORY.POSTFX, activePostFxProfile, runtimeContext);
    this.activeMaterials.clear();
    if (root?.traverse) {
      root.traverse((node) => {
        this.applyToNode(node, activeBuildingProfile, runtimeContext);
      });
    }
    this.updateStatuses(descriptions);
  }

  applyToObject(object3D, runtimeContext = {}) {
    if (!object3D?.traverse) return;
    const description = this.describeSelection(RW_PIPELINE_CATEGORY.BUILDING, runtimeContext);
    const activeProfile = description.profile && description.supported ? description.profile : null;
    object3D.traverse((node) => {
      this.applyToNode(node, activeProfile, runtimeContext);
    });
    this.activeProfiles.set(RW_PIPELINE_CATEGORY.BUILDING, activeProfile);
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

  applyToNode(node, activeProfile, runtimeContext) {
    if (!node?.isMesh || node.userData?.rwIsSelectionOverlay) return;
    const targetMeta = resolveTargetMeta(node);
    let baseDescriptors = cloneDescriptorList(node.userData?.rwPipelineBaseDescriptors);
    if (baseDescriptors.length === 0) {
      baseDescriptors = captureBaseDescriptors(node) || [];
    }
    if (!baseDescriptors || baseDescriptors.length === 0) return;

    const shouldUseProfile = Boolean(activeProfile && activeProfile.isApplicable(targetMeta));
    const currentMaterials = getNodeMaterials(node);

    if (!shouldUseProfile) {
      if (currentMaterials.some((material) => material?.userData?.rwPipelineMaterial)) {
        for (const material of currentMaterials) {
          this.activeMaterials.delete(material);
        }
        const restored = baseDescriptors.map((descriptor) => {
          const material = createThreeMaterialFromRW(cloneRWMaterialDescriptor(descriptor), node.geometry);
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
      const material = this.getCachedPipelineMaterial(activeProfile, {
        descriptor,
        geometry: node.geometry,
        targetMeta,
        runtimeContext,
      });
      this.activeMaterials.add(material);
      return material;
    });
    setNodeMaterials(node, nextMaterials);
    for (const material of currentMaterials) {
      this.activeMaterials.delete(material);
    }
    disposeOwnedMaterials(currentMaterials);
  }

  getCachedPipelineMaterial(profile, input) {
    const cacheKey = getDescriptorCacheKey(profile, input?.descriptor, input?.geometry);
    let material = this.materialCache.get(cacheKey);
    if (!material) {
      material = profile.createMaterial(input);
      profile.updateMaterial(material, input?.runtimeContext);
      material.userData = {
        ...(material.userData || {}),
        rwPipelineOwnedMaterial: true,
        rwPipelineSharedMaterial: true,
        rwPipelineCacheKey: cacheKey,
      };
      this.materialCache.set(cacheKey, material);
      return material;
    }
    profile.updateMaterial(material, input?.runtimeContext);
    return material;
  }

  updateRuntime(runtimeContext = {}) {
    const activeBuildingProfile = this.activeProfiles.get(RW_PIPELINE_CATEGORY.BUILDING);
    if (activeBuildingProfile) {
      if (typeof activeBuildingProfile.updateRuntime === 'function') {
        activeBuildingProfile.updateRuntime(runtimeContext);
      } else {
        for (const material of this.activeMaterials) {
          if (!material?.userData?.rwPipelineMaterial) continue;
          activeBuildingProfile.updateMaterial(material, runtimeContext);
        }
      }
    }

    const activePostFxProfile = this.activeProfiles.get(RW_PIPELINE_CATEGORY.POSTFX);
    if (activePostFxProfile) {
      activePostFxProfile.applyConfig?.(
        this.activeEffects.get(RW_PIPELINE_CATEGORY.POSTFX) || null,
        this.selections[RW_PIPELINE_CATEGORY.POSTFX] || null,
        runtimeContext,
      );
      activePostFxProfile.updateRuntime?.(runtimeContext, this.activeEffects.get(RW_PIPELINE_CATEGORY.POSTFX) || null);
    }
  }

  renderPostFx(renderer, runtimeContext = {}) {
    const activePostFxProfile = this.activeProfiles.get(RW_PIPELINE_CATEGORY.POSTFX);
    const effect = this.activeEffects.get(RW_PIPELINE_CATEGORY.POSTFX);
    if (!activePostFxProfile || !effect) return;
    activePostFxProfile.applyConfig?.(effect, this.selections[RW_PIPELINE_CATEGORY.POSTFX] || null, runtimeContext);
    activePostFxProfile.updateRuntime?.(runtimeContext, effect);
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
}

export default RWPipelineController;
