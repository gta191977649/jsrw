import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { formatConsoleArg } from '../../../console.js';
import { createDefaultTimecycleState } from '../../core/TimecycleState.js';
import { resetFrameVisibilityResult } from '../core/FrameVisibility.js';
import { resetChunkOcclusionState } from '../core/Occlusion.js';
import { WORLD_UP, gtaPlacementQuaternionToThree, gtaPositionToThree } from '../../utils/gtaTransforms.js';
import { IDE_LIGHT_FLAG, IDE_LIGHT_TYPE } from '../loaders/SectionLoader.js';
import { sampleTimecyc, VCS_WEATHER_NAMES } from '../../utils/Timecycle.js';
import { buildLodMapping, isLodModel } from '../../utils/lod.js';
import { Streaming } from '../../core/Streaming.js';
import { WorldStreamingRuntime } from '../streaming/WorldStreamingRuntime.js';
import { FrameComposer } from '../render/FrameComposer.js';
import {
  applyDisableVertexColor,
  createThreeMaterialFromRW,
  getRWMaterialDescriptor,
  prepareTobjInstanceMaterials,
  toRWMaterial,
  tuneTransparentMaterial,
} from '../../adapters/three/ThreeMaterialAdapter.js';
import {
  applyRwIdeFlagsToInstance,
  decodeRwIdeFlags,
} from '../../adapters/three/RwIdeFlagsAdapter.js';
import { cloneRwMaterialDescriptor as cloneRWMaterialDescriptor } from '../../core/material/RwMaterialDescriptor.js';
import { createJsrwRenderer } from '../../integration/createJsrwRenderer.js';
import { buildTrafficLightCoronaEmitters } from '../../renderer/corona/TrafficLights.js';
import { createCEntity, createEntityRenderSide } from '../world/entities/CEntity.js';
import {
  applyGlobalBackfaceCulling,
  applyWireframe,
  disposeWorld,
  getChunkCenterFromKey,
  getChunkKeyFromPosition,
  makeAssetKey,
  WORLD_CHUNK_SIZE,
} from '../../utils/worldUtils.js';
import {
  applyTimecycleOverrides,
  createRwPipelineTarget,
  map2dfxVisibilityMode,
  mapDffLightKind,
  toPlainVector,
  toThreeColorFromTimecycleValue,
} from './sessionHelpers.js';

const CHUNK_ACTIVE_MARGIN = 384;
const CHUNK_SPHERE_PADDING = WORLD_CHUNK_SIZE * 0.75;
const CHUNK_CULL_MARGIN_XZ = WORLD_CHUNK_SIZE * 1.0;
const CHUNK_CULL_MARGIN_Y = WORLD_CHUNK_SIZE * 1.5;
const BIG_BUILDING_MIN_HEIGHT = WORLD_CHUNK_SIZE * 1.5;
const BIG_BUILDING_MIN_SPAN = WORLD_CHUNK_SIZE * 1.25;
const BIG_BUILDING_MIN_AREA = WORLD_CHUNK_SIZE * WORLD_CHUNK_SIZE * 0.75;
const BIG_BUILDING_MIN_LOD_DISTANCE = 400;
const ENABLE_WORLD_INSTANCING = true;
const FALLBACK_AMBIENT = new THREE.Color(1, 1, 1);
const FALLBACK_EMISSIVE = new THREE.Color(0, 0, 0);
const SMALL_NEAR_ONLY_MIN_CULL_SIZE_XZ = 4.0;
const SMALL_NEAR_ONLY_MIN_CULL_SIZE_Y = 3.0;
const SMALL_NEAR_ONLY_MAX_SPAN = 8.0;

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

function isOpaqueOrCutoutBucket(bucket) {
  return bucket === 'opaque' || bucket === 'cutout';
}

function isDedicatedOpaqueSceneCandidate(root) {
  if (!root?.traverse) return false;
  let hasMesh = false;
  let eligible = true;
  root.traverse((node) => {
    if (!eligible || !node?.isMesh) return;
    hasMesh = true;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      const bucket = getRWMaterialDescriptor(material)?.renderBucket || 'opaque';
      if (!isOpaqueOrCutoutBucket(bucket)) {
        eligible = false;
        break;
      }
    }
  });
  return hasMesh && eligible;
}

function markDedicatedOpaqueSceneObject(object3D) {
  if (!object3D?.isObject3D) return;
  object3D.userData = {
    ...(object3D.userData || {}),
    rwSplitOpaqueScene: true,
  };
}

function hasRenderableObject(object3D, handles) {
  return Boolean(object3D) || (Array.isArray(handles) && handles.length > 0);
}

function classifyBigBuildingItem(item) {
  if (!item) return false;
  const hasNear = item?.hasRenderable?.('near') ?? hasRenderableObject(item.nearObj, item.nearHandles);
  const hasLod = item?.hasRenderable?.('lod') ?? hasRenderableObject(item.lodObj, item.lodHandles);
  const farDistance = Math.max(
    Number.isFinite(item?.getDrawDistance?.('near')) ? item.getDrawDistance('near') : (Number.isFinite(item.nearDrawDistance) ? item.nearDrawDistance : 0),
    Number.isFinite(item?.getDrawDistance?.('lod')) ? item.getDrawDistance('lod') : (Number.isFinite(item.lodDrawDistance) ? item.lodDrawDistance : 0),
  );
  if (item.isTobj) {
    return farDistance >= BIG_BUILDING_MIN_LOD_DISTANCE || hasLod;
  }
  if (!hasLod) return false;
  if (!hasNear) return true;

  const min = item.boundsMin || item.anchor || { x: 0, y: 0, z: 0 };
  const max = item.boundsMax || item.anchor || { x: 0, y: 0, z: 0 };
  const sizeX = Math.max(0, (max.x ?? 0) - (min.x ?? 0));
  const sizeY = Math.max(0, (max.y ?? 0) - (min.y ?? 0));
  const sizeZ = Math.max(0, (max.z ?? 0) - (min.z ?? 0));
  const horizontalSpan = Math.max(sizeX, sizeZ);
  const horizontalArea = sizeX * sizeZ;
  const lodDistance = Number.isFinite(item.lodDrawDistance) ? item.lodDrawDistance : farDistance;

  return (
    sizeY >= BIG_BUILDING_MIN_HEIGHT
    || horizontalSpan >= BIG_BUILDING_MIN_SPAN
    || horizontalArea >= BIG_BUILDING_MIN_AREA
    || lodDistance >= BIG_BUILDING_MIN_LOD_DISTANCE
  );
}

function createRenderMetrics() {
  return {
    activeChunks: 0,
    frustumChunks: 0,
    activeItems: 0,
    visibleNear: 0,
    visibleLod: 0,
    visibleQueueMeshes: 0,
    coronaCandidates: 0,
    shadowCandidates: 0,
    transparentQueue: 0,
    additiveQueue: 0,
    overlayQueue: 0,
    drawCalls: 0,
    triangles: 0,
    worldDrawCalls: 0,
    worldTriangles: 0,
    waterDrawCalls: 0,
    waterTriangles: 0,
    skyDrawCalls: 0,
    skyTriangles: 0,
    skyCloudsPassInvoked: false,
    skyCloudsPassDrawCalls: 0,
    skyCloudsPassTriangles: 0,
    streamingCpuMs: 0,
    streamingChunkScanMs: 0,
    streamingVisibilityMs: 0,
    streamingBigBuildingMs: 0,
    streamingOpacityMs: 0,
    streamingFrameVisibilityMs: 0,
    streamingFlushMs: 0,
    renderQueuePrepareMs: 0,
    worldOpaqueCpuMs: 0,
    worldTransparentCpuMs: 0,
    coronaUpdateCpuMs: 0,
    shadowUpdateCpuMs: 0,
    frameComposerCpuMs: 0,
    frameSkyDomeCpuMs: 0,
    frameSkyBackdropCpuMs: 0,
    frameSkyCloudsCpuMs: 0,
    frameWaterUpdateCpuMs: 0,
    frameWaterFarCpuMs: 0,
    frameWaterNearCpuMs: 0,
    frameWaterWavyCpuMs: 0,
    frameWaterWakeCpuMs: 0,
    frameShadowRenderCpuMs: 0,
    frameCoronaRenderCpuMs: 0,
    framePostFxCpuMs: 0,
    frameSunBloomCpuMs: 0,
    frameSunFinalCpuMs: 0,
    frameHudCpuMs: 0,
  };
}

