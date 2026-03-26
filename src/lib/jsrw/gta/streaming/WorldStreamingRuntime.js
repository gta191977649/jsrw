import * as THREE from 'three';
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
  createThreeMaterialFromRW,
  getRWMaterialDescriptor,
} from '../../adapters/three/ThreeMaterialAdapter.js';
import { cloneRwMaterialDescriptor as cloneRWMaterialDescriptor } from '../../core/material/RwMaterialDescriptor.js';
import { createRWPipelineMaterialForProfile } from '../../renderer/world/createDefaultPipelineRegistry.js';
import { WORLD_CHUNK_SIZE } from '../../utils/worldUtils.js';

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
    const pipelineMaterial = createRWPipelineMaterialForProfile(
      material.userData?.rwPipelineProfileId,
      {
        descriptor: fadeDescriptor,
        geometry,
      },
    );
    if (pipelineMaterial) return pipelineMaterial;
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

function flushDirtyInstancedBatch(batch) {
  if (!batch?.mesh || !Array.isArray(batch.entries)) return;
  let requiredVisibleCount = 0;
  for (const handle of batch.entries) {
    if (handle?.visible) requiredVisibleCount += 1;
  }
  if (typeof batch.ensureCapacity === 'function') {
    batch.ensureCapacity(requiredVisibleCount);
  }
  const opacityAttribute = batch.mesh.geometry?.getAttribute?.('instanceOpacity') || null;
  let activeIndex = 0;
  batch.activeEntries.length = 0;
  for (const handle of batch.entries) {
    if (!handle?.visible) {
      if (handle) handle.activeIndex = -1;
      continue;
    }
    batch.mesh.setMatrixAt(activeIndex, handle.matrix);
    if (opacityAttribute?.setX) {
      opacityAttribute.setX(activeIndex, Number.isFinite(handle.opacity) ? handle.opacity : 1);
    }
    handle.activeIndex = activeIndex;
    batch.activeEntries.push(handle);
    activeIndex += 1;
  }
  batch.visibleCount = activeIndex;
  batch.mesh.count = activeIndex;
  batch.mesh.visible = activeIndex > 0;
  batch.mesh.userData.rwInstanceEntries = batch.activeEntries;
  batch.mesh.instanceMatrix.needsUpdate = true;
  if (opacityAttribute) opacityAttribute.needsUpdate = true;
  batch.mesh.boundingBox = null;
  batch.mesh.boundingSphere = null;
}

