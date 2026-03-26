import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  DISTANCE_FADE_DEFAULTS,
  resolveRenderableDistance,
} from '../core/DistanceFade.js';
import {
  addCoronaCandidate,
  addShadowCandidate,
  addVisibleChunk,
  addVisibleItem,
  addVisibleQueueMesh,
  resetFrameVisibilityResult,
} from '../core/FrameVisibility.js';
import {
  isChunkOccluded,
  registerChunkOccluder,
  resetChunkOcclusionState,
} from '../core/Occlusion.js';
import RenderEntityController from '../../renderer/common/RenderEntityController.js';
import {
  applyDisableVertexColor,
  createThreeMaterialFromRW,
  getRWMaterialDescriptor,
  prepareTobjInstanceMaterials,
} from '../../adapters/three/ThreeMaterialAdapter.js';
import { applyRwIdeFlagsToInstance } from '../../adapters/three/RwIdeFlagsAdapter.js';
import { cloneRwMaterialDescriptor as cloneRWMaterialDescriptor } from '../../core/material/RwMaterialDescriptor.js';
import { createRWPipelineMaterialForProfile } from '../../renderer/world/createDefaultPipelineRegistry.js';
import {
  applyGlobalBackfaceCulling,
  applyWireframe,
  WORLD_CHUNK_SIZE,
} from '../../utils/worldUtils.js';
import {
  createRwPipelineTarget,
  toThreeColorFromTimecycleValue,
} from '../integration/sessionHelpers.js';

const CHUNK_ACTIVE_MARGIN = 384;
const CHUNK_CULL_MARGIN_XZ = WORLD_CHUNK_SIZE * 1.0;
const CHUNK_CULL_MARGIN_Y = WORLD_CHUNK_SIZE * 1.5;
const RW_FADE_EPSILON = DISTANCE_FADE_DEFAULTS.epsilon;
const FALLBACK_AMBIENT = new THREE.Color(1, 1, 1);
const FALLBACK_EMISSIVE = new THREE.Color(0, 0, 0);
const VIS_INVISIBLE = 0;
const VIS_VISIBLE = 1;
const VIS_OFFSCREEN = 2;
const VIS_STREAMME = 3;

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

function flushDirtyInstancedBatch(batch) {
  if (!batch?.mesh || !Array.isArray(batch.activeEntries)) return;
  const dirtyHandles = Array.isArray(batch.dirtyHandles) ? batch.dirtyHandles : [];
  if (dirtyHandles.length === 0) return;

  for (const handle of dirtyHandles) {
    if (!handle) continue;
    handle.dirtyQueued = false;

    if (handle.visible) {
      if (handle.activeIndex >= 0) continue;
      const nextIndex = batch.activeEntries.length;
      batch.activeEntries.push(handle);
      batch.mesh.setMatrixAt(nextIndex, handle.matrix);
      handle.activeIndex = nextIndex;
      continue;
    }

    if (handle.activeIndex < 0) continue;
    const removedIndex = handle.activeIndex;
    const lastIndex = batch.activeEntries.length - 1;
    const lastHandle = lastIndex >= 0 ? batch.activeEntries[lastIndex] : null;
    if (lastHandle && removedIndex !== lastIndex) {
      batch.activeEntries[removedIndex] = lastHandle;
      lastHandle.activeIndex = removedIndex;
      batch.mesh.setMatrixAt(removedIndex, lastHandle.matrix);
    }
    batch.activeEntries.pop();
    handle.activeIndex = -1;
  }

  dirtyHandles.length = 0;
  batch.visibleCount = batch.activeEntries.length;
  batch.mesh.count = batch.visibleCount;
  batch.mesh.visible = batch.visibleCount > 0;
  batch.mesh.userData.rwInstanceEntries = batch.activeEntries;
  batch.mesh.instanceMatrix.needsUpdate = true;
  batch.mesh.boundingBox = null;
  batch.mesh.boundingSphere = null;
}

function setInstanceHandlesVisible(handles, visible, dirtyBatches) {
  if (!Array.isArray(handles) || handles.length === 0) return;
  for (const handle of handles) {
    // Handles use index: -1 until flush assigns activeIndex; visibility must still toggle.
    if (!handle?.batch?.mesh || handle.visible === visible) continue;
    handle.visible = visible;
    if (!Array.isArray(handle.batch.dirtyHandles)) handle.batch.dirtyHandles = [];
    if (!handle.dirtyQueued) {
      handle.dirtyQueued = true;
      handle.batch.dirtyHandles.push(handle);
    }
    dirtyBatches?.add(handle.batch);
  }
}