function hasFiniteVector3(vector) {
  return Number.isFinite(vector?.x) && Number.isFinite(vector?.y) && Number.isFinite(vector?.z);
}

function expandBoundsWithObject(boundsBox, object3D) {
  if (!boundsBox || !object3D) return;
  const objectBounds = new THREE.Box3().setFromObject(object3D);
  if (objectBounds.isEmpty()) return;
  boundsBox.union(objectBounds);
}

function expandBoundsWithHandles(boundsBox, handles = []) {
  if (!boundsBox || !Array.isArray(handles) || handles.length === 0) return;
  const point = new THREE.Vector3();
  const transformedBounds = new THREE.Box3();
  for (const handle of handles) {
    if (!handle?.matrix) continue;
    if (handle.localBounds?.isBox3 && !handle.localBounds.isEmpty()) {
      transformedBounds.copy(handle.localBounds).applyMatrix4(handle.matrix);
      boundsBox.union(transformedBounds);
      continue;
    }
    point.setFromMatrixPosition(handle.matrix);
    boundsBox.expandByPoint(point);
  }
}

function stabilizeSmallNearOnlyBounds(boundsBox, item) {
  if (!boundsBox?.isBox3 || boundsBox.isEmpty() || !item) return;
  const hasNear = hasRenderableObject(item.nearObj, item.nearHandles);
  const hasLod = hasRenderableObject(item.lodObj, item.lodHandles);
  if (!hasNear || hasLod) return;

  const size = boundsBox.getSize(new THREE.Vector3());
  const horizontalSpan = Math.max(size.x, size.z);
  if (horizontalSpan > SMALL_NEAR_ONLY_MAX_SPAN) return;

  const stabilizedX = Math.max(size.x, SMALL_NEAR_ONLY_MIN_CULL_SIZE_XZ);
  const stabilizedY = Math.max(size.y, SMALL_NEAR_ONLY_MIN_CULL_SIZE_Y);
  const stabilizedZ = Math.max(size.z, SMALL_NEAR_ONLY_MIN_CULL_SIZE_XZ);
  if (stabilizedX === size.x && stabilizedY === size.y && stabilizedZ === size.z) return;

  const center = boundsBox.getCenter(new THREE.Vector3());
  boundsBox.setFromCenterAndSize(center, new THREE.Vector3(stabilizedX, stabilizedY, stabilizedZ));
}

function resolveTextureFromDictionaryEntry(entry) {
  if (!entry) return null;
  if (entry.isTexture) return entry;
  if (entry.texture?.isTexture) return entry.texture;
  return null;
}

function resolveParticleTexture(dictionary, names = []) {
  if (!dictionary?.get || !Array.isArray(names)) return null;
  for (const name of names) {
    const texture = resolveTextureFromDictionaryEntry(dictionary.get(name));
    if (texture) return texture;
  }
  return null;
}

