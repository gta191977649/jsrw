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
  getRWMaterialDescriptor,
  prepareTobjInstanceMaterials,
  setRWMaterialDescriptor,
  syncThreeMaterialFromRW,
} from '../../adapters/three/ThreeMaterialAdapter.js';
import { applyRwIdeFlagsToInstance } from '../../adapters/three/RwIdeFlagsAdapter.js';
import { cloneRwMaterialDescriptor as cloneRWMaterialDescriptor } from '../../core/material/RwMaterialDescriptor.js';
import {
  createCameraRuntimeSnapshot,
  getCameraForwardPlanarWeight,
  isBoxVisibleInCameraRuntime,
  isSphereVisibleInCameraRuntime,
} from '../../core/camera/CameraRuntime.js';
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
const OCCLUSION_CACHE_MS = 120;
const VISIBILITY_FAR_CHUNK_BUDGET = 48;
const BIG_BUILDING_OCCLUSION_BUDGET = 48;
const VISIBILITY_DEFAULT_INTERVAL = 0.02;
const VISIBILITY_ROTATION_ONLY_INTERVAL = 0.04;
const FALLBACK_AMBIENT = new THREE.Color(1, 1, 1);
const FALLBACK_EMISSIVE = new THREE.Color(0, 0, 0);

function getProfilingTimeNow() {
  return globalThis.performance?.now?.() ?? Date.now();
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
    const cloned = material.clone();
    cloned.userData = {
      ...(material.userData || {}),
      ...(cloned.userData || {}),
      rwPipelineOwnedMaterial: true,
    };
    setRWMaterialDescriptor(cloned, fadeDescriptor);
    return syncThreeMaterialFromRW(cloned, geometry);
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

function flushDirtyInstancedBatch(batch) {
  if (!batch?.mesh || !Array.isArray(batch.entries)) return;
  let activeIndex = 0;
  batch.activeEntries.length = 0;
  for (const handle of batch.entries) {
    if (!handle?.visible) {
      if (handle) handle.activeIndex = -1;
      continue;
    }
    batch.mesh.setMatrixAt(activeIndex, handle.matrix);
    handle.activeIndex = activeIndex;
    batch.activeEntries.push(handle);
    activeIndex += 1;
  }
  batch.visibleCount = activeIndex;
  batch.mesh.count = activeIndex;
  batch.mesh.visible = activeIndex > 0;
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
    handle.batch.visibleCount += visible ? 1 : -1;
    dirtyBatches?.add(handle.batch);
  }
}

function setRenderSideOriginalVisible(item, side, visible, dirtyBatches) {
  if (side === 'near') {
    if (item.nearObj) item.nearObj.visible = visible;
    setInstanceHandlesVisible(item.nearHandles, visible, dirtyBatches);
    return;
  }
  if (item.lodObj) item.lodObj.visible = visible;
  setInstanceHandlesVisible(item.lodHandles, visible, dirtyBatches);
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
  return Boolean(item?.nearState?.hasRenderable)
    || Boolean(item?.nearObj)
    || (Array.isArray(item?.nearHandles) && item.nearHandles.length > 0);
}