function setRenderSideOriginalVisible(item, side, visible, dirtyBatches) {
  const object3D = item?.getRenderObject?.(side) || (side === 'near' ? item.nearObj : item.lodObj);
  const handles = item?.getRenderHandles?.(side) || (side === 'near' ? item.nearHandles : item.lodHandles);
  if (side === 'near') {
    if (object3D) object3D.visible = visible;
    setInstanceHandlesVisible(handles, visible, dirtyBatches);
    return;
  }
  if (object3D) object3D.visible = visible;
  setInstanceHandlesVisible(handles, visible, dirtyBatches);
}

function ensureRenderSideObjectFade(sideState) {
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
    });
    node.material = Array.isArray(node.material) ? fadeMaterials : fadeMaterials[0];
  });
  sideState.fadeBindings = bindings;
  return true;
}

function setRenderSideObjectFadeOpacity(sideState, opacity) {
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
}

function disposeRenderSideObjectFade(sideState) {
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
}

function hasNearRenderable(item) {
  return item?.hasRenderable?.('near') ?? (
    Boolean(item?.nearState?.hasRenderable)
    || Boolean(item?.nearObj)
    || (Array.isArray(item?.nearHandles) && item.nearHandles.length > 0)
  );
}

function hasLodRenderable(item) {
  return item?.hasRenderable?.('lod') ?? (
    Boolean(item?.lodState?.hasRenderable)
    || Boolean(item?.lodObj)
    || (Array.isArray(item?.lodHandles) && item.lodHandles.length > 0)
  );
}

function shouldBypassCloseRangeItemFrustum(item, distanceSq) {
  const hasNear = hasNearRenderable(item);
  const hasLod = hasLodRenderable(item);
  if (!hasNear || hasLod) return false;

  const nearDrawDistance = Number(item?.nearState?.drawDistance);
  if (!Number.isFinite(nearDrawDistance) || nearDrawDistance > 120) return false;

  const boundingSphereRadius = Number(item?.boundingSphere?.radius);
  if (!Number.isFinite(boundingSphereRadius) || boundingSphereRadius > 8) return false;

  const closeRangeDistance = Math.max(6, boundingSphereRadius * 3);
  return distanceSq <= (closeRangeDistance * closeRangeDistance);
}

function isComplexFrustumItem(item) {
  return item?.isBigBuilding === true;
}

function shouldBypassCloseRangeChunkFrustum(chunk, camera) {
  if (!chunk?.center || !camera?.position) return false;
  const chunkRadius = Math.max(
    WORLD_CHUNK_SIZE * 0.5,
    Number(chunk.boundingSphere?.radius) || 0,
  );
  const closeRangeDistance = chunkRadius + WORLD_CHUNK_SIZE;
  return camera.position.distanceToSquared(chunk.center) <= (closeRangeDistance * closeRangeDistance);
}

function getCameraChunkCoords(camera) {
  if (!camera?.position) return null;
  return {
    x: Math.floor((camera.position.x || 0) / WORLD_CHUNK_SIZE),
    z: Math.floor((camera.position.z || 0) / WORLD_CHUNK_SIZE),
  };
}

function resolveSingleEntityTargetSide(item, options = {}) {
  const hasNear = hasNearRenderable(item);
  const hasLod = hasLodRenderable(item);
  const showLods = options.showLods === true;
  const forceLodOnly = options.forceLodOnly === true;
  const dist = Number(options.dist) || 0;
  const drawDistance = Number(options.drawDistance) || 0;

  if (forceLodOnly && hasLod) return 'lod';
  if (!hasNear && hasLod) return 'lod';
  if (hasNear && !hasLod) return 'near';
  if (!hasNear && !hasLod) return null;
  if (showLods && dist > drawDistance && hasLod) return 'lod';
  return 'near';
}

export class WorldStreamingRuntime {
  constructor(options = {}) {
    this.rendererSession = options.rendererSession || null;
  }

  buildRenderSideFadeProxy(item, side, context) {
    const sideState = side === 'near' ? item?.nearState : item?.lodState;
    if (!sideState?.template?.traverse || !sideState?.placementMatrix) return null;

    const { uiStateRef, worldGameVersionRef } = context;
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
      rwQueueRenderClass: 'building',
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
  }

  disposeRenderSideFadeProxy(sideState) {
    const proxyRoot = sideState?.proxyRoot;
    if (!proxyRoot) return false;
    if (proxyRoot.parent) proxyRoot.parent.remove(proxyRoot);
    disposeObjectMaterialsOnly(proxyRoot);
    sideState.proxyRoot = null;
    sideState.currentOpacity = 0;
    return true;
  }