function normalizeModelLookupName(value = '') {
  const normalized = String(value || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .split('/')
    .pop()
    ?.toLowerCase() || '';
  const extensionIndex = normalized.lastIndexOf('.');
  return extensionIndex >= 0 ? normalized.slice(0, extensionIndex) : normalized;
}

export class JsrwGtaSession {
  constructor(options = {}) {
    this.rendererSession = options.rendererSession || createJsrwRenderer(options);
    this.streamingRuntime = new WorldStreamingRuntime({ rendererSession: this.rendererSession });
    this.frameComposer = new FrameComposer({ rendererSession: this.rendererSession });
  }

  getRendererSession() {
    return this.rendererSession;
  }

  ensureRenderQueue(root) {
    this.rendererSession.setRoot(root);
    return this.rendererSession.getRenderQueue() || this.rendererSession.createRenderQueue(root);
  }

  sampleTimecycle({ timecycleDataRef, timecycleStateRef }) {
    const parsedTimecycle = timecycleDataRef?.current || null;
    const timecycleInfo = timecycleStateRef?.current || null;
    if (!timecycleInfo) return null;
    if (parsedTimecycle) {
      timecycleInfo.current = applyTimecycleOverrides(
        sampleTimecyc(parsedTimecycle, timecycleInfo.controls),
        timecycleInfo.controls?.overrides,
      );
    } else {
      timecycleInfo.current = null;
    }
    return timecycleInfo.current;
  }

  updateStreaming(context = {}) {
    return this.streamingRuntime.update(context);
  }

  renderFrame(context = {}) {
    return this.frameComposer.render(context);
  }

  clearWorld(context = {}) {
    const {
      selectedInstanceHighlightRef,
      selectedObjectRootRef,
      selectedObjectRef,
      selectedTextureDetailRef,
      timecycleDataRef,
      timecycleStateRef,
      renderItemsRef,
      bigBuildingItemsRef,
      renderChunksRef,
      renderChunkLookupRef,
      activeRenderChunksRef,
      frameVisibilityRef,
      chunkOcclusionStateRef,
      worldGameVersionRef,
      lastPipelineSelectionSignatureRef,
      activeFadeCountRef,
      renderMetricsRef,
      rwRenderQueueRef,
      lodUpdateStateRef,
      renderResourcesReadyRef,
      worldRootRef,
      worldOpaqueRootRef,
      uiStateRef,
      activeBackend,
      resetImguiTextureCache,
      clearObjectSelectionHighlight,
      setSelectedObject,
      setSelectedTextureDetail,
      setShowGameIcon,
      setBuildProgress,
      setStats,
      setFailedModels,
      pushConsoleLine,
    } = context;

    if (selectedInstanceHighlightRef?.current?.parent) {
      selectedInstanceHighlightRef.current.parent.remove(selectedInstanceHighlightRef.current);
    }
    if (selectedInstanceHighlightRef) selectedInstanceHighlightRef.current = null;
    if (selectedObjectRootRef?.current) {
      clearObjectSelectionHighlight?.(selectedObjectRootRef.current);
      selectedObjectRootRef.current = null;
    }
    if (selectedObjectRef) selectedObjectRef.current = null;
    setSelectedObject?.(null);
    if (selectedTextureDetailRef) selectedTextureDetailRef.current = null;
    setSelectedTextureDetail?.(null);
    resetImguiTextureCache?.();

    const worldRoot = worldRootRef?.current;
    const worldOpaqueRoot = worldOpaqueRootRef?.current;
    if (worldRoot) {
      disposeWorld(worldRoot);
    }
    if (worldOpaqueRoot) {
      disposeWorld(worldOpaqueRoot);
    }
    this.rendererSession.disposeWaterRuntime();
    this.rendererSession.disposeCoronaRuntime();
    this.rendererSession.disposeShadowRuntime();

    if (timecycleDataRef) timecycleDataRef.current = null;
    if (timecycleStateRef) timecycleStateRef.current = createDefaultTimecycleState();
    if (renderItemsRef) renderItemsRef.current = [];
    if (bigBuildingItemsRef) bigBuildingItemsRef.current = [];
    if (renderChunksRef) renderChunksRef.current = [];
    if (renderChunkLookupRef) renderChunkLookupRef.current = new Map();
    if (activeRenderChunksRef) activeRenderChunksRef.current = new Set();
    if (frameVisibilityRef) resetFrameVisibilityResult(frameVisibilityRef.current);
    if (chunkOcclusionStateRef) resetChunkOcclusionState(chunkOcclusionStateRef.current);
    if (worldGameVersionRef) {
      worldGameVersionRef.current = String(uiStateRef?.current?.gameVersion || 'VCS').toUpperCase();
    }

    const traversalRoots = [worldRoot, worldOpaqueRoot].filter((root) => root?.isObject3D);
    if (worldRoot) {
      this.rendererSession.setBackend(activeBackend || 'WebGL');
      this.rendererSession.setRoot(worldRoot, { traversalRoots });
      this.rendererSession.applyToRoot(worldRoot, {
        activeBackend: activeBackend || 'WebGL',
        worldGameVersion: worldGameVersionRef?.current || 'VCS',
        fallbackAmbient: FALLBACK_AMBIENT,
        fallbackEmissive: FALLBACK_EMISSIVE,
      });
      if (worldOpaqueRoot) {
        this.rendererSession.applyToRoot(worldOpaqueRoot, {
          activeBackend: activeBackend || 'WebGL',
          worldGameVersion: worldGameVersionRef?.current || 'VCS',
          fallbackAmbient: FALLBACK_AMBIENT,
          fallbackEmissive: FALLBACK_EMISSIVE,
        });
        this.rendererSession.setRoot(worldRoot, { traversalRoots });
      }
    }

    if (lastPipelineSelectionSignatureRef) lastPipelineSelectionSignatureRef.current = '';
    if (activeFadeCountRef) activeFadeCountRef.current = 0;
    if (renderMetricsRef) renderMetricsRef.current = createRenderMetrics();
    rwRenderQueueRef?.current?.markDirty?.();
    if (lodUpdateStateRef?.current) {
      lodUpdateStateRef.current.needsRefresh = true;
      lodUpdateStateRef.current.lastCameraPos.set(Number.NaN, Number.NaN, Number.NaN);
      lodUpdateStateRef.current.lastCameraQuat.set(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
      lodUpdateStateRef.current.lastCameraAspect = Number.NaN;
      lodUpdateStateRef.current.lastCameraFov = Number.NaN;
      lodUpdateStateRef.current.lastCameraNear = Number.NaN;
      lodUpdateStateRef.current.lastCameraFar = Number.NaN;
      lodUpdateStateRef.current.chunkScanCache = null;
    }
    setShowGameIcon?.(false);
    if (renderResourcesReadyRef) renderResourcesReadyRef.current = false;
    setBuildProgress?.({ active: false, current: 0, total: 0 });
    setStats?.((prev) => ({
      ...prev,
      loaded: 0,
      failed: 0,
      unresolved: 0,
      ideEffects: 0,
      nearOnly: 0,
      totalChunks: 0,
      instancedBatches: 0,
      instancedItems: 0,
      lightObjects: 0,
      lightEmitters: 0,
      queuedChunks: 0,
      readyChunks: 0,
    }));
    setFailedModels?.([]);
    pushConsoleLine?.('info', 'World cleared');
  }

  async buildWorld(context = {}) {
    const {
      fileIndexRef,
      activeBackend,
      buildTokenRef,
      buildActiveRef,
      renderResourcesReadyRef,
      uiStateRef,
      worldGameVersionRef,
      timecycleDataRef,
      timecycleStateRef,
      totalObjectsRef,
      cameraRef,
      worldRootRef,
      worldOpaqueRootRef,
      renderItemsRef,
      bigBuildingItemsRef,
      renderChunksRef,
      renderChunkLookupRef,
      activeRenderChunksRef,
      rwRenderQueueRef,
      lastPipelineSelectionSignatureRef,
      lodUpdateStateRef,
      setLoadedFiles,
      setFailedModels,
      setShowGameIcon,
      setStatus,
      setStats,
      setBuildProgress,
      pushConsoleLine,
      pushLoadedFile,
      pushLoadedFileConsoleEvent,
      onParticleTexturesResolved,
      pushFailedModel,
      clearWorld,
      yieldToBrowser,
      yieldToNextTask,
    } = context;

    const fileIndex = fileIndexRef?.current || null;
    if (!fileIndex) {
      setStatus?.('No files loaded. Choose a folder or zip archive first.');
      pushConsoleLine?.('warn', 'Build requested without loaded files');
      return;
    }

    const worldRoot = worldRootRef?.current;
    const worldOpaqueRoot = worldOpaqueRootRef?.current;
    const token = ++buildTokenRef.current;
    const buildGameVersion = String(uiStateRef?.current?.gameVersion || 'VCS').toUpperCase();
    buildActiveRef.current = true;
    renderResourcesReadyRef.current = false;

    try {
      clearWorld?.();
      worldGameVersionRef.current = buildGameVersion;
      setLoadedFiles?.([]);
      setFailedModels?.([]);
      setShowGameIcon?.(false);
      setStatus?.('Parsing gta.dat, IDE and IPL...');
      pushConsoleLine?.('info', 'Start building world');
      await yieldToBrowser?.();

      let worldLoadResult;
      try {
        const streaming = new Streaming({
          gameVersion: uiStateRef.current.gameVersion,
          onLog: (level, message) => pushConsoleLine?.(level, message),
          onFileEvent: (kind, path, detail) => {
            pushLoadedFile?.(kind, path, detail);
            pushLoadedFileConsoleEvent?.(kind, path, detail);
          },
        });
        worldLoadResult = await streaming.loadWorld(fileIndex, {
          extraImgPaths: ['models/gta3.img'],
        });
      } catch (error) {
        setStatus?.('gta.dat not found in uploaded files.');
        pushConsoleLine?.('error', formatConsoleArg(error));
        return;
      }

      const worldContext = worldLoadResult.context;
      const worldBuild = worldLoadResult.build;
      const worldLoadStats = worldLoadResult.stats;
      const defaultResources = worldLoadStats.defaultResources || worldContext.defaultResources || null;
      const ideById = worldContext.ideRegistry?.byId || new Map();
      const ideByModel = worldContext.ideRegistry?.byModel || new Map();
      const placements = worldBuild.world?.placements || worldContext.iplRegistry?.getAll?.() || [];

      if (defaultResources) {
        pushConsoleLine?.(
          'info',
          `Static defaults: IMG ${defaultResources.counts.imgMounted}/${defaultResources.counts.imgRequested}, TXD ${defaultResources.counts.textureFound}/${defaultResources.counts.textureRequested}, COL ${defaultResources.counts.collisionFound}`,
        );
      }

      const previousControls = timecycleStateRef.current?.controls || {};
      const parsedTimecycle = worldBuild.weather?.data || null;
      const weatherNames = worldBuild.weather?.weatherNames || [...VCS_WEATHER_NAMES];
      if (parsedTimecycle) {
        const controls = {
          hour: Number.isFinite(previousControls.hour) ? previousControls.hour : 12,
          minute: Number.isFinite(previousControls.minute) ? previousControls.minute : 0,
          weatherA: Number.isFinite(previousControls.weatherA) ? previousControls.weatherA : 0,
          weatherB: Number.isFinite(previousControls.weatherB) ? previousControls.weatherB : 0,
          weatherBlend: Number.isFinite(previousControls.weatherBlend) ? previousControls.weatherBlend : 0,
          extraColour: Number.isFinite(previousControls.extraColour) ? previousControls.extraColour : -1,
          overrides: previousControls.overrides && typeof previousControls.overrides === 'object'
            ? { ...previousControls.overrides }
            : {},
        };
        controls.weatherA = Math.min(Math.max(controls.weatherA, 0), weatherNames.length - 1);
        controls.weatherB = Math.min(Math.max(controls.weatherB, 0), weatherNames.length - 1);
        const current = applyTimecycleOverrides(sampleTimecyc(parsedTimecycle, controls), controls.overrides);
        timecycleDataRef.current = parsedTimecycle;
        timecycleStateRef.current = {
          sourcePath: worldBuild.weather?.sourcePath || '',
          data: parsedTimecycle,
          current,
          weatherNames,
          controls,
        };
        pushConsoleLine?.(
          'info',
          `timecyc.dat loaded: ${parsedTimecycle.hours} hours x ${weatherNames.length} weathers (${worldBuild.weather?.sourcePath || 'unknown'})`,
        );
      } else {
        timecycleDataRef.current = null;
        timecycleStateRef.current = createDefaultTimecycleState();
      }

      totalObjectsRef.current = placements.length;

      setStats?.({
        files: fileIndex.count,
        ideFiles: worldLoadStats.ideFiles,
        iplFiles: worldLoadStats.iplFiles,
        ideDefs: ideByModel.size,
        ideEffects: worldLoadStats.ideEffects || 0,
        iplInst: placements.length,
        defaultResources,
        loaded: 0,
        failed: 0,
        unresolved: 0,
        nearOnly: 0,
        totalChunks: 0,
        instancedBatches: 0,
        instancedItems: 0,
        lightObjects: 0,
        lightEmitters: 0,
      });

      const modelCache = new Map();
      let pendingWaterPipeline = null;
      let particleTextureDictionary = null;
      let loaded = 0;
      let failed = 0;
      let unresolved = 0;
      const effectivePlacements = placements;

      setStatus?.(`Loading ${effectivePlacements.length} placements...`);
      await yieldToNextTask?.();
      await yieldToBrowser?.();

      const getTextureDict = async (txdName) => {
        if (!txdName) return null;
        try {
          return await worldContext.textureResolver.resolveTextureDictionary(txdName);
        } catch {
          pushConsoleLine?.('error', `TXD parse failed: ${txdName}.txd`);
          return null;
        }
      };

      const tryBuildWater = async () => {
        const waterConfig = worldBuild.water?.config || null;
        if (!waterConfig || waterConfig.source !== 'waterpro') return;
        const parsed = worldBuild.water?.data || null;
        if (!parsed) return;

        this.rendererSession.setBackend(activeBackend);
        pendingWaterPipeline = this.rendererSession.createWaterRuntime({
          parsed,
          waterConfig,
          texture: null,
          toThreePosition: (x, y, z) => gtaPositionToThree(x, y, z),
          writeThreePosition: (target, offset, x, y, z) => {
            target[offset + 0] = -x;
            target[offset + 1] = z;
            target[offset + 2] = y;
          },
          toGamePosition: (position) => ({
            x: -position.x,
            y: position.z,
            z: position.y,
          }),
          wireframe: uiStateRef.current.wireframe,
          enabled: uiStateRef.current.renderWater,
          settings: {
            uvSpeed: uiStateRef.current.waterUvSpeed,
            waveHeight: uiStateRef.current.waterWaveHeight,
            farAlpha: uiStateRef.current.waterAlpha,
          },
        });
        pendingWaterPipeline.setTimecycleProvider(() => {
          const current = timecycleStateRef.current?.current;
          if (!current) return null;
          const fogNear = Math.max(
            cameraRef.current?.near ?? 0.1,
            Math.min(current.values.fogStart, current.values.farClip - 1),
          );
          const fogFar = Math.max(fogNear + 1, current.values.farClip);
          const waterAlpha = THREE.MathUtils.clamp(
            (Number(current.values?.water?.a) || 0) / 255,
            0,
            1,
          );
          return {
            color: current.three?.waterColor || null,
            farAlpha: waterAlpha,
            fogColor: current.three?.fogColor || null,
            fogNear,
            fogFar,
          };
        });
      };

      await tryBuildWater();

      const getModelTemplate = async (modelName, txdName) => {
        const normalizedModelName = normalizeModelLookupName(modelName);
        const normalizedTxdName = normalizeModelLookupName(txdName);
        const key = makeAssetKey(normalizedModelName, normalizedTxdName);
        if (modelCache.has(key)) return modelCache.get(key);

        const pending = (async () => {
          const resolvedModel = await worldContext.modelResolver.resolve(normalizedModelName, normalizedTxdName);
          if (!resolvedModel?.template) {
            pushConsoleLine?.('error', `DFF missing: ${normalizedModelName}.dff (file + IMG)`);
            throw new Error(`Missing DFF: ${normalizedModelName}.dff`);
          }

          const txd = resolvedModel.textureDictionary || null;
          const template = resolvedModel.template;
          const usedTextureEntries = new Map();
          const registerTexture = (textureName, texture) => {
            const name = String(textureName || '').trim().toLowerCase();
            if (!name) return;
            const existing = usedTextureEntries.get(name);
            if (!existing) {
              usedTextureEntries.set(name, { name, texture: texture || null });
            } else if (!existing.texture && texture) {
              existing.texture = texture;
            }
          };
          template.traverse((node) => {
            if (!node.isMesh) return;
            const sourceMats = Array.isArray(node.material) ? node.material : [node.material];
            for (const mat of sourceMats) {
              registerTexture(mat.map?.name, mat.map);
              registerTexture(mat.alphaMap?.name, mat.alphaMap);
              registerTexture(mat.userData?.textureName, mat.map);
            }
            const rwMats = sourceMats.map((mat) => {
              tuneTransparentMaterial(mat);
              return toRWMaterial(mat, node.geometry);
            });
            node.material = Array.isArray(node.material) ? rwMats : rwMats[0];
          });
          template.updateMatrixWorld(true);
          const meshNodes = [];
          template.traverse((node) => {
            if (!node.isMesh) return;
            meshNodes.push(node);
          });
          const instancable = meshNodes.length > 0 && meshNodes.every((node) => !node.isSkinnedMesh);
          const meshDescriptors = instancable
            ? meshNodes.map((node) => ({
              geometry: node.geometry,
              material: node.material,
              localMatrix: node.matrixWorld.clone(),
            }))
            : [];
          const dffLights = Array.isArray(template.userData?.rwDffLights) ? template.userData.rwDffLights : [];
          if (txd && typeof txd.keys === 'function') {
            for (const entry of usedTextureEntries.values()) {
              if (entry.texture) continue;
              const txdTexture = txd.get(entry.name);
              if (txdTexture) {
                entry.texture = txdTexture.texture || txdTexture;
              }
            }
          }
          return {
            key,
            modelName: normalizedModelName,
            txdName: normalizedTxdName,
            template,
            usedTextureEntries: Array.from(usedTextureEntries.values()).sort((a, b) => a.name.localeCompare(b.name)),
            dffLights,
            instancable,
            meshDescriptors,
          };
        })();

        modelCache.set(key, pending);
        return pending;
      };

      const { mapping: lodMapping, usedLodIndices } = buildLodMapping(effectivePlacements, uiStateRef.current.gameVersion);
      const nonLodIndices = [];
      for (let index = 0; index < effectivePlacements.length; index += 1) {
        if (!isLodModel(effectivePlacements[index].modelName)) nonLodIndices.push(index);
      }
      const standaloneLodIndices = [];
      for (let index = 0; index < effectivePlacements.length; index += 1) {
        if (!isLodModel(effectivePlacements[index].modelName)) continue;
        if (usedLodIndices.has(index)) continue;
        standaloneLodIndices.push(index);
      }
      const placementAnchors = effectivePlacements.map((placement) => gtaPositionToThree(
        placement.position.x,
        placement.position.y,
        placement.position.z,
      ));

      const renderItems = [];
      const bigBuildingItems = [];
      const renderChunkMap = new Map();
      const instancedBatchMap = new Map();
      const coronaEmitters = [];
      const registeredCoronaPlacements = new Set();
      const placementsWithLights = new Set();
      let instancedItems = 0;

      const attachChunkOpaqueGroup = (chunk) => {
        if (!worldOpaqueRoot || !chunk?.opaqueGroup || chunk.opaqueGroup.parent) return;
        worldOpaqueRoot.add(chunk.opaqueGroup);
      };

      const getRenderChunk = (anchor) => {
        const chunkKey = getChunkKeyFromPosition(anchor);
        if (renderChunkMap.has(chunkKey)) return renderChunkMap.get(chunkKey);
        const chunk = {
          key: chunkKey,
          cx: Math.floor(anchor.x / WORLD_CHUNK_SIZE),
          cz: Math.floor(anchor.z / WORLD_CHUNK_SIZE),
          center: getChunkCenterFromKey(chunkKey),
          group: new THREE.Group(),
          opaqueGroup: new THREE.Group(),
          items: [],
          coronaEmitters: [],
          shadowEmitters: [],
          active: false,
          boundsMin: new THREE.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
          boundsMax: new THREE.Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY),
          occlusionBox: new THREE.Box3(),
          occlusionSphere: new THREE.Sphere(),
          boundingBox: new THREE.Box3(),
          boundingSphere: new THREE.Sphere(),
        };
        chunk.group.visible = false;
        chunk.group.matrixAutoUpdate = false;
        chunk.group.matrixWorldAutoUpdate = false;
        chunk.opaqueGroup.visible = false;
        chunk.opaqueGroup.matrixAutoUpdate = false;
        chunk.opaqueGroup.matrixWorldAutoUpdate = false;
        chunk.group.userData = {
          ...(chunk.group.userData || {}),
          rwWorldChunk: true,
          rwWorldChunkKey: chunkKey,
        };
        chunk.opaqueGroup.userData = {
          ...(chunk.opaqueGroup.userData || {}),
          rwWorldChunk: true,
          rwWorldChunkKey: chunkKey,
          rwSplitOpaqueSceneChunk: true,
        };
        worldRoot.add(chunk.group);
        renderChunkMap.set(chunkKey, chunk);
        return chunk;
      };

      const registerChunkEmitter = (emitter) => {
        if (!emitter?.position) return;
        const chunk = getRenderChunk(emitter.position);
        emitter.chunkKey = chunk.key;
        chunk.coronaEmitters.push(emitter);
        if (Number(emitter.shadow?.size) > 0) {
          chunk.shadowEmitters.push(emitter);
        }
      };

      const buildPlacementWorldMatrix = (placement, anchor) => {
        const placementQuaternion = gtaPlacementQuaternionToThree(
          placement.rotation.x,
          placement.rotation.y,
          placement.rotation.z,
          placement.rotation.w,
          uiStateRef.current.quaternionOrder,
        );
        return new THREE.Matrix4().compose(
          anchor,
          placementQuaternion,
          new THREE.Vector3(1, 1, 1),
        );
      };

      const buildObjectDetail = (ide, placement, lodKind, model) => {
        const ideEffects = Array.isArray(ide.effects) ? ide.effects : [];
        const dffLights = Array.isArray(model.dffLights) ? model.dffLights : [];
        return {
          id: ide.id,
          placementId: placement.id,
          modelName: ide.modelName,
          txdName: ide.txdName,
          flags: ide.flags | 0,
          activeFlagNames: decodeRwIdeFlags(ide.flags).activeFlags,
          section: ide.section,
          drawDistance: ide.drawDistance,
          lodKind,
          position: {
            x: placement.position.x,
            y: placement.position.y,
            z: placement.position.z,
          },
          rotation: {
            x: placement.rotation.x,
            y: placement.rotation.y,
            z: placement.rotation.z,
            w: placement.rotation.w,
          },
          usedTextureEntries: model.usedTextureEntries || [],
          ideEffects,
          dffLights,
          hasLighting:
            ideEffects.some((e) => e.kind === 'light') || (dffLights?.length ?? 0) > 0,
        };
      };

      const buildCoronaEmittersForPlacement = (placement, placementIndex, worldMatrix, ide, model) => {
        const emitters = [];
        const directionMatrix = new THREE.Matrix3().setFromMatrix4(worldMatrix);
        const baseId = `${placement.sourcePath || 'ipl'}:${placementIndex}:${placement.modelName}`;
        const effectLights = Array.isArray(ide?.effects)
          ? ide.effects.filter((e) => e.kind === 'light')
          : [];
        const trafficLightEmitters = buildTrafficLightCoronaEmitters({
          effectLights,
          placement,
          placementIndex,
          worldMatrix,
          baseId,
          toWorldPosition: (position, matrix) => {
            const localPosition = gtaPositionToThree(
              Number(position?.x) || 0,
              Number(position?.y) || 0,
              Number(position?.z) || 0,
            );
            return toPlainVector(localPosition.applyMatrix4(matrix));
          },
          toWorldDirection: (direction, matrix) => {
            const localDirection = gtaPositionToThree(
              Number(direction?.x) || 0,
              Number(direction?.y) || 0,
              Number(direction?.z) || 0,
            ).normalize();
            return toPlainVector(localDirection.applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix)).normalize());
          },
        });
        if (trafficLightEmitters.length > 0) {
          emitters.push(...trafficLightEmitters);
        } else {
          effectLights.forEach((effect) => {
            const effectColor = effect.color || { r: 255, g: 255, b: 255, a: 255 };
            const localPosition = gtaPositionToThree(
              Number(effect.position?.x) || 0,
              Number(effect.position?.y) || 0,
              Number(effect.position?.z) || 0,
            );
            const worldPosition = localPosition.applyMatrix4(worldMatrix);
            emitters.push({
              id: `2dfx:${baseId}:${effect.effectIndex ?? 0}`,
              sourceType: '2dfx',
              modelName: placement.modelName,
              placementIndex,
              position: toPlainVector(worldPosition),
              color: { ...effectColor, a: 255 },
              alpha: 255,
              size: Number(effect.size) || 1,
              drawDistance: Number(effect.distance) || 0,
              textureKey: effect.coronaTextureName || 'corona',
              flareType: Number(effect.flare) || 0,
              reflection: Number(effect.roadReflection ?? effect.wet) || 0,
              losCheck: Boolean((effect.flags | 0) & IDE_LIGHT_FLAG.LOS_CHECK),
              longDistance: Boolean((effect.flags | 0) & IDE_LIGHT_FLAG.LONG_DISTANCE),
              visibilityMode: map2dfxVisibilityMode(effect.flash, IDE_LIGHT_TYPE),
              fogType: (effect.flags | 0) & IDE_LIGHT_FLAG.FOG_TYPE_MASK,
              hideObject: Boolean((effect.flags | 0) & IDE_LIGHT_FLAG.HIDE_OBJECT),
              shadow: {
                textureKey: effect.shadowTextureName || '',
                alpha: 128,
                size: Number(effect.shadowSize ?? effect.innerRange) || 0,
                intensity: Number(effect.shadowIntensity) || 0,
                front: toPlainVector(gtaPositionToThree(Number(effect.shadowSize ?? effect.innerRange) || 0, 0, 0)),
                side: toPlainVector(gtaPositionToThree(0, -(Number(effect.shadowSize ?? effect.innerRange) || 0), 0)),
                zDistance: 15,
                drawDistance: 40,
              },
            });
          });
        }

        const dffLights = Array.isArray(model?.dffLights) ? model.dffLights : [];
        dffLights.forEach((light) => {
          const lightKind = mapDffLightKind(light.lightType);
          if (!lightKind) return;
          const worldPosition = new THREE.Vector3(
            ...(Array.isArray(light.localPosition) ? light.localPosition : [0, 0, 0]),
          ).applyMatrix4(worldMatrix);
          const worldDirection = new THREE.Vector3(
            ...(Array.isArray(light.localDirection) ? light.localDirection : [0, 0, -1]),
          ).applyMatrix3(directionMatrix)
            .normalize();
          const normalizedColor = {
            r: Math.round(Math.max(0, Math.min(1, Number(light.color?.r) || 0)) * 255),
            g: Math.round(Math.max(0, Math.min(1, Number(light.color?.g) || 0)) * 255),
            b: Math.round(Math.max(0, Math.min(1, Number(light.color?.b) || 0)) * 255),
            a: 255,
          };
          emitters.push({
            id: `dfflight:${baseId}:${light.lightIndex ?? 0}`,
            sourceType: 'dffLight',
            modelName: placement.modelName,
            placementIndex,
            position: toPlainVector(worldPosition),
            direction: toPlainVector(worldDirection),
            color: normalizedColor,
            drawDistance: Math.max(120, (Number(light.radius) || 0) * 12),
            light: {
              kind: lightKind,
              range: Number(light.radius) || 0,
              intensity: 1.25,
            },
          });
        });

        return emitters;
      };

      const maybeRegisterPlacementEmitters = (placement, placementIndex, worldMatrix, ide, model, lodKind) => {
        if (lodKind === 'lod') return;
        if (registeredCoronaPlacements.has(placementIndex)) return;
        registeredCoronaPlacements.add(placementIndex);
        const emitters = buildCoronaEmittersForPlacement(placement, placementIndex, worldMatrix, ide, model);
        if (emitters.length > 0) {
          placementsWithLights.add(placementIndex);
          emitters.forEach((emitter) => registerChunkEmitter(emitter));
          coronaEmitters.push(...emitters);
        }
      };

      const canUseInstancing = (model, ide) => {
        if (!ENABLE_WORLD_INSTANCING) return false;
        if (!model?.instancable || !Array.isArray(model.meshDescriptors) || model.meshDescriptors.length === 0) return false;
        if (ide?.section === 'tobjs') return false;
        // Small props are more correctness-sensitive than performance-sensitive here;
        // keep them on the regular object path to avoid instanced-only visibility issues.
        if (Number.isFinite(ide?.drawDistance) && ide.drawDistance <= 250) return false;
        const decoded = decodeRwIdeFlags(ide?.flags);
        if (decoded.drawLast || decoded.additive || decoded.noZWrite) return false;
        return model.meshDescriptors.every((descriptor) => {
          if (!descriptor?.geometry || !descriptor?.material || Array.isArray(descriptor.material)) return false;
          const rwMaterial = getRWMaterialDescriptor(descriptor.material);
          if (!rwMaterial) return false;
          return rwMaterial.renderBucket === 'opaque' || rwMaterial.renderBucket === 'cutout';
        });
      };

      const ensureInstancedBatch = (chunk, model, lodKind, ide, descriptorIndex, descriptor) => {
        const batchKey = `${chunk.key}|${model.key}|${lodKind}|${descriptorIndex}|${ide.flags | 0}`;
        if (instancedBatchMap.has(batchKey)) return instancedBatchMap.get(batchKey);
        const rwMaterial = getRWMaterialDescriptor(descriptor.material);
        const material = createThreeMaterialFromRW(cloneRWMaterialDescriptor(rwMaterial), descriptor.geometry);
        const mesh = new THREE.InstancedMesh(descriptor.geometry, material, 4);
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.matrixWorldAutoUpdate = false;
        mesh.visible = true;
        mesh.userData = {
          ...(mesh.userData || {}),
          rwPipelineTarget: createRwPipelineTarget(buildGameVersion, ide.section === 'tobjs'),
          isTobj: ide.section === 'tobjs',
          rwQueueRenderClass: 'building',
          rwWorldChunkKey: chunk.key,
          rwSplitOpaqueScene: Boolean(worldOpaqueRoot),
        };
        applyRwIdeFlagsToInstance(mesh, ide.flags);
        if (worldOpaqueRoot) {
          attachChunkOpaqueGroup(chunk);
          chunk.opaqueGroup.add(mesh);
        } else {
          chunk.group.add(mesh);
        }
        this.rendererSession?.applyToObject(mesh, {
          activeBackend,
          worldGameVersion: buildGameVersion,
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
        rwRenderQueueRef.current?.markDirty?.();
        const batch = {
          key: batchKey,
          mesh,
          entries: [],
          visibleCount: 0,
          activeEntries: [],
          dirtyHandles: [],
        };
        instancedBatchMap.set(batchKey, batch);
        return batch;
      };

      const ensureInstancedBatchCapacity = (batch, requiredCount) => {
        const mesh = batch?.mesh;
        if (!mesh?.isInstancedMesh) return;
        const currentCapacity = Math.floor((mesh.instanceMatrix?.array?.length || 0) / 16);
        if (requiredCount <= currentCapacity) return;

        const nextCapacity = Math.max(requiredCount, Math.max(4, currentCapacity * 2));
        const nextArray = new Float32Array(nextCapacity * 16);
        if (mesh.instanceMatrix?.array) {
          nextArray.set(mesh.instanceMatrix.array.subarray(0, currentCapacity * 16));
        }
        const nextMatrix = new THREE.InstancedBufferAttribute(nextArray, 16);
        nextMatrix.setUsage(THREE.DynamicDrawUsage);
        nextMatrix.needsUpdate = true;
        mesh.instanceMatrix = nextMatrix;
      };

      const registerRenderItem = (item) => {
        const boundsBox = new THREE.Box3();
        expandBoundsWithObject(boundsBox, item.getRenderObject('near'));
        expandBoundsWithObject(boundsBox, item.getRenderObject('lod'));
        expandBoundsWithHandles(boundsBox, item.getRenderHandles('near'));
        expandBoundsWithHandles(boundsBox, item.getRenderHandles('lod'));
        if (boundsBox.isEmpty()) {
          boundsBox.setFromCenterAndSize(
            item.anchor.clone(),
            new THREE.Vector3(WORLD_CHUNK_SIZE * 0.5, WORLD_CHUNK_SIZE * 0.5, WORLD_CHUNK_SIZE * 0.5),
          );
        }
        stabilizeSmallNearOnlyBounds(boundsBox, item);

        item.boundsMin = boundsBox.min.clone();
        item.boundsMax = boundsBox.max.clone();
        item.boundingBox = boundsBox.clone();
        item.boundingSphere = boundsBox.getBoundingSphere(new THREE.Sphere());
        renderItems.push(item);
        const chunk = getRenderChunk(item.anchor);
        chunk.items.push(item);
        chunk.boundsMin.min(item.boundsMin);
        chunk.boundsMax.max(item.boundsMax);
        item.chunkKey = chunk.key;
        item.isBigBuilding = classifyBigBuildingItem(item);
        if (item.isBigBuilding) bigBuildingItems.push(item);
        return item;
      };

      const tryBuildInstancedHandles = async (placement, placementIndex, lodKind, anchor) => {
        const placementModelName = normalizeModelLookupName(placement.modelName);
        const ide = ideByModel.get(placementModelName) ?? ideById.get(placement.id);
        if (!ide) {
          unresolved += 1;
          return null;
        }
        try {
          const model = await getModelTemplate(ide.modelName, ide.txdName);
          if (!canUseInstancing(model, ide)) return null;
          const worldMatrix = buildPlacementWorldMatrix(placement, anchor);
          const chunk = getRenderChunk(anchor);
          maybeRegisterPlacementEmitters(placement, placementIndex, worldMatrix, ide, model, lodKind);
          const handles = [];
          const objectDetail = buildObjectDetail(ide, placement, lodKind, model);
          model.meshDescriptors.forEach((descriptor, descriptorIndex) => {
            const batch = ensureInstancedBatch(chunk, model, lodKind, ide, descriptorIndex, descriptor);
            ensureInstancedBatchCapacity(batch, batch.entries.length + 1);
            const matrix = worldMatrix.clone().multiply(descriptor.localMatrix);
            if (!descriptor.geometry.boundingBox) {
              descriptor.geometry.computeBoundingBox();
            }
            const handle = {
              batch,
              index: -1,
              activeIndex: -1,
              dirtyQueued: false,
              matrix,
              placementMatrix: worldMatrix.clone(),
              visible: false,
              objectDetail,
              selectionTemplate: model.template,
              localBounds: descriptor.geometry.boundingBox?.clone?.() || null,
              ideFlags: ide.flags | 0,
              isTobj: ide.section === 'tobjs',
            };
            batch.entries.push(handle);
            handles.push(handle);
          });
          loaded += 1;
          instancedItems += 1;
          return { handles, ide };
        } catch (error) {
          const worldMatrix = buildPlacementWorldMatrix(placement, anchor);
          maybeRegisterPlacementEmitters(placement, placementIndex, worldMatrix, ide, null, lodKind);
          failed += 1;
          pushFailedModel?.(`model=${placement.modelName} lod=${lodKind} error=${formatConsoleArg(error)}`);
          return null;
        }
      };

      const buildPlacementObject = async (placement, placementIndex, lodKind, anchor) => {
        const placementModelName = normalizeModelLookupName(placement.modelName);
        const ide = ideByModel.get(placementModelName) ?? ideById.get(placement.id);
        if (!ide) {
          unresolved += 1;
          return null;
        }
        try {
          const model = await getModelTemplate(ide.modelName, ide.txdName);
          const worldMatrix = buildPlacementWorldMatrix(placement, anchor);
          maybeRegisterPlacementEmitters(placement, placementIndex, worldMatrix, ide, model, lodKind);

          const instance = SkeletonUtils.clone(model.template);
          instance.applyMatrix4(worldMatrix);
          applyWireframe(instance, uiStateRef.current.wireframe);
          if (ide.section === 'tobjs') {
            prepareTobjInstanceMaterials(instance, uiStateRef.current.disableVertexColor);
          }
          applyRwIdeFlagsToInstance(instance, ide.flags);
          applyDisableVertexColor(instance, uiStateRef.current.disableVertexColor);
          applyGlobalBackfaceCulling(instance, uiStateRef.current.disableBackfaceCulling);
          instance.updateMatrixWorld(true);
          instance.traverse((node) => {
            if (!node.isObject3D) return;
            node.matrixAutoUpdate = false;
            node.matrixWorldAutoUpdate = false;
          });
          instance.visible = false;
          instance.userData.lodKind = lodKind;
          instance.userData.selectableRoot = true;
          instance.userData.objectDetail = buildObjectDetail(ide, placement, lodKind, model);
          instance.userData.fadeTemplate = model.template;
          instance.userData.placementMatrix = worldMatrix.clone();
          instance.userData.rwIdeFlags = ide.flags | 0;
          instance.userData.isTobj = ide.section === 'tobjs';
          instance.userData.rwPipelineTarget = createRwPipelineTarget(buildGameVersion, ide.section === 'tobjs');
          instance.userData.rwQueueRenderClass = 'building';
          collectQueueMeshes(instance);
          const chunk = getRenderChunk(anchor);
          if (worldOpaqueRoot && isDedicatedOpaqueSceneCandidate(instance)) {
            markDedicatedOpaqueSceneObject(instance);
            attachChunkOpaqueGroup(chunk);
            chunk.opaqueGroup.add(instance);
          } else {
            chunk.group.add(instance);
          }
          rwRenderQueueRef.current?.markDirty?.();
          loaded += 1;
          return instance;
        } catch (error) {
          const worldMatrix = buildPlacementWorldMatrix(placement, anchor);
          maybeRegisterPlacementEmitters(placement, placementIndex, worldMatrix, ide, null, lodKind);
          failed += 1;
          pushFailedModel?.(`model=${placement.modelName} lod=${lodKind} error=${formatConsoleArg(error)}`);
          return null;
        }
      };

      const batchSize = 32;
      let completed = 0;
      const buildTotal = nonLodIndices.length + standaloneLodIndices.length;
      setBuildProgress?.({ active: true, current: 0, total: buildTotal });

      for (let batchStart = 0; batchStart < nonLodIndices.length; batchStart += batchSize) {
        if (buildTokenRef.current !== token) {
          pendingWaterPipeline?.dispose();
          return;
        }
        const batch = nonLodIndices.slice(batchStart, batchStart + batchSize);
        await Promise.all(batch.map(async (index) => {
          const placement = effectivePlacements[index];
          const anchor = placementAnchors[index];
          const lodIndex = lodMapping.get(index);
          const placementModelName = normalizeModelLookupName(placement.modelName);
          const nearDef = ideByModel.get(placementModelName) ?? ideById.get(placement.id);
          const isTobj = nearDef?.section === 'tobjs';
          const nearInstanced = lodIndex == null ? await tryBuildInstancedHandles(placement, index, 'near', anchor) : null;
          const nearObj = nearInstanced ? null : await buildPlacementObject(placement, index, 'near', anchor);
          let lodObj = null;
          let lodDef = null;
          if (Number.isInteger(lodIndex)) {
            const lodPlacement = effectivePlacements[lodIndex];
            const lodModelName = normalizeModelLookupName(lodPlacement.modelName);
            lodDef = ideByModel.get(lodModelName) ?? ideById.get(lodPlacement.id);
            lodObj = await buildPlacementObject(lodPlacement, lodIndex, 'lod', placementAnchors[lodIndex]);
          }
          if (nearObj || lodObj || nearInstanced) {
            registerRenderItem(createCEntity({
              isTobj,
              anchor: anchor.clone(),
              nearDistance: nearDef?.drawDistance ?? null,
              relatedModelName: placementModelName,
              nearState: createEntityRenderSide({
                object3D: nearObj,
                handles: nearInstanced?.handles || [],
                drawDistance: nearDef?.drawDistance,
                isTobj,
              }),
              lodState: createEntityRenderSide({
                object3D: lodObj,
                handles: [],
                drawDistance: lodDef?.drawDistance ?? null,
              }),
              mode: 'hidden',
            }));
          }
        }));
        completed += batch.length;
        setStats?.((prev) => ({ ...prev, loaded, failed, unresolved }));
        setBuildProgress?.({ active: true, current: completed, total: buildTotal });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      for (let batchStart = 0; batchStart < standaloneLodIndices.length; batchStart += batchSize) {
        const batch = standaloneLodIndices.slice(batchStart, batchStart + batchSize);
        await Promise.all(batch.map(async (index) => {
          const placement = effectivePlacements[index];
          const anchor = placementAnchors[index];
          const placementModelName = normalizeModelLookupName(placement.modelName);
          const lodDef = ideByModel.get(placementModelName) ?? ideById.get(placement.id);
          const isTobj = lodDef?.section === 'tobjs';
          const standaloneRenderKind = 'near';
          const nearInstanced = await tryBuildInstancedHandles(placement, index, standaloneRenderKind, anchor);
          const nearObj = nearInstanced ? null : await buildPlacementObject(placement, index, standaloneRenderKind, anchor);
          if (nearObj || nearInstanced) {
            registerRenderItem(createCEntity({
              isTobj,
              anchor: anchor.clone(),
              nearState: createEntityRenderSide({
                object3D: nearObj,
                handles: nearInstanced?.handles || [],
                drawDistance: lodDef?.drawDistance,
                isTobj,
              }),
              lodState: createEntityRenderSide(),
              mode: 'hidden',
            }));
          }
        }));
      }

      for (const chunk of renderChunkMap.values()) {
        if (chunk.items.length === 0 || !hasFiniteVector3(chunk.boundsMin) || !hasFiniteVector3(chunk.boundsMax)) {
          chunk.occlusionBox.setFromCenterAndSize(
            chunk.center.clone(),
            new THREE.Vector3(WORLD_CHUNK_SIZE, WORLD_CHUNK_SIZE, WORLD_CHUNK_SIZE),
          );
          chunk.occlusionSphere.center.copy(chunk.center);
          chunk.occlusionSphere.radius = CHUNK_SPHERE_PADDING;
          chunk.boundingBox.setFromCenterAndSize(
            chunk.center.clone(),
            new THREE.Vector3(
              WORLD_CHUNK_SIZE + (CHUNK_CULL_MARGIN_XZ * 2),
              WORLD_CHUNK_SIZE + (CHUNK_CULL_MARGIN_Y * 2),
              WORLD_CHUNK_SIZE + (CHUNK_CULL_MARGIN_XZ * 2),
            ),
          );
          chunk.boundingSphere.center.copy(chunk.center);
          chunk.boundingSphere.radius = CHUNK_SPHERE_PADDING + Math.max(CHUNK_CULL_MARGIN_XZ, CHUNK_CULL_MARGIN_Y);
          continue;
        }

        chunk.occlusionBox.min.copy(chunk.boundsMin);
        chunk.occlusionBox.max.copy(chunk.boundsMax);
        chunk.occlusionBox.expandByScalar(CHUNK_CULL_MARGIN_XZ);
        chunk.occlusionBox.min.y -= CHUNK_CULL_MARGIN_Y;
        chunk.occlusionBox.max.y += CHUNK_CULL_MARGIN_Y;
        chunk.occlusionBox.getBoundingSphere(chunk.occlusionSphere);

        chunk.boundingBox.min.copy(chunk.boundsMin);
        chunk.boundingBox.max.copy(chunk.boundsMax);
        chunk.boundingBox.expandByScalar(CHUNK_CULL_MARGIN_XZ);
        chunk.boundingBox.min.y -= CHUNK_CULL_MARGIN_Y;
        chunk.boundingBox.max.y += CHUNK_CULL_MARGIN_Y;
        chunk.boundingBox.getBoundingSphere(chunk.boundingSphere);
      }

      this.rendererSession.setWaterRuntime(pendingWaterPipeline);
      if (particleTextureDictionary == null) {
        particleTextureDictionary = await getTextureDict('particle');
      }
      const resolvedParticleTextures = particleTextureDictionary
        ? {
          waterTexture: resolveParticleTexture(particleTextureDictionary, ['waterclear256', 'waterreflection2']),
          moonTexture: resolveParticleTexture(particleTextureDictionary, ['coronamoon', 'corona']),
          starTexture: resolveParticleTexture(particleTextureDictionary, ['coronastar', 'corona']),
          sunTextures: {
            star: resolveParticleTexture(particleTextureDictionary, ['coronastar', 'corona']),
            hex: resolveParticleTexture(particleTextureDictionary, ['coronahex', 'corona']),
            circle: resolveParticleTexture(particleTextureDictionary, ['coronacircle', 'corona']),
            ring: resolveParticleTexture(particleTextureDictionary, ['coronaringa', 'corona']),
          },
          // CClouds::Init — revc/src/renderer/Clouds.cpp
          lowCloudTextures: [
            resolveParticleTexture(particleTextureDictionary, ['cloud1']),
            resolveParticleTexture(particleTextureDictionary, ['cloud2']),
            resolveParticleTexture(particleTextureDictionary, ['cloud3']),
          ],
          cloudMaskedTexture: resolveParticleTexture(particleTextureDictionary, ['cloudmasked']),
          cloudHilitTexture: resolveParticleTexture(particleTextureDictionary, ['cloudhilit', 'cloudhilight']),
        }
        : null;
      if (particleTextureDictionary) {
        const hasLow = resolvedParticleTextures?.lowCloudTextures?.some(Boolean);
        const hasMasked = Boolean(resolvedParticleTextures?.cloudMaskedTexture);
        if (!hasLow && !hasMasked) {
          pushConsoleLine?.(
            'warn',
            'particle.txd: no cloud1/cloud2/cloud3 or cloudmasked entries found (clouds will use procedural fallback)',
          );
        } else {
          pushConsoleLine?.(
            'info',
            `particle.txd clouds: low=${hasLow ? 'cloud1–3' : 'missing'} masked=${hasMasked ? 'yes' : 'no'} hilit=${resolvedParticleTextures?.cloudHilitTexture ? 'yes' : 'no'}`,
          );
        }
      }
      pendingWaterPipeline?.setTexture?.(resolvedParticleTextures?.waterTexture || null);
      onParticleTexturesResolved?.(resolvedParticleTextures);
      const traversalRoots = [worldRoot, worldOpaqueRoot].filter((root) => root?.isObject3D);
      if (coronaEmitters.length > 0 && particleTextureDictionary) {
        const coronaRuntime = this.rendererSession.createCoronaRuntime({
          root: traversalRoots,
          emitters: coronaEmitters,
          textureDictionary: particleTextureDictionary,
          enableDebugHelpers: true,
        });
        coronaRuntime.setEnabled(uiStateRef.current.render2dfx);
        coronaRuntime.setDebugShowAll(uiStateRef.current.debug2dfx);
        const shadowRuntime = this.rendererSession.createShadowRuntime({
          root: traversalRoots,
          emitters: coronaEmitters,
          textureDictionary: particleTextureDictionary,
        });
        shadowRuntime.setEnabled(uiStateRef.current.render2dfx && uiStateRef.current.shadows.enabled);
      } else {
        this.rendererSession.disposeCoronaRuntime();
        this.rendererSession.disposeShadowRuntime();
      }

      renderItemsRef.current = renderItems;
      bigBuildingItemsRef.current = bigBuildingItems;
      renderChunksRef.current = Array.from(renderChunkMap.values());
      renderChunkLookupRef.current = renderChunkMap;
      activeRenderChunksRef.current = new Set();
      this.rendererSession.setBackend(activeBackend);
      this.rendererSession.setRoot(worldRoot, { traversalRoots });
      this.rendererSession.applyToRoot(worldRoot, {
        activeBackend,
        worldGameVersion: buildGameVersion,
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
      if (worldOpaqueRoot) {
        this.rendererSession.applyToRoot(worldOpaqueRoot, {
          activeBackend,
          worldGameVersion: buildGameVersion,
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
        this.rendererSession.setRoot(worldRoot, { traversalRoots });
      }
      applyWireframe(worldRoot, uiStateRef.current.wireframe);
      applyDisableVertexColor(worldRoot, uiStateRef.current.disableVertexColor);
      applyGlobalBackfaceCulling(worldRoot, uiStateRef.current.disableBackfaceCulling);
      if (worldOpaqueRoot) {
        applyWireframe(worldOpaqueRoot, uiStateRef.current.wireframe);
        applyDisableVertexColor(worldOpaqueRoot, uiStateRef.current.disableVertexColor);
        applyGlobalBackfaceCulling(worldOpaqueRoot, uiStateRef.current.disableBackfaceCulling);
      }
      lastPipelineSelectionSignatureRef.current = '';
      rwRenderQueueRef.current?.markDirty();
      lodUpdateStateRef.current.needsRefresh = true;
      lodUpdateStateRef.current.lastCameraPos.set(Number.NaN, Number.NaN, Number.NaN);
      lodUpdateStateRef.current.lastCameraQuat.set(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
      lodUpdateStateRef.current.chunkScanCache = null;
      setBuildProgress?.({ active: false, current: buildTotal, total: buildTotal });
      setStatus?.(`Done. Loaded ${loaded} placements.`);
      setShowGameIcon?.(true);
      renderResourcesReadyRef.current = true;
      setStats?.((prev) => ({
        ...prev,
        loaded,
        failed,
        unresolved,
        totalChunks: renderChunkMap.size,
        instancedBatches: instancedBatchMap.size,
        instancedItems,
        lightObjects: placementsWithLights.size,
        lightEmitters: coronaEmitters.length,
      }));
      pushConsoleLine?.('info', `Chunk visible set: ${renderChunkMap.size} chunks`);
      pushConsoleLine?.('info', `Instanced batches: ${instancedBatchMap.size}, instanced placements: ${instancedItems}`);
    } finally {
      buildActiveRef.current = false;
    }
  }

  dispose() {
    this.rendererSession.dispose();
  }
}

export function createJsrwGtaSession(options = {}) {
  return new JsrwGtaSession(options);
}

export default JsrwGtaSession;