function hasLodRenderable(item) {
  return Boolean(item?.lodState?.hasRenderable)
    || Boolean(item?.lodObj)
    || (Array.isArray(item?.lodHandles) && item.lodHandles.length > 0);
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

    if (clampedOpacity <= RW_FADE_EPSILON) {
      if (disposeRenderSideObjectFade(sideState)) rwRenderQueueRef.current?.markDirty?.();
      setRenderSideOriginalVisible(item, side, false, dirtyBatches);
      if (this.disposeRenderSideFadeProxy(sideState)) rwRenderQueueRef.current?.markDirty?.();
      sideState.currentOpacity = 0;
      return false;
    }

    if (clampedOpacity >= (1 - RW_FADE_EPSILON)) {
      if (disposeRenderSideObjectFade(sideState)) rwRenderQueueRef.current?.markDirty?.();
      if (this.disposeRenderSideFadeProxy(sideState)) rwRenderQueueRef.current?.markDirty?.();
      setRenderSideOriginalVisible(item, side, true, dirtyBatches);
      sideState.currentOpacity = 1;
      return false;
    }

    if (ensureRenderSideObjectFade(sideState)) {
      if (this.disposeRenderSideFadeProxy(sideState)) rwRenderQueueRef.current?.markDirty?.();
      sideState.renderObject.visible = true;
      setRenderSideObjectFadeOpacity(sideState, clampedOpacity);
      sideState.currentOpacity = clampedOpacity;
      return false;
    }

    if (this.disposeRenderSideFadeProxy(sideState)) rwRenderQueueRef.current?.markDirty?.();
    setRenderSideOriginalVisible(item, side, clampedOpacity > RW_FADE_EPSILON, dirtyBatches);
    sideState.currentOpacity = clampedOpacity;
    return true;
  }

  hideRenderItemCompletely(item, dirtyBatches, context) {
    const { rwRenderQueueRef } = context;
    item.mode = 'hidden';
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
    const cameraRuntime = createCameraRuntimeSnapshot(camera);

    const resolvedRenderDistance = Math.max(WORLD_CHUNK_SIZE, renderDistance || WORLD_CHUNK_SIZE);
    const resolvedPriorityDistance = Math.max(
      WORLD_CHUNK_SIZE,
      Math.min(resolvedRenderDistance, priorityDistance || Math.min(resolvedRenderDistance, resolvedRenderDistance * 0.2)),
    );
    const cameraChunkX = Math.floor(camera.position.x / WORLD_CHUNK_SIZE);
    const cameraChunkZ = Math.floor(camera.position.z / WORLD_CHUNK_SIZE);
    const scanRadius = Math.ceil(
      (resolvedRenderDistance + CHUNK_ACTIVE_MARGIN + WORLD_CHUNK_SIZE) / WORLD_CHUNK_SIZE,
    );
    const candidates = [];

    for (let chunkZ = cameraChunkZ - scanRadius; chunkZ <= cameraChunkZ + scanRadius; chunkZ += 1) {
      for (let chunkX = cameraChunkX - scanRadius; chunkX <= cameraChunkX + scanRadius; chunkX += 1) {
        const chunk = chunkLookup.get(`${chunkX},${chunkZ}`);
        if (!chunk) continue;
        const chunkCenter = chunk?.center;
        if (!chunkCenter) continue;
        const dx = (chunkCenter.x ?? 0) - cameraRuntime.position.x;
        const dz = (chunkCenter.z ?? 0) - cameraRuntime.position.z;
        const chunkRadius = Math.max(
          WORLD_CHUNK_SIZE,
          Number(chunk.boundingSphere?.radius) || 0,
        );
        const distance = Math.hypot(dx, dz);
        if (distance > resolvedRenderDistance + chunkRadius + CHUNK_ACTIVE_MARGIN) continue;
        const forwardWeight = getCameraForwardPlanarWeight(cameraRuntime, chunkCenter);
        candidates.push({
          chunk,
          distance,
          priority: forwardWeight >= -(chunkRadius * 0.5) || distance <= resolvedPriorityDistance + chunkRadius,
          forwardWeight,
        });
      }
    }

    candidates.sort((left, right) => {
      if (left.priority !== right.priority) return left.priority ? -1 : 1;
      if (Math.abs(left.forwardWeight - right.forwardWeight) > 1e-4) return right.forwardWeight - left.forwardWeight;
      return left.distance - right.distance;
    });

    return candidates.map((entry) => entry.chunk);
  }

  collectRenderSideFrameVisibility(frameVisibility, item, side) {
    const sideState = side === 'near' ? item?.nearState : item?.lodState;
    if (!frameVisibility || !sideState) return;
    if ((sideState.currentOpacity ?? 0) <= RW_FADE_EPSILON) return;

    addVisibleItem(frameVisibility, item);

    if (sideState.renderObject?.visible) {
      for (const mesh of getCachedQueueMeshes(sideState.renderObject)) {
        addVisibleQueueMesh(frameVisibility, mesh);
      }
    }

    const handles = side === 'near' ? item?.nearHandles : item?.lodHandles;
    if (!Array.isArray(handles) || handles.length === 0) return;
    for (const handle of handles) {
      if (!handle?.visible || !handle?.batch?.mesh) continue;
      addVisibleQueueMesh(frameVisibility, handle.batch.mesh);
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
      lodState.needsVisibilityRefresh = true;
      lodState.needsResidencyRefresh = true;
    }

    const knownCameraPos = Number.isFinite(lodState.lastCameraPos.x)
      && Number.isFinite(lodState.lastCameraPos.y)
      && Number.isFinite(lodState.lastCameraPos.z);
    const currentCameraChunkX = Math.floor(camera.position.x / WORLD_CHUNK_SIZE);
    const currentCameraChunkZ = Math.floor(camera.position.z / WORLD_CHUNK_SIZE);
    const knownCameraChunk = Number.isFinite(lodState.lastCameraChunkX)
      && Number.isFinite(lodState.lastCameraChunkZ);
    const sectorChanged = !knownCameraChunk
      || currentCameraChunkX !== lodState.lastCameraChunkX
      || currentCameraChunkZ !== lodState.lastCameraChunkZ;

    const cameraMoved = !knownCameraPos || camera.position.distanceToSquared(lodState.lastCameraPos) > 9;
    if (cameraMoved) {
      lodState.lastCameraPos.copy(camera.position);
      lodState.needsRefresh = true;
      lodState.needsVisibilityRefresh = true;
    }

    if (sectorChanged) {
      lodState.lastCameraChunkX = currentCameraChunkX;
      lodState.lastCameraChunkZ = currentCameraChunkZ;
      lodState.needsRefresh = true;
      lodState.needsVisibilityRefresh = true;
      lodState.needsResidencyRefresh = true;
    }

    const knownCameraQuat = Number.isFinite(lodState.lastCameraQuat.x)
      && Number.isFinite(lodState.lastCameraQuat.y)
      && Number.isFinite(lodState.lastCameraQuat.z)
      && Number.isFinite(lodState.lastCameraQuat.w);
    const cameraQuatDot = knownCameraQuat ? Math.abs(camera.quaternion.dot(lodState.lastCameraQuat)) : 0;
    const cameraRotated = !knownCameraQuat || cameraQuatDot < 0.99995;
    if (cameraRotated) {
      lodState.lastCameraQuat.copy(camera.quaternion);
      lodState.needsRefresh = true;
      lodState.needsVisibilityRefresh = true;
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
      lodState.needsVisibilityRefresh = true;
    }

    const workerPlan = context.workerPlan || null;
    const hasWorkerVisibilityPlan = Boolean(
      Array.isArray(workerPlan?.candidateChunkKeys)
      || Array.isArray(workerPlan?.frustumChunkKeys),
    );
    const workerPlanStable = hasWorkerVisibilityPlan && context.workerPlanStable === true;
    const needsFadeTick = activeFadeCountRef.current > 0;
    const needsVisibilityRefresh = lodState.needsVisibilityRefresh || lodState.needsRefresh || needsFadeTick;
    const rotationOnlyRefresh = cameraRotated
      && !cameraMoved
      && !sectorChanged
      && !projectionChanged
      && !configChanged
      && !needsFadeTick;
    const requiredVisibilityInterval = hasWorkerVisibilityPlan
      ? 0
      : rotationOnlyRefresh
      ? VISIBILITY_ROTATION_ONLY_INTERVAL
      : VISIBILITY_DEFAULT_INTERVAL;
    if (!needsVisibilityRefresh || lodUpdateAccumulatorRef.current < requiredVisibilityInterval) {
      return;
    }

    lodUpdateAccumulatorRef.current = 0;
    const frameScanCode = ((((Number(lodState.scanCode) || 0) + 1) >>> 0) || 1);
    lodState.scanCode = frameScanCode;
    const visibilityStageStart = getProfilingTimeNow();
    let residencyCpuMs = 0;
    let frustumCpuMs = 0;
    let occlusionCpuMs = 0;
    let chunkFrustumTests = 0;
    let itemFrustumTests = 0;
    let chunkOcclusionTests = 0;
    let itemOcclusionTests = 0;
    let visibilityProcessedItems = 0;
    const distanceFadeConfig = DISTANCE_FADE_DEFAULTS;
    const fadeEpsilon = RenderEntityController.getEpsilon(distanceFadeConfig);
    const frameVisibility = resetFrameVisibilityResult(frameVisibilityRef.current);
    const cameraRuntime = createCameraRuntimeSnapshot(camera);
    const chunkActiveDist = renderingDistance + CHUNK_ACTIVE_MARGIN;
    const chunkActiveDistSq = chunkActiveDist * chunkActiveDist;
    const dirtyBatches = new Set();
    // Always scan out to the camera far clip. Pairing only affects near vs LOD *inside* a chunk;
    // capping scan by the LOD switch distance would skip whole chunks and hide distant LOD meshes.
    const chunkScanDistance = renderingDistance;
    const needsResidencyRefresh = lodState.needsResidencyRefresh
      || !Array.isArray(lodState.residentScanChunks)
      || lodState.residentScanChunks.length === 0;
    const residencyStart = getProfilingTimeNow();
    const workerCandidateChunks = needsResidencyRefresh && Array.isArray(workerPlan?.candidateChunkKeys)
      ? workerPlan.candidateChunkKeys
        .map((key) => renderChunkLookupRef.current?.get?.(key) || null)
        .filter(Boolean)
      : null;
    const candidateChunks = needsResidencyRefresh
      ? (workerCandidateChunks || this.collectGroundScanChunks(camera, chunkScanDistance, drawDistance, renderChunkLookupRef))
      : lodState.residentScanChunks;
    if (needsResidencyRefresh) {
      lodState.residentScanChunks = candidateChunks;
    }
    residencyCpuMs = Math.max(0, getProfilingTimeNow() - residencyStart);
    if (!workerCandidateChunks) {
      candidateChunks.sort((a, b) => {
        const da = camera.position.distanceToSquared(a.center);
        const db = camera.position.distanceToSquared(b.center);
        return da - db;
      });
    }
    const occlusionState = resetChunkOcclusionState(chunkOcclusionStateRef.current);
    const workerFrustumChunkKeys = Array.isArray(workerPlan?.frustumChunkKeys)
      ? new Set(workerPlan.frustumChunkKeys)
      : null;
    const workerVisibleChunkKeys = Array.isArray(workerPlan?.visibleChunkKeys)
      ? new Set(workerPlan.visibleChunkKeys)
      : null;
    const bigBuildingItems = bigBuildingItemsRef.current;
    const previousActiveChunks = activeRenderChunksRef.current;
    const nextActiveChunks = new Set();
    const protectedItems = new Set();
    const nearRefreshDistanceSq = (drawDistance + WORLD_CHUNK_SIZE) * (drawDistance + WORLD_CHUNK_SIZE);
    const farChunks = [];
    for (const chunk of candidateChunks) {
      if (camera.position.distanceToSquared(chunk.center) > nearRefreshDistanceSq) {
        farChunks.push(chunk);
      }
    }
    const farChunkRefreshSet = new Set();
    if (farChunks.length > 0) {
      if (hasWorkerVisibilityPlan) {
        if (!workerPlanStable) {
          for (const chunk of farChunks) farChunkRefreshSet.add(chunk);
        }
        lodState.visibilityChunkCursor = 0;
      } else {
        const farChunkBudget = Math.min(VISIBILITY_FAR_CHUNK_BUDGET, farChunks.length);
        const startCursor = Math.max(0, Math.floor(Number(lodState.visibilityChunkCursor) || 0)) % farChunks.length;
        for (let index = 0; index < farChunkBudget; index += 1) {
          farChunkRefreshSet.add(farChunks[(startCursor + index) % farChunks.length]);
        }
        lodState.visibilityChunkCursor = (startCursor + farChunkBudget) % farChunks.length;
      }
    } else {
      lodState.visibilityChunkCursor = 0;
    }
    let activeChunks = 0;
    let frustumChunks = 0;
    let activeItems = 0;
    let visibleNear = 0;
    let visibleLod = 0;
    let activeFades = 0;
    let fadeProxyCount = 0;

    const collectExistingItemState = (item) => {
      if (!item || item.__rwVisibilityScanCode === frameScanCode) return;
      item.__rwVisibilityScanCode = frameScanCode;
      visibilityProcessedItems += 1;
      const nearOpacity = Number(item?.nearState?.fadeAlpha) || 0;
      const lodOpacity = Number(item?.lodState?.fadeAlpha) || 0;
      const nearStream = Number(item?.nearState?.streamAlpha) || 0;
      const lodStream = Number(item?.lodState?.streamAlpha) || 0;
      if (nearOpacity > fadeEpsilon || lodOpacity > fadeEpsilon || nearStream > fadeEpsilon || lodStream > fadeEpsilon) {
        activeItems += 1;
      }
      if (nearOpacity > fadeEpsilon) visibleNear += 1;
      if (lodOpacity > fadeEpsilon) visibleLod += 1;
      this.collectRenderSideFrameVisibility(frameVisibility, item, 'near');
      this.collectRenderSideFrameVisibility(frameVisibility, item, 'lod');
      if (
        (nearOpacity > fadeEpsilon && nearOpacity < (1 - fadeEpsilon))
        || (lodOpacity > fadeEpsilon && lodOpacity < (1 - fadeEpsilon))
        || (nearStream > fadeEpsilon && nearStream < (1 - fadeEpsilon))
        || (lodStream > fadeEpsilon && lodStream < (1 - fadeEpsilon))
      ) {
        activeFades += 1;
      }
      if (nearOpacity > fadeEpsilon || lodOpacity > fadeEpsilon || nearStream > fadeEpsilon || lodStream > fadeEpsilon) {
        protectedItems.add(item);
      }
      if (item.nearState?.proxyRoot?.visible) fadeProxyCount += 1;
      if (item.lodState?.proxyRoot?.visible) fadeProxyCount += 1;
    };

    const processRenderItem = (item, { checkOcclusion = false } = {}) => {
      if (!item || item.__rwVisibilityScanCode === frameScanCode) return;
      item.__rwVisibilityScanCode = frameScanCode;
      visibilityProcessedItems += 1;

      const distSq = camera.position.distanceToSquared(item.anchor);
      const hasNear = hasNearRenderable(item);
      const hasLod = hasLodRenderable(item);
      const nearConfiguredDistance = Math.min(
        resolveRenderableDistance(item.nearState?.drawDistance, renderingDistance),
        renderingDistance,
      );
      const lodConfiguredDistance = Math.min(
        resolveRenderableDistance(item.lodState?.drawDistance, renderingDistance),
        renderingDistance,
      );
      const maxRenderableDistance = Math.max(
        hasNear && !forceLodOnly ? nearConfiguredDistance : 0,
        hasLod ? lodConfiguredDistance : 0,
      );
      const currentVisibilityAlpha = Math.max(
        Number(item?.nearState?.fadeAlpha) || 0,
        Number(item?.nearState?.streamAlpha) || 0,
        Number(item?.lodState?.fadeAlpha) || 0,
        Number(item?.lodState?.streamAlpha) || 0,
      );
      const hardCullDistance = maxRenderableDistance + distanceFadeConfig.window;
      if (
        maxRenderableDistance > 0
        && distSq > (hardCullDistance * hardCullDistance)
        && currentVisibilityAlpha <= fadeEpsilon
      ) {
        this.hideRenderItemCompletely(item, dirtyBatches, context);
        return;
      }
      const bypassCloseRangeFrustum = shouldBypassCloseRangeItemFrustum(item, distSq);
      let itemInFrustum = !enableOcclusion || bypassCloseRangeFrustum;
      if (!itemInFrustum) {
        const frustumStart = getProfilingTimeNow();
        itemFrustumTests += 1;
        itemInFrustum = isComplexFrustumItem(item)
          ? (
            item.boundingBox?.isBox3
              ? isBoxVisibleInCameraRuntime(cameraRuntime, item.boundingBox)
              : isSphereVisibleInCameraRuntime(cameraRuntime, item.boundingSphere?.center, item.boundingSphere?.radius)
          )
          : isSphereVisibleInCameraRuntime(cameraRuntime, item.boundingSphere?.center, item.boundingSphere?.radius);
        frustumCpuMs += Math.max(0, getProfilingTimeNow() - frustumStart);
      }
      if (!itemInFrustum) {
        this.hideRenderItemCompletely(item, dirtyBatches, context);
        return;
      }
      if (enableOcclusion && checkOcclusion) {
        const nowMs = Number(context.timeMs) || 0;
        let itemOccluded = false;
        const canReuseOcclusion = Number.isFinite(item.__rwOcclusionCheckedAt)
          && (nowMs - item.__rwOcclusionCheckedAt) <= OCCLUSION_CACHE_MS;
        if (canReuseOcclusion) {
          itemOccluded = item.__rwOcclusionResult === true;
        } else {
          const occlusionStart = getProfilingTimeNow();
          itemOcclusionTests += 1;
          itemOccluded = isChunkOccluded(occlusionState, cameraRuntime, item);
          occlusionCpuMs += Math.max(0, getProfilingTimeNow() - occlusionStart);
          item.__rwOcclusionCheckedAt = nowMs;
          item.__rwOcclusionResult = itemOccluded;
        }
        if (itemOccluded) {
          this.hideRenderItemCompletely(item, dirtyBatches, context);
          return;
        }
      }

      activeItems += 1;
      const tobjAllowed = !item.isTobj || showTobjs;
      const dist = Math.sqrt(distSq);
      if (!tobjAllowed || !RenderEntityController.isWithinDrawDistance(dist, renderingDistance, distanceFadeConfig)) {
        this.hideRenderItemCompletely(item, dirtyBatches, context);
        return;
      }

      const pairedItem = hasNear && hasLod;
      // Unpaired near (no LOD mesh) or near-only: never use the LOD switch slider as IDE fallback —
      // that was clipping buildings with no paired LOD. Paired crossfade uses nearRangeEnd below.
      const nearEndDistance = nearConfiguredDistance;
      const lodEndDistance = lodConfiguredDistance;

      let nearShouldShow = false;
      let lodShouldShow = false;
      let nearOpacity = 0;
      let lodOpacity = 0;

      if (pairedItem && showLods && !forceLodOnly) {
        const nearIdeDistance = resolveRenderableDistance(item.nearState?.drawDistance, renderingDistance);
        const nearRangeEnd = Math.min(drawDistance, nearIdeDistance, renderingDistance);
        const nearCoreRange = dist <= nearRangeEnd;
        const nearFadeRange = RenderEntityController.isWithinDrawDistance(dist, nearRangeEnd, distanceFadeConfig);
        const lodVisibleRange = RenderEntityController.isWithinDrawDistance(dist, lodEndDistance, distanceFadeConfig);

        if (hasNear && item.nearState) {
          nearOpacity = RenderEntityController.updateFade(item.nearState, {
            targetVisible: nearFadeRange,
            distance: dist,
            drawDistance: nearRangeEnd,
            dt,
            config: distanceFadeConfig,
          });
        }
        if (hasLod && item.lodState) {
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

        if (hasNear && item.nearState) {
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
        if (hasLod && item.lodState) {
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

      this.applyRenderSideOpacity(item, 'near', nearOpacity, dirtyBatches, {
        ...context,
        activeBackend,
        worldGameVersionRef,
        timecycleStateRef,
        worldRootRef,
        rwRenderQueueRef,
        uiStateRef,
      });
      this.applyRenderSideOpacity(item, 'lod', lodOpacity, dirtyBatches, {
        ...context,
        activeBackend,
        worldGameVersionRef,
        timecycleStateRef,
        worldRootRef,
        rwRenderQueueRef,
        uiStateRef,
      });
      this.collectRenderSideFrameVisibility(frameVisibility, item, 'near');
      this.collectRenderSideFrameVisibility(frameVisibility, item, 'lod');

      const itemHasActiveFade = (
        (nearOpacity > fadeEpsilon && nearOpacity < (1 - fadeEpsilon))
        || (lodOpacity > fadeEpsilon && lodOpacity < (1 - fadeEpsilon))
        || (nearShouldShow && (item.nearState?.streamAlpha ?? 1) < (1 - fadeEpsilon))
        || (hasLod && lodShouldShow && (item.lodState?.streamAlpha ?? 1) < (1 - fadeEpsilon))
        || (!nearShouldShow && (item.nearState?.streamAlpha ?? 0) > fadeEpsilon)
        || (hasLod && !lodShouldShow && (item.lodState?.streamAlpha ?? 0) > fadeEpsilon)
      );
      if (itemHasActiveFade) {
        activeFades += 1;
      }
      if (
        nearOpacity > fadeEpsilon
        || lodOpacity > fadeEpsilon
        || (item.nearState?.streamAlpha ?? 0) > fadeEpsilon
        || (hasLod && (item.lodState?.streamAlpha ?? 0) > fadeEpsilon)
      ) {
        protectedItems.add(item);
      }
      if (item.nearState?.proxyRoot?.visible) fadeProxyCount += 1;
      if (item.lodState?.proxyRoot?.visible) fadeProxyCount += 1;
    };

    for (const chunk of candidateChunks) {
      const chunkDistanceSq = camera.position.distanceToSquared(chunk.center);
      const shouldFullyRefreshChunk = chunkDistanceSq <= nearRefreshDistanceSq || farChunkRefreshSet.has(chunk);
      if (!shouldFullyRefreshChunk) {
        if (chunk.active) {
          nextActiveChunks.add(chunk);
          activeChunks += 1;
          addVisibleChunk(frameVisibility, chunk);
          for (const emitter of chunk.coronaEmitters) addCoronaCandidate(frameVisibility, emitter);
          for (const emitter of chunk.shadowEmitters) addShadowCandidate(frameVisibility, emitter);
          for (const item of chunk.items) collectExistingItemState(item);
        }
        continue;
      }
      const chunkInRange = camera.position.distanceToSquared(chunk.center) <= chunkActiveDistSq;
      const bypassCloseRangeChunkFrustum = shouldBypassCloseRangeChunkFrustum(chunk, camera);
      let chunkInFrustum = chunkInRange && !enableOcclusion;
      if (chunkInRange && enableOcclusion && !bypassCloseRangeChunkFrustum) {
        if (workerFrustumChunkKeys) {
          chunkInFrustum = workerFrustumChunkKeys.has(chunk.key);
        } else {
          const frustumStart = getProfilingTimeNow();
          chunkFrustumTests += 1;
          chunkInFrustum = chunk.boundingBox?.isBox3
            ? isBoxVisibleInCameraRuntime(cameraRuntime, chunk.boundingBox)
            : isSphereVisibleInCameraRuntime(cameraRuntime, chunk.boundingSphere?.center, chunk.boundingSphere?.radius);
          frustumCpuMs += Math.max(0, getProfilingTimeNow() - frustumStart);
        }
      } else if (chunkInRange && bypassCloseRangeChunkFrustum) {
        chunkInFrustum = true;
      }
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
      let chunkOccluded = false;
      if (enableOcclusion) {
        if (workerVisibleChunkKeys) {
          chunkOccluded = !workerVisibleChunkKeys.has(chunk.key);
        } else {
          const occlusionStart = getProfilingTimeNow();
          chunkOcclusionTests += 1;
          chunkOccluded = isChunkOccluded(occlusionState, cameraRuntime, chunk);
          occlusionCpuMs += Math.max(0, getProfilingTimeNow() - occlusionStart);
        }
      }
      if (chunkOccluded) {
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
        processRenderItem(item);
      }
      if (enableOcclusion && !workerVisibleChunkKeys) {
        const occlusionStart = getProfilingTimeNow();
        registerChunkOccluder(occlusionState, cameraRuntime, chunk);
        occlusionCpuMs += Math.max(0, getProfilingTimeNow() - occlusionStart);
      }
    }

    const bigBuildingRefreshSet = new Set();
    if (bigBuildingItems.length > 0) {
      if (hasWorkerVisibilityPlan) {
        if (!workerPlanStable) {
          for (const item of bigBuildingItems) bigBuildingRefreshSet.add(item);
        }
        lodState.bigBuildingCursor = 0;
      } else {
        const budget = Math.min(BIG_BUILDING_OCCLUSION_BUDGET, bigBuildingItems.length);
        const startCursor = Math.max(0, Math.floor(Number(lodState.bigBuildingCursor) || 0)) % bigBuildingItems.length;
        for (let index = 0; index < budget; index += 1) {
          bigBuildingRefreshSet.add(bigBuildingItems[(startCursor + index) % bigBuildingItems.length]);
        }
        lodState.bigBuildingCursor = (startCursor + budget) % bigBuildingItems.length;
      }
    } else {
      lodState.bigBuildingCursor = 0;
    }

    for (const item of bigBuildingItems) {
      const distSq = camera.position.distanceToSquared(item.anchor);
      const shouldFullyRefreshItem = distSq <= nearRefreshDistanceSq || bigBuildingRefreshSet.has(item);
      if (shouldFullyRefreshItem) processRenderItem(item, { checkOcclusion: enableOcclusion && !hasWorkerVisibilityPlan });
      else collectExistingItemState(item);
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
      fadeProxyCount,
      activeFadeCount: activeFades,
      streamingResidencyCpuMs: residencyCpuMs,
      streamingVisibilityCpuMs: Math.max(0, getProfilingTimeNow() - visibilityStageStart),
      frustumCpuMs,
      occlusionCpuMs,
      chunkFrustumTests,
      itemFrustumTests,
      chunkOcclusionTests,
      itemOcclusionTests,
      residentChunkCount: candidateChunks.length,
      visibilityProcessedItems,
    };
    frameVisibility.computed = true;
    frameVisibility.version = ((Number(frameVisibility.version) || 0) + 1) >>> 0;
    activeFadeCountRef.current = activeFades;
    lodState.needsRefresh = activeFades > 0;
    lodState.needsVisibilityRefresh = activeFades > 0;
    lodState.needsResidencyRefresh = false;
  }
}

export default WorldStreamingRuntime;
