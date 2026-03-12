import {
  cloneRWMaterialDescriptor,
  createThreeMaterialFromRW,
  getRWMaterialDescriptor,
} from './RWRender';
import {
  RW_PIPELINE_SELECTION_DEFAULT,
  cloneRWPipelineSelection,
  createDefaultRWPipelineRegistry,
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
    material.dispose?.();
  }
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
  constructor(registry = createDefaultRWPipelineRegistry()) {
    this.registry = registry;
    this.selection = cloneRWPipelineSelection(RW_PIPELINE_SELECTION_DEFAULT);
    this.root = null;
    this.activeProfile = null;
    this.status = {
      enabled: false,
      selection: cloneRWPipelineSelection(RW_PIPELINE_SELECTION_DEFAULT),
      profileId: null,
      profileLabel: 'Disabled',
      supported: true,
      warning: '',
      backend: 'WebGL',
    };
  }

  setSelection(selection) {
    this.selection = cloneRWPipelineSelection(selection);
  }

  setRoot(root) {
    this.root = root || null;
  }

  getStatus() {
    return {
      ...this.status,
      selection: cloneRWPipelineSelection(this.status.selection),
    };
  }

  describeSelection(runtimeContext = {}) {
    const selection = cloneRWPipelineSelection(this.selection);
    const profile = this.registry.resolve(selection);
    const backend = String(runtimeContext.activeBackend || 'WebGL');
    const supported = !profile || profile.backend === backend;
    return {
      enabled: selection.enabled,
      selection,
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

  applyToRoot(root = this.root, runtimeContext = {}) {
    this.setRoot(root);
    if (!root?.traverse) return;
    const description = this.describeSelection(runtimeContext);
    this.activeProfile = description.profile && description.supported ? description.profile : null;
    root.traverse((node) => {
      this.applyToNode(node, this.activeProfile, runtimeContext);
    });
    this.status = {
      enabled: description.selection.enabled,
      selection: description.selection,
      profileId: this.activeProfile?.id || null,
      profileLabel: this.activeProfile?.label || (description.selection.enabled ? 'None' : 'Disabled'),
      supported: description.supported,
      warning: description.warning,
      backend: description.backend,
    };
  }

  applyToObject(object3D, runtimeContext = {}) {
    if (!object3D?.traverse) return;
    const description = this.describeSelection(runtimeContext);
    const activeProfile = description.profile && description.supported ? description.profile : null;
    object3D.traverse((node) => {
      this.applyToNode(node, activeProfile, runtimeContext);
    });
    this.status = {
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
      const material = activeProfile.createMaterial({
        descriptor,
        geometry: node.geometry,
        targetMeta,
        runtimeContext,
      });
      activeProfile.updateMaterial(material, runtimeContext);
      return material;
    });
    setNodeMaterials(node, nextMaterials);
    disposeOwnedMaterials(currentMaterials);
  }

  updateRuntime(runtimeContext = {}) {
    if (!this.root?.traverse || !this.activeProfile) return;
    this.root.traverse((node) => {
      if (!node?.isMesh || node.userData?.rwIsSelectionOverlay) return;
      const materials = getNodeMaterials(node);
      for (const material of materials) {
        if (!material?.userData?.rwPipelineMaterial) continue;
        this.activeProfile.updateMaterial(material, runtimeContext);
      }
    });
  }
}

export default RWPipelineController;