function updateInstancedBatchFadeMode(batch, rwRenderQueueRef) {
  const mesh = batch?.mesh;
  const materials = Array.isArray(mesh?.material) ? mesh.material : [mesh?.material];
  if (!mesh || materials.length === 0) return;
  const hasPartialOpacity = batch.activeEntries.some((handle) => {
    const opacity = Number(handle?.opacity);
    return Number.isFinite(opacity) && opacity > RW_FADE_EPSILON && opacity < (1 - RW_FADE_EPSILON);
  });
  if (batch.hasPartialOpacity === hasPartialOpacity) return;
  batch.hasPartialOpacity = hasPartialOpacity;
  for (const material of materials) {
    if (!material) continue;
    const descriptor = getRWMaterialDescriptor(material);
    const baseState = material.userData?.rwInstancedFadeBase || {
      transparent: Boolean(material.transparent),
      depthWrite: material.depthWrite !== false,
      alphaTest: material.alphaTest ?? 0,
      blending: material.blending,
      descriptorTransparent: Boolean(descriptor?.transparent),
      descriptorDepthWrite: descriptor?.depthWrite !== false,
      descriptorAlphaRef: descriptor?.alphaRef ?? 0,
      descriptorBlending: descriptor?.blending,
      descriptorAlphaMode: descriptor?.alphaMode || 'opaque',
      descriptorRenderBucket: descriptor?.renderBucket || 'opaque',
    };
    material.userData = {
      ...(material.userData || {}),
      rwInstancedFadeBase: baseState,
    };
    if (hasPartialOpacity) {
      material.transparent = true;
      material.depthWrite = false;
      material.alphaTest = 0;
      material.blending = descriptor?.rwFlags?.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
      if (descriptor) {
        descriptor.transparent = true;
        descriptor.depthWrite = false;
        descriptor.alphaRef = 0;
        descriptor.blending = material.blending;
        descriptor.alphaMode = descriptor.rwFlags?.additive ? 'additive' : 'blend';
        descriptor.renderBucket = descriptor.rwFlags?.additive ? 'additive' : 'transparent';
      }
    } else {
      material.transparent = baseState.transparent;
      material.depthWrite = baseState.depthWrite;
      material.alphaTest = baseState.alphaTest;
      material.blending = baseState.blending;
      if (descriptor) {
        descriptor.transparent = baseState.descriptorTransparent;
        descriptor.depthWrite = baseState.descriptorDepthWrite;
        descriptor.alphaRef = baseState.descriptorAlphaRef;
        descriptor.blending = baseState.descriptorBlending;
        descriptor.alphaMode = baseState.descriptorAlphaMode;
        descriptor.renderBucket = baseState.descriptorRenderBucket;
      }
    }
    material.needsUpdate = true;
  }
  rwRenderQueueRef?.current?.markDirty?.();
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

function setInstanceHandlesOpacity(handles, opacity, dirtyBatches) {
  if (!Array.isArray(handles) || handles.length === 0) return;
  const clampedOpacity = clamp01(opacity);
  for (const handle of handles) {
    if (!handle?.batch?.mesh) continue;
    const nextVisible = clampedOpacity > RW_FADE_EPSILON;
    const opacityChanged = Math.abs((Number(handle.opacity) || 0) - clampedOpacity) > RW_FADE_EPSILON;
    const visibilityChanged = handle.visible !== nextVisible;
    if (!opacityChanged && !visibilityChanged) continue;
    handle.opacity = clampedOpacity;
    handle.visible = nextVisible;
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
      originalState: sourceMaterials.map((material) => ({
        transparent: Boolean(material?.transparent),
        opacity: typeof material?.opacity === 'number' ? material.opacity : 1,
        depthWrite: material?.depthWrite !== false,
        alphaTest: material?.alphaTest ?? 0,
        blending: material?.blending,
      })),
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
    binding.fadeMaterials.forEach((material, index) => {
      const originalState = binding.originalState[index] || binding.originalState[0] || null;
      if (!material) return;
      const descriptor = getRWMaterialDescriptor(material);
      if (descriptor) {
        descriptor.opacity = clampedOpacity;
        descriptor.transparent = true;
        descriptor.depthWrite = false;
        descriptor.alphaRef = 0;
        if (descriptor.rwFlags?.additive) {
          descriptor.alphaMode = 'additive';
          descriptor.blending = THREE.AdditiveBlending;
          descriptor.renderBucket = 'additive';
        } else {
          descriptor.alphaMode = 'blend';
          descriptor.blending = THREE.NormalBlending;
          descriptor.renderBucket = 'transparent';
        }
      }
      material.transparent = true;
      material.opacity = clampedOpacity;
      material.depthWrite = false;
      material.alphaTest = 0;
      if ((descriptor?.rwFlags?.additive ?? false) || originalState?.blending === THREE.AdditiveBlending) {
        material.blending = THREE.AdditiveBlending;
      } else {
        material.blending = THREE.NormalBlending;
      }
      if (material.uniforms?.opacity) {
        material.uniforms.opacity.value = clampedOpacity;
      }
      material.needsUpdate = true;
    });
  }
}

function disposeRenderSideObjectFade(sideState) {
  const bindings = Array.isArray(sideState?.fadeBindings) ? sideState.fadeBindings : null;
  if (!bindings) return false;
  for (const binding of bindings) {
    binding.node.material = binding.originalMaterial;
    binding.fadeMaterials.forEach((material, index) => {
      const originalState = binding.originalState[index] || binding.originalState[0] || null;
      if (!material || !originalState) return;
      const descriptor = getRWMaterialDescriptor(material);
      if (descriptor) {
        descriptor.opacity = originalState.opacity;
        descriptor.transparent = originalState.transparent;
        descriptor.depthWrite = originalState.depthWrite;
        descriptor.alphaRef = originalState.alphaTest;
        descriptor.blending = originalState.blending;
        descriptor.alphaMode = originalState.transparent ? 'blend' : 'opaque';
        descriptor.renderBucket = originalState.transparent ? 'transparent' : 'opaque';
      }
      material.transparent = originalState.transparent;
      material.opacity = originalState.opacity;
      material.depthWrite = originalState.depthWrite;
      material.alphaTest = originalState.alphaTest;
      material.blending = originalState.blending;
      if (material.uniforms?.opacity) {
        material.uniforms.opacity.value = originalState.opacity;
      }
      material.needsUpdate = true;
      material.dispose?.();
    });
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

  applyRenderSideOpacity(item, side, opacity, dirtyBatches, context) {
    const sideState = side === 'near' ? item?.nearState : item?.lodState;
    const { rwRenderQueueRef } = context;
    if (!sideState) return false;
    const clampedOpacity = clamp01(opacity);

    if (clampedOpacity <= RW_FADE_EPSILON) {
      if (disposeRenderSideObjectFade(sideState)) rwRenderQueueRef.current?.markDirty?.();
      setRenderSideOriginalVisible(item, side, false, dirtyBatches);
      sideState.currentOpacity = 0;
      return false;
    }

    if (clampedOpacity >= (1 - RW_FADE_EPSILON)) {
      if (disposeRenderSideObjectFade(sideState)) rwRenderQueueRef.current?.markDirty?.();
      setRenderSideOriginalVisible(item, side, true, dirtyBatches);
      sideState.currentOpacity = 1;
      return false;
    }

    if (ensureRenderSideObjectFade(sideState)) {
      sideState.renderObject.visible = true;
      setRenderSideObjectFadeOpacity(sideState, clampedOpacity);
      sideState.currentOpacity = clampedOpacity;
      return false;
    }

    const handles = side === 'near' ? item?.nearHandles : item?.lodHandles;
    if (Array.isArray(handles) && handles.length > 0) {
      setInstanceHandlesOpacity(handles, clampedOpacity, dirtyBatches);
      sideState.currentOpacity = clampedOpacity;
      return false;
    }

    setRenderSideOriginalVisible(item, side, clampedOpacity >= 0.5, dirtyBatches);
    sideState.currentOpacity = clampedOpacity >= 0.5 ? 1 : 0;
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
    const workerPlan = context.workerPlan || null;

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
    const workerCandidateChunks = Array.isArray(workerPlan?.candidateChunkKeys)
      ? workerPlan.candidateChunkKeys
        .map((key) => renderChunkLookupRef.current?.get?.(key) || null)
        .filter(Boolean)
      : null;
    const candidateChunks = workerCandidateChunks || this.collectGroundScanChunks(camera, chunkScanDistance, drawDistance, renderChunkLookupRef);
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
    const processedItems = new Set();
    let activeChunks = 0;
    let frustumChunks = 0;
    let activeItems = 0;
    let visibleNear = 0;
    let visibleLod = 0;
    let activeFades = 0;

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
    };

    for (const chunk of candidateChunks) {
      const chunkInRange = camera.position.distanceToSquared(chunk.center) <= chunkActiveDistSq;
      const bypassCloseRangeChunkFrustum = shouldBypassCloseRangeChunkFrustum(chunk, camera);
      const chunkInFrustum = chunkInRange && (
        workerFrustumChunkKeys
          ? workerFrustumChunkKeys.has(chunk.key)
          : (!enableOcclusion || (
            bypassCloseRangeChunkFrustum || (
              chunk.boundingBox?.isBox3
                ? chunkFrustum.intersectsBox(chunk.boundingBox)
                : chunkFrustum.intersectsSphere(chunk.boundingSphere)
            )
          ))
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
      if (enableOcclusion && workerVisibleChunkKeys && !workerVisibleChunkKeys.has(chunk.key)) {
        if (chunk.active) {
          chunk.active = false;
          for (const item of chunk.items) {
            this.hideRenderItemCompletely(item, dirtyBatches, context);
          }
        }
        continue;
      }
      if (enableOcclusion && !workerVisibleChunkKeys && isChunkOccluded(occlusionState, camera, chunk)) {
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
      updateInstancedBatchFadeMode(batch, rwRenderQueueRef);
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