  ensureRenderSideFadeProxy(item, side, context) {
    const sideState = side === 'near' ? item?.nearState : item?.lodState;
    if (!sideState) return null;
    if (sideState.proxyRoot) return sideState.proxyRoot;

    const {
      activeBackend,
      uiStateRef,
      worldGameVersionRef,
      timecycleStateRef,
      worldRootRef,
      rwRenderQueueRef,
    } = context;
    const proxy = this.buildRenderSideFadeProxy(item, side, context);
    if (!proxy) return null;
    worldRootRef.current.add(proxy);
    sideState.proxyRoot = proxy;
    this.rendererSession?.setBackend(activeBackend);
    this.rendererSession?.applyToObject(proxy, {
      activeBackend,
      worldGameVersion: worldGameVersionRef.current,
      timecycleCurrent: timecycleStateRef.current?.current,
      ambientColor: timecycleStateRef.current?.current?.values?.ambient
        ? toThreeColorFromTimecycleValue(timecycleStateRef.current.current.values.ambient)
        : FALLBACK_AMBIENT,
      emissiveColor: timecycleStateRef.current?.current?.values?.ambientBl
        ? toThreeColorFromTimecycleValue(timecycleStateRef.current.current.values.ambientBl)
        : FALLBACK_EMISSIVE,
      fallbackAmbient: FALLBACK_AMBIENT,
      fallbackEmissive: FALLBACK_EMISSIVE,
    });
    applyWireframe(proxy, uiStateRef.current.wireframe);
    applyDisableVertexColor(proxy, uiStateRef.current.disableVertexColor);
    applyGlobalBackfaceCulling(proxy, uiStateRef.current.disableBackfaceCulling);
    rwRenderQueueRef.current?.markDirty?.();
    return proxy;
  }

  applyRenderSideOpacity(item, side, opacity, dirtyBatches, context) {
    const sideState = side === 'near' ? item?.nearState : item?.lodState;
    const { rwRenderQueueRef } = context;
    if (!sideState) return false;
    const clampedOpacity = clamp01(opacity);
    const preferObjectFadeOnly = item?.usesSingleRwPath?.() === true && Boolean(sideState.renderObject);

    if (clampedOpacity <= RW_FADE_EPSILON) {
      if (disposeRenderSideObjectFade(sideState)) rwRenderQueueRef.current?.markDirty?.();
      setRenderSideOriginalVisible(item, side, false, dirtyBatches);
      if (this.disposeRenderSideFadeProxy(sideState)) rwRenderQueueRef.current?.markDirty?.();
      item?.setSideOpacity?.(side, 0);
      sideState.currentOpacity = 0;
      return false;
    }

    if (clampedOpacity >= (1 - RW_FADE_EPSILON)) {
      if (disposeRenderSideObjectFade(sideState)) rwRenderQueueRef.current?.markDirty?.();
      if (this.disposeRenderSideFadeProxy(sideState)) rwRenderQueueRef.current?.markDirty?.();
      setRenderSideOriginalVisible(item, side, true, dirtyBatches);
      item?.setSideOpacity?.(side, 1);
      sideState.currentOpacity = 1;
      return false;
    }

    if (ensureRenderSideObjectFade(sideState)) {
      if (this.disposeRenderSideFadeProxy(sideState)) rwRenderQueueRef.current?.markDirty?.();
      sideState.renderObject.visible = true;
      setRenderSideObjectFadeOpacity(sideState, clampedOpacity);
      item?.setSideOpacity?.(side, clampedOpacity);
      sideState.currentOpacity = clampedOpacity;
      return false;
    }

    if (preferObjectFadeOnly) {
      if (this.disposeRenderSideFadeProxy(sideState)) rwRenderQueueRef.current?.markDirty?.();
      setRenderSideOriginalVisible(item, side, clampedOpacity > RW_FADE_EPSILON, dirtyBatches);
      item?.setSideOpacity?.(side, clampedOpacity > RW_FADE_EPSILON ? 1 : 0);
      sideState.currentOpacity = clampedOpacity > RW_FADE_EPSILON ? 1 : 0;
      return false;
    }

    setRenderSideOriginalVisible(item, side, false, dirtyBatches);
    const proxy = this.ensureRenderSideFadeProxy(item, side, context);
    if (!proxy) {
      setRenderSideOriginalVisible(item, side, true, dirtyBatches);
      item?.setSideOpacity?.(side, 1);
      sideState.currentOpacity = 1;
      return false;
    }
    setFadeProxyOpacity(proxy, clampedOpacity);
    proxy.visible = true;
    item?.setSideOpacity?.(side, clampedOpacity);
    sideState.currentOpacity = clampedOpacity;
    return true;
  }

