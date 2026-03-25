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
  const activeBackend = String(material.userData?.rwPipelineBackend || 'WEBGL').toUpperCase();
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
        activeBackend,
        runtimeContext: {
          activeBackend,
        },
      },
    );
    if (pipelineMaterial) {
      pipelineMaterial.userData = {
        ...(pipelineMaterial.userData || {}),
        ...(material.userData || {}),
        ...(pipelineMaterial.userData || {}),
        rwPipelineOwnedMaterial: true,
        rwPipelineBackend: activeBackend,
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

    setRenderSideOriginalVisible(item, side, false, dirtyBatches);
    const proxy = this.ensureRenderSideFadeProxy(item, side, context);
    if (!proxy) {
      setRenderSideOriginalVisible(item, side, true, dirtyBatches);
      sideState.currentOpacity = 1;
      return false;
    }
    setFadeProxyOpacity(proxy, clampedOpacity);
    proxy.visible = true;
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

  collectRenderSideFrameVisibility(frameVisibility, item, side) {
    const sideState = side === 'near' ? item?.nearState : item?.lodState;
    if (!frameVisibility || !sideState) return;
    if ((sideState.currentOpacity ?? 0) <= RW_FADE_EPSILON) return;

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
    // Always scan out to the camera far clip. Pairing only affects near vs LOD *inside* a chunk;
    // capping scan by the LOD switch distance would skip whole chunks and hide distant LOD meshes.
    const chunkScanDistance = renderingDistance;
    const candidateChunks = this.collectGroundScanChunks(camera, chunkScanDistance, drawDistance, renderChunkLookupRef);
    candidateChunks.sort((a, b) => {
      const da = camera.position.distanceToSquared(a.center);
      const db = camera.position.distanceToSquared(b.center);
      return da - db;
    });
    const occlusionState = resetChunkOcclusionState(chunkOcclusionStateRef.current);
    const bigBuildingItems = bigBuildingItemsRef.current;
    const previousActiveChunks = activeRenderChunksRef.current;
    const nextActiveChunks = new Set();
    const protectedItems = new Set();
    const processedItems = new Set();
    let activeChunks = 0;
    let frustumChunks = 0;
    let activeItems = 0;
    let visibleNear = 0;
    let visibleLod = 0;
    let activeFades = 0;
    let fadeProxyCount = 0;

    const processRenderItem = (item, { checkOcclusion = false } = {}) => {
      if (!item || processedItems.has(item)) return;
      processedItems.add(item);

      const distSq = camera.position.distanceToSquared(item.anchor);
      const hasNear = hasNearRenderable(item);
      const hasLod = hasLodRenderable(item);
      const bypassCloseRangeFrustum = shouldBypassCloseRangeItemFrustum(item, distSq);
      const itemInFrustum = !enableOcclusion || bypassCloseRangeFrustum || (
        isComplexFrustumItem(item)
          ? (
            item.boundingBox?.isBox3
              ? chunkFrustum.intersectsBox(item.boundingBox)
              : chunkFrustum.intersectsSphere(item.boundingSphere)
          )
          : chunkFrustum.intersectsSphere(item.boundingSphere)
      );
      if (!itemInFrustum) {
        this.hideRenderItemCompletely(item, dirtyBatches, context);
        return;
      }
      if (enableOcclusion && checkOcclusion && isChunkOccluded(occlusionState, camera, item)) {
        this.hideRenderItemCompletely(item, dirtyBatches, context);
        return;
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
      const nearConfiguredDistance = resolveRenderableDistance(
        item.nearState?.drawDistance,
        renderingDistance,
      );
      const nearEndDistance = Math.min(nearConfiguredDistance, renderingDistance);
      const lodEndDistance = Math.min(
        resolveRenderableDistance(item.lodState?.drawDistance, renderingDistance),
        renderingDistance,
      );

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
        processRenderItem(item);
      }
      if (enableOcclusion) {
        registerChunkOccluder(occlusionState, camera, chunk);
      }
    }

    for (const item of bigBuildingItems) {
      processRenderItem(item, { checkOcclusion: true });
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
    };
    frameVisibility.computed = true;
    activeFadeCountRef.current = activeFades;
    lodState.needsRefresh = activeFades > 0;
  }
}

export default WorldStreamingRuntime;