  hideRenderItemCompletely(item, dirtyBatches, context) {
    const { rwRenderQueueRef } = context;
    item?.setMode?.('hidden');
    item.mode = 'hidden';
    item?.setActiveSide?.(null);
    item?.setTransition?.(null);
    if (item?.nearState) item.nearState.currentOpacity = 0;
    if (item?.lodState) item.lodState.currentOpacity = 0;
    setRenderSideOriginalVisible(item, 'near', false, dirtyBatches);
    setRenderSideOriginalVisible(item, 'lod', false, dirtyBatches);
    let queueDirty = false;
    if (disposeRenderSideObjectFade(item?.nearState)) queueDirty = true;
    if (disposeRenderSideObjectFade(item?.lodState)) queueDirty = true;
    if (this.disposeRenderSideFadeProxy(item?.nearState)) queueDirty = true;
    if (this.disposeRenderSideFadeProxy(item?.lodState)) queueDirty = true;
    if (queueDirty) rwRenderQueueRef.current?.markDirty?.();
  }

  collectGroundScanChunks(camera, renderDistance, priorityDistance, renderChunkLookupRef) {
    const chunkLookup = renderChunkLookupRef.current;
    if (!(chunkLookup instanceof Map) || chunkLookup.size === 0 || !camera) return [];

    const resolvedRenderDistance = Math.max(WORLD_CHUNK_SIZE, renderDistance || WORLD_CHUNK_SIZE);
    const resolvedPriorityDistance = Math.max(
      WORLD_CHUNK_SIZE,
      Math.min(resolvedRenderDistance, priorityDistance || Math.min(resolvedRenderDistance, resolvedRenderDistance * 0.2)),
    );
    const cameraPoint = new THREE.Vector2(camera.position.x, camera.position.z);
    const candidates = [];

    for (const chunk of chunkLookup.values()) {
      const chunkCenter = chunk?.center;
      if (!chunkCenter) continue;
      const dx = (chunkCenter.x ?? 0) - cameraPoint.x;
      const dz = (chunkCenter.z ?? 0) - cameraPoint.y;
      const chunkRadius = Math.max(
        WORLD_CHUNK_SIZE,
        Number(chunk.boundingSphere?.radius) || 0,
      );
      const distance = Math.hypot(dx, dz);
      if (distance > resolvedRenderDistance + chunkRadius + CHUNK_ACTIVE_MARGIN) continue;
      candidates.push({
        chunk,
        distance,
        priority: distance <= resolvedPriorityDistance + chunkRadius,
      });
    }

    candidates.sort((left, right) => {
      if (left.priority !== right.priority) return left.priority ? -1 : 1;
      return left.distance - right.distance;
    });

    return candidates.map((entry) => entry.chunk);
  }

  getCachedGroundScanChunks(camera, renderDistance, priorityDistance, renderChunkLookupRef, lodState) {
    const cameraChunk = getCameraChunkCoords(camera);
    const chunkLookup = renderChunkLookupRef?.current;
    const lookupSize = chunkLookup instanceof Map ? chunkLookup.size : 0;
    if (!cameraChunk || lookupSize === 0) return [];

    const cache = lodState.chunkScanCache || null;
    if (
      cache
      && cache.cameraChunkX === cameraChunk.x
      && cache.cameraChunkZ === cameraChunk.z
      && cache.renderDistance === renderDistance
      && cache.priorityDistance === priorityDistance
      && cache.lookupSize === lookupSize
      && Array.isArray(cache.chunks)
    ) {
      return cache.chunks;
    }

    const chunks = this.collectGroundScanChunks(camera, renderDistance, priorityDistance, renderChunkLookupRef);
    lodState.chunkScanCache = {
      cameraChunkX: cameraChunk.x,
      cameraChunkZ: cameraChunk.z,
      renderDistance,
      priorityDistance,
      lookupSize,
      chunks,
    };
    return chunks;
  }

  collectRenderSideFrameVisibility(frameVisibility, item, side) {
    const sideState = side === 'near' ? item?.nearState : item?.lodState;
    if (!frameVisibility || !sideState) return;
    if ((item?.getSideOpacity?.(side) ?? sideState.currentOpacity ?? 0) <= RW_FADE_EPSILON) return;

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

    const handles = item?.getRenderHandles?.(side) || (side === 'near' ? item?.nearHandles : item?.lodHandles);
    if (!Array.isArray(handles) || handles.length === 0) return;
    for (const handle of handles) {
      if (!handle?.visible || !handle?.batch?.mesh) continue;
      addVisibleQueueMesh(frameVisibility, handle.batch.mesh);
    }
  }

  applySingleEntitySide(item, activeSide, opacity, dirtyBatches, context) {
    if (!activeSide) {
      this.applyRenderSideOpacity(item, 'near', 0, dirtyBatches, context);
      this.applyRenderSideOpacity(item, 'lod', 0, dirtyBatches, context);
      item?.setActiveSide?.(null);
      return false;
    }
    const inactiveSide = activeSide === 'lod' ? 'near' : 'lod';
    this.applyRenderSideOpacity(item, inactiveSide, 0, dirtyBatches, context);
    item?.setActiveSide?.(activeSide);
    return this.applyRenderSideOpacity(item, activeSide, opacity, dirtyBatches, context);
  }

  applySingleEntityTransition(item, transition, opacities, dirtyBatches, context) {
    const fromSide = transition?.from === 'lod' ? 'lod' : 'near';
    const toSide = transition?.to === 'lod' ? 'lod' : 'near';
    const fromOpacity = 1;
    const toOpacity = Math.max(0, Number(opacities?.[toSide]) || 0);

    this.applyRenderSideOpacity(item, fromSide, fromOpacity, dirtyBatches, context);
    this.applyRenderSideOpacity(item, toSide, toOpacity, dirtyBatches, context);

    if (toOpacity >= (1 - RW_FADE_EPSILON)) {
      item?.setActiveSide?.(toSide);
      item?.setTransition?.(null);
      return;
    }
    if (toOpacity <= RW_FADE_EPSILON) {
      item?.setActiveSide?.(fromSide);
      item?.setTransition?.(null);
    }
  }

  update(context = {}) {
    const {
      camera,
      dt,
      activeFadeCountRef,
      frameVisibilityRef,
      chunkOcclusionStateRef,
      bigBuildingItemsRef,
      activeRenderChunksRef,
      renderMetricsRef,
      lodUpdateAccumulatorRef,
      lodUpdateStateRef,
      renderChunkLookupRef,
      uiStateRef,
      activeBackend,
      worldGameVersionRef,
      timecycleStateRef,
      worldRootRef,
      rwRenderQueueRef,
    } = context;
    if (!camera || !lodUpdateStateRef?.current) return;

    lodUpdateAccumulatorRef.current += dt;
    const lodState = lodUpdateStateRef.current;
    const effectiveFarClip = Number.isFinite(context.effectiveFarClip)
      ? context.effectiveFarClip
      : uiStateRef.current.renderingDistance;
    const drawDistance = uiStateRef.current.drawDistance;
    const renderingDistance = effectiveFarClip;
    const showLods = uiStateRef.current.showLods;
    const forceLodOnly = uiStateRef.current.forceLodOnly;
    const showTobjs = uiStateRef.current.showTobjs;
    const enableOcclusion = uiStateRef.current.enableOcclusion === true;

    const configChanged = (
      lodState.lastDrawDistance !== drawDistance
      || lodState.lastRenderingDistance !== renderingDistance
      || lodState.lastShowLods !== showLods
      || lodState.lastForceLodOnly !== forceLodOnly
      || lodState.lastShowTobjs !== showTobjs
      || lodState.lastEnableOcclusion !== enableOcclusion
    );
    if (configChanged) {
      lodState.lastDrawDistance = drawDistance;
      lodState.lastRenderingDistance = renderingDistance;
      lodState.lastShowLods = showLods;
      lodState.lastForceLodOnly = forceLodOnly;
      lodState.lastShowTobjs = showTobjs;
      lodState.lastEnableOcclusion = enableOcclusion;
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
    if (!(lodState.needsRefresh || needsFadeTick) || lodUpdateAccumulatorRef.current < 0.02) {
      return;
    }

    lodUpdateAccumulatorRef.current = 0;
    const distanceFadeConfig = DISTANCE_FADE_DEFAULTS;
    const fadeEpsilon = RenderEntityController.getEpsilon(distanceFadeConfig);
    const frameVisibility = resetFrameVisibilityResult(frameVisibilityRef.current);
    const chunkActiveDist = renderingDistance + CHUNK_ACTIVE_MARGIN;
    const chunkActiveDistSq = chunkActiveDist * chunkActiveDist;
    const chunkFrustum = context.chunkFrustumRef.current;
    const chunkProjScreenMatrix = context.chunkProjScreenMatrixRef.current;
    chunkProjScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    chunkFrustum.setFromProjectionMatrix(chunkProjScreenMatrix);
    const dirtyBatches = new Set();
    const fullRefresh = lodState.needsRefresh === true;
    // Always scan out to the camera far clip. Pairing only affects near vs LOD *inside* a chunk;
    // capping scan by the LOD switch distance would skip whole chunks and hide distant LOD meshes.
    const chunkScanDistance = renderingDistance;
    const previousActiveChunks = activeRenderChunksRef.current;
    const candidateChunks = fullRefresh
      ? this.getCachedGroundScanChunks(camera, chunkScanDistance, drawDistance, renderChunkLookupRef, lodState)
      : Array.from(previousActiveChunks);
    const occlusionState = resetChunkOcclusionState(chunkOcclusionStateRef.current);
    const bigBuildingItems = bigBuildingItemsRef.current;
    const nextActiveChunks = new Set();
    const protectedItems = new Set();
    const processedItems = new Set();
    let activeChunks = 0;
    let frustumChunks = 0;
    let activeItems = 0;
    let visibleNear = 0;
    let visibleLod = 0;
    let activeFades = 0;

    const SetupBigBuildingVisibility = (ent, visibilityState) => {
      const {
        dist,
        hasNear,
        hasLod,
        nearEndDistance,
        lodEndDistance,
        fadeEpsilon,
        runtimeContext,
      } = visibilityState;
      const mi = {
        GetNearDistance: () => ent?.GetNearDistance?.(nearEndDistance) ?? nearEndDistance,
        GetLodDistance: () => lodEndDistance,
        GetRelatedModel: () => ent?.GetRelatedModel?.() ?? null,
      };
      const nonLOD = mi.GetRelatedModel();
      const nearResult = (() => {
        const targetVisible = hasNear
          && !forceLodOnly
          && RenderEntityController.isWithinDrawDistance(dist, mi.GetNearDistance(), distanceFadeConfig);
        if (!ent.nearState) return { visible: false, opacity: 0 };
        return {
          visible: targetVisible,
          opacity: RenderEntityController.updateFade(ent.nearState, {
            targetVisible,
            distance: dist,
            drawDistance: mi.GetNearDistance(),
            dt,
            config: distanceFadeConfig,
            distanceDriven: true,
          }),
        };
      })();
      const lodResult = (() => {
        const targetVisible = hasLod
          && RenderEntityController.isWithinDrawDistance(dist, mi.GetLodDistance(), distanceFadeConfig);
        if (!ent.lodState) return { visible: false, opacity: 0 };
        return {
          visible: targetVisible,
          opacity: RenderEntityController.updateFade(ent.lodState, {
            targetVisible,
            distance: dist,
            drawDistance: mi.GetLodDistance(),
            dt,
            config: distanceFadeConfig,
            distanceDriven: true,
          }),
        };
      })();

      const previousRwObject = ent?.getActiveSide?.() || null;
      const targetRwObject = resolveSingleEntityTargetSide(ent, {
        dist,
        drawDistance,
        showLods,
        forceLodOnly,
      });
      const insideNearDistance = dist < mi.GetNearDistance() && dist < drawDistance;
      const nonLodFullyVisible = Boolean(nonLOD?.GetRwObject?.()) && Number(nonLOD?.m_alpha) >= 255;
      const shouldDrawLodBelowNearDistance = insideNearDistance && !(nonLOD == null || nonLodFullyVisible);

      if (!targetRwObject) {
        this.applySingleEntitySide(ent, null, 0, dirtyBatches, runtimeContext);
        ent?.setMode?.('hidden');
        ent.mode = 'hidden';
        return {
          visibility: VIS_INVISIBLE,
          nearOpacity: 0,
          lodOpacity: 0,
          activeSide: null,
        };
      }

      let nearOpacity = 0;
      let lodOpacity = 0;
      let activeSide = previousRwObject;

      if (targetRwObject === 'near') {
        nearOpacity = nearResult.opacity;
        if (hasLod && lodResult.visible && (shouldDrawLodBelowNearDistance || nearOpacity < (1 - fadeEpsilon))) {
          lodOpacity = Math.max(
            lodResult.opacity,
            previousRwObject === 'lod' || ent?.getSideOpacity?.('lod') > fadeEpsilon ? 1 : 0,
          );
        }
        activeSide = nearOpacity >= (1 - fadeEpsilon)
          ? 'near'
          : (lodOpacity > fadeEpsilon ? 'lod' : 'near');
      } else {
        lodOpacity = insideNearDistance && !shouldDrawLodBelowNearDistance ? 0 : lodResult.opacity;
        if (nonLOD && nearResult.visible && lodOpacity < (1 - fadeEpsilon)) {
          nearOpacity = Math.max(
            nearResult.opacity,
            previousRwObject === 'near' || ent?.getSideOpacity?.('near') > fadeEpsilon ? 1 : 0,
          );
        }
        activeSide = lodOpacity >= (1 - fadeEpsilon)
          ? 'lod'
          : (nearOpacity > fadeEpsilon ? 'near' : 'lod');
      }

      this.applyRenderSideOpacity(ent, 'near', nearOpacity, dirtyBatches, runtimeContext);
      this.applyRenderSideOpacity(ent, 'lod', lodOpacity, dirtyBatches, runtimeContext);

      if (nearOpacity > fadeEpsilon) this.collectRenderSideFrameVisibility(frameVisibility, ent, 'near');
      if (lodOpacity > fadeEpsilon) this.collectRenderSideFrameVisibility(frameVisibility, ent, 'lod');

      const visibility = nearOpacity > fadeEpsilon || lodOpacity > fadeEpsilon
        ? VIS_VISIBLE
        : VIS_INVISIBLE;
      const mode = nearOpacity > fadeEpsilon
        ? (lodOpacity > fadeEpsilon ? 'near+lod' : 'near')
        : (lodOpacity > fadeEpsilon ? 'lod' : 'hidden');

      ent?.setMode?.(mode);
      ent.mode = mode;
      ent?.setActiveSide?.(activeSide);
      ent?.setTransition?.(null);
      if (nearOpacity > fadeEpsilon) visibleNear += 1;
      if (lodOpacity > fadeEpsilon) visibleLod += 1;
      if (visibility !== VIS_INVISIBLE) protectedItems.add(ent);

      return {
        visibility,
        nearOpacity,
        lodOpacity,
        activeSide,
      };
    };

    const SetupEntityVisibility = (ent, { checkOcclusion = false } = {}) => {
      if (!ent || processedItems.has(ent)) return VIS_INVISIBLE;
      processedItems.add(ent);

      const distSq = camera.position.distanceToSquared(ent.anchor);
      const hasNear = hasNearRenderable(ent);
      const hasLod = hasLodRenderable(ent);
      const bypassCloseRangeFrustum = shouldBypassCloseRangeItemFrustum(ent, distSq);
      const itemInFrustum = !enableOcclusion || bypassCloseRangeFrustum || (
        isComplexFrustumItem(ent)
          ? (
            ent.boundingBox?.isBox3
              ? chunkFrustum.intersectsBox(ent.boundingBox)
              : chunkFrustum.intersectsSphere(ent.boundingSphere)
          )
          : chunkFrustum.intersectsSphere(ent.boundingSphere)
      );
      if (!itemInFrustum) {
        this.hideRenderItemCompletely(ent, dirtyBatches, context);
        return VIS_OFFSCREEN;
      }
      if (enableOcclusion && checkOcclusion && isChunkOccluded(occlusionState, camera, ent)) {
        this.hideRenderItemCompletely(ent, dirtyBatches, context);
        return VIS_OFFSCREEN;
      }

      activeItems += 1;
      const tobjAllowed = !ent.isTobj || showTobjs;
      const dist = Math.sqrt(distSq);
      if (!tobjAllowed || !RenderEntityController.isWithinDrawDistance(dist, renderingDistance, distanceFadeConfig)) {
        this.hideRenderItemCompletely(ent, dirtyBatches, context);
        return VIS_INVISIBLE;
      }

      const pairedItem = hasNear && hasLod;
      const nearConfiguredDistance = resolveRenderableDistance(
        ent?.getDrawDistance?.('near') ?? ent.nearState?.drawDistance,
        renderingDistance,
      );
      const nearEndDistance = Math.min(nearConfiguredDistance, renderingDistance);
      const lodEndDistance = Math.min(
        resolveRenderableDistance(ent?.getDrawDistance?.('lod') ?? ent.lodState?.drawDistance, renderingDistance),
        renderingDistance,
      );

      let nearShouldShow = false;
      let lodShouldShow = false;
      let nearOpacity = 0;
      let lodOpacity = 0;
      const runtimeContext = {
        ...context,
        activeBackend,
        worldGameVersionRef,
        timecycleStateRef,
        worldRootRef,
        rwRenderQueueRef,
        uiStateRef,
      };

      if (ent?.usesSingleRwPath?.()) {
        return SetupBigBuildingVisibility(ent, {
          dist,
          hasNear,
          hasLod,
          nearEndDistance,
          lodEndDistance,
          fadeEpsilon,
          runtimeContext,
        }).visibility;
      }

      if (pairedItem && showLods && !forceLodOnly) {
        const nearIdeDistance = resolveRenderableDistance(ent?.getDrawDistance?.('near') ?? ent.nearState?.drawDistance, renderingDistance);
        const nearRangeEnd = Math.min(drawDistance, nearIdeDistance, renderingDistance);
        const nearCoreRange = dist <= nearRangeEnd;
        const nearFadeRange = RenderEntityController.isWithinDrawDistance(dist, nearRangeEnd, distanceFadeConfig);
        const lodVisibleRange = RenderEntityController.isWithinDrawDistance(dist, lodEndDistance, distanceFadeConfig);

        if (hasNear && ent.nearState) {
          nearOpacity = RenderEntityController.updateFade(ent.nearState, {
            targetVisible: nearFadeRange,
            distance: dist,
            drawDistance: nearRangeEnd,
            dt,
            config: distanceFadeConfig,
            distanceDriven: true,
          });
        }
        if (hasLod && ent.lodState) {
          lodOpacity = RenderEntityController.updateFade(ent.lodState, {
            targetVisible: lodVisibleRange,
            distance: dist,
            drawDistance: lodEndDistance,
            dt,
            config: distanceFadeConfig,
            distanceDriven: true,
          });
        }

        const nearStreamAlpha = ent.nearState?.streamAlpha ?? 1;
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

        if (hasNear && ent.nearState) {
          nearOpacity = RenderEntityController.updateFade(ent.nearState, {
            targetVisible: nearShouldShow,
            distance: dist,
            drawDistance: nearEndDistance,
            dt,
            config: distanceFadeConfig,
            distanceDriven: true,
          });
        }

        lodShouldShow = hasLod
          && RenderEntityController.isWithinDrawDistance(dist, lodEndDistance, distanceFadeConfig)
          && lodShouldShowBase;
        if (hasLod && ent.lodState) {
          lodOpacity = RenderEntityController.updateFade(ent.lodState, {
            targetVisible: lodShouldShow,
            distance: dist,
            drawDistance: lodEndDistance,
            dt,
            config: distanceFadeConfig,
            distanceDriven: true,
          });
        }
      }

      ent?.setMode?.(nearOpacity > fadeEpsilon
        ? (lodOpacity > fadeEpsilon ? 'near+lod' : 'near')
        : (lodOpacity > fadeEpsilon ? 'lod' : 'hidden'));
      ent.mode = nearOpacity > fadeEpsilon
        ? (lodOpacity > fadeEpsilon ? 'near+lod' : 'near')
        : (lodOpacity > fadeEpsilon ? 'lod' : 'hidden');

      if (nearOpacity > fadeEpsilon) visibleNear += 1;
      if (lodOpacity > fadeEpsilon) visibleLod += 1;

      this.applyRenderSideOpacity(ent, 'near', nearOpacity, dirtyBatches, runtimeContext);
      this.applyRenderSideOpacity(ent, 'lod', lodOpacity, dirtyBatches, runtimeContext);
      this.collectRenderSideFrameVisibility(frameVisibility, ent, 'near');
      this.collectRenderSideFrameVisibility(frameVisibility, ent, 'lod');

      if (
        nearOpacity > fadeEpsilon
        || lodOpacity > fadeEpsilon
        || (ent.nearState?.streamAlpha ?? 0) > fadeEpsilon
        || (hasLod && (ent.lodState?.streamAlpha ?? 0) > fadeEpsilon)
      ) {
        protectedItems.add(ent);
      }
      return nearOpacity > fadeEpsilon || lodOpacity > fadeEpsilon ? VIS_VISIBLE : VIS_INVISIBLE;
    };

    for (const chunk of candidateChunks) {
      const chunkInRange = camera.position.distanceToSquared(chunk.center) <= chunkActiveDistSq;
      const bypassCloseRangeChunkFrustum = shouldBypassCloseRangeChunkFrustum(chunk, camera);
      const chunkInFrustum = chunkInRange && (
        !enableOcclusion || (
        bypassCloseRangeChunkFrustum || (
        chunk.boundingBox?.isBox3
          ? chunkFrustum.intersectsBox(chunk.boundingBox)
          : chunkFrustum.intersectsSphere(chunk.boundingSphere)
        )
        )
      );
      if (chunkInRange) frustumChunks += chunkInFrustum ? 1 : 0;
      if (!chunkInFrustum) {
        if (chunk.active) {
          chunk.active = false;
          for (const item of chunk.items) {
            this.hideRenderItemCompletely(item, dirtyBatches, context);
          }
        }
        continue;
      }
      if (enableOcclusion && isChunkOccluded(occlusionState, camera, chunk)) {
        if (chunk.active) {
          chunk.active = false;
          for (const item of chunk.items) {
            this.hideRenderItemCompletely(item, dirtyBatches, context);
          }
        }
        continue;
      }

      chunk.active = true;
      nextActiveChunks.add(chunk);
      activeChunks += 1;
      addVisibleChunk(frameVisibility, chunk);
      for (const emitter of chunk.coronaEmitters) addCoronaCandidate(frameVisibility, emitter);
      for (const emitter of chunk.shadowEmitters) addShadowCandidate(frameVisibility, emitter);
      for (const item of chunk.items) {
        SetupEntityVisibility(item);
      }
      if (enableOcclusion) {
        registerChunkOccluder(occlusionState, camera, chunk);
      }
    }

    for (const item of bigBuildingItems) {
      SetupEntityVisibility(item, { checkOcclusion: true });
    }

    for (const chunk of previousActiveChunks) {
      if (nextActiveChunks.has(chunk)) continue;
      if (!chunk?.active) continue;
      chunk.active = false;
      for (const item of chunk.items) {
        if (protectedItems.has(item)) continue;
        this.hideRenderItemCompletely(item, dirtyBatches, context);
      }
    }

    activeRenderChunksRef.current = nextActiveChunks;
    for (const batch of dirtyBatches) {
      flushDirtyInstancedBatch(batch);
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
}

export default WorldStreamingRuntime;
