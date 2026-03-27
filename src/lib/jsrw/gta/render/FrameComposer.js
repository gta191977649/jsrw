import * as THREE from 'three';
import { formatConsoleArg } from '../../../console.js';
import { applyDisableVertexColor } from '../../adapters/three/ThreeMaterialAdapter.js';
import { RW_PIPELINE_CATEGORY } from '../../core/pipeline/constants.js';
import {
  cloneRWPipelineSelections,
  resolveRWPipelineSelection,
} from '../../core/pipeline/selection.js';
import {
  applyGlobalBackfaceCulling,
  applyWireframe,
} from '../../utils/worldUtils.js';
import { toThreeColorFromTimecycleValue } from '../integration/sessionHelpers.js';

const DEFAULT_SCENE_BACKGROUND = new THREE.Color(0x8ea9b5);
const FALLBACK_AMBIENT = new THREE.Color(1, 1, 1);
const FALLBACK_EMISSIVE = new THREE.Color(0, 0, 0);

function beginCpuProfile(enabled) {
  return enabled ? performance.now() : 0;
}

function endCpuProfile(enabled, startMs) {
  return enabled ? (performance.now() - startMs) : 0;
}

function takeRenderStatsSnapshot(renderer) {
  return {
    calls: renderer?.info?.render?.calls ?? 0,
    triangles: renderer?.info?.render?.triangles ?? 0,
  };
}

function accumulateRenderStatsDelta(renderer, bucket, beforeSnapshot) {
  const after = takeRenderStatsSnapshot(renderer);
  bucket.drawCalls += Math.max(0, after.calls - (beforeSnapshot?.calls ?? 0));
  bucket.triangles += Math.max(0, after.triangles - (beforeSnapshot?.triangles ?? 0));
  return after;
}

function getPipelineSelectionSignature(selectionMap, backend, worldGameVersion) {
  const selections = cloneRWPipelineSelections(selectionMap);
  return Object.values(RW_PIPELINE_CATEGORY).map((category) => {
    const normalized = resolveRWPipelineSelection(selections[category], worldGameVersion);
    return [
      category,
      normalized.enabled ? '1' : '0',
      normalized.game,
      normalized.platform,
      JSON.stringify(normalized.config || {}),
      String(backend || 'WebGL'),
      String(worldGameVersion || ''),
    ].join('|');
  }).join('::');
}

export class FrameComposer {
  constructor(options = {}) {
    this.rendererSession = options.rendererSession || null;
  }

  buildPipelineRuntimeContext(context) {
    const { activeBackend, worldGameVersionRef, timecycleCurrent, postFxDebugCapture } = context;
    return {
      activeBackend,
      worldGameVersion: worldGameVersionRef.current,
      distanceFade: context.distanceFade,
      postFxDebugCapture,
      timecycleCurrent,
      ambientColor: timecycleCurrent?.values?.ambient
        ? toThreeColorFromTimecycleValue(timecycleCurrent.values.ambient)
        : FALLBACK_AMBIENT,
      emissiveColor: timecycleCurrent?.values?.ambientBl
        ? toThreeColorFromTimecycleValue(timecycleCurrent.values.ambientBl)
        : FALLBACK_EMISSIVE,
      fallbackAmbient: FALLBACK_AMBIENT,
      fallbackEmissive: FALLBACK_EMISSIVE,
      fogColor: timecycleCurrent?.three?.fogColor?.isColor ? timecycleCurrent.three.fogColor : null,
      fogStart: Number.isFinite(timecycleCurrent?.values?.fogStart) ? timecycleCurrent.values.fogStart : null,
      fogEnd: Number.isFinite(timecycleCurrent?.values?.farClip) ? timecycleCurrent.values.farClip : null,
    };
  }

  render(context = {}) {
    const profileEnabled = context.statsProfilingEnabled === true;
    const detailedProfileEnabled = profileEnabled && context.statsDetailedProfilingEnabled === true;
    const frameComposerStartMs = beginCpuProfile(profileEnabled);
    const {
      renderer,
      scene,
      camera,
      cutsceneScene,
      activeBackend,
      worldGameVersionRef,
      uiStateRef,
      worldRootRef,
      worldOpaqueRootRef,
      worldOpaqueSceneRef,
      rwRenderQueueRef,
      renderMetricsRef,
      renderResourcesReadyRef,
      lastPipelineSelectionSignatureRef,
      lastWireframeRef,
      lastDisableVertexColorRef,
      lastDisableBackfaceCullingRef,
      lastRenderWaterRef,
      timecycleCurrent,
      frameVisibilityRef,
      viewportWidth,
      viewportHeight,
      skyScene,
      skyCamera,
      skyCloudScene,
      skyFeature,
      skyBottomColor,
      postFxSunCoronaEnabled,
      showGameIcon,
      cutsceneSubtitleCue,
      pushConsoleLine,
      setStatus,
      postFxDebugCapture = false,
      render2dfxEnabled = true,
      grid,
      axes,
    } = context;

    if (!renderer || !scene || !camera) return;
    const metrics = renderMetricsRef.current;

    const stageWorldStats = { drawCalls: 0, triangles: 0 };
    const stageWaterStats = { drawCalls: 0, triangles: 0 };
    const stageSkyStats = { drawCalls: 0, triangles: 0 };
    const skyCloudPassStats = { drawCalls: 0, triangles: 0 };
    let skyCloudsPassInvoked = false;
    const renderStages = uiStateRef.current.renderStages || {};
    const hudRuntime = this.rendererSession?.getHudRuntime?.() || null;

    const renderHudStage = () => {
      if (!renderStages.hud || !hudRuntime) {
        metrics.frameHudCpuMs = 0;
        return;
      }
      hudRuntime.setViewport(viewportWidth, viewportHeight);
      hudRuntime.setGameVersion(uiStateRef.current.gameVersion);
      hudRuntime.setShowGameIcon(showGameIcon);
      hudRuntime.setSubtitleCue(cutsceneSubtitleCue);
      renderer.autoClear = false;
      renderer.clearDepth();
      const beforeHud = takeRenderStatsSnapshot(renderer);
      const hudCpuStartMs = beginCpuProfile(detailedProfileEnabled);
      hudRuntime.render(renderer);
      const hudCpuMs = endCpuProfile(detailedProfileEnabled, hudCpuStartMs);
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeHud);
      renderer.autoClear = true;
      metrics.frameHudCpuMs = hudCpuMs;
    };

    const renderCutsceneSceneStage = () => {
      if (!cutsceneScene?.isScene || cutsceneScene.children.length === 0) return;
      cutsceneScene.background = null;
      cutsceneScene.fog = scene?.fog || null;
      renderer.autoClear = false;
      renderer.clearDepth();
      const beforeCutscene = takeRenderStatsSnapshot(renderer);
      renderer.render(cutsceneScene, camera);
      accumulateRenderStatsDelta(renderer, stageWorldStats, beforeCutscene);
      renderer.autoClear = true;
    };

    if (grid) grid.visible = uiStateRef.current.showGrid;
    if (axes) axes.visible = uiStateRef.current.showAxes;
    const worldRoot = worldRootRef.current;
    const worldOpaqueRoot = worldOpaqueRootRef?.current || null;
    const worldOpaqueScene = worldOpaqueSceneRef?.current || null;
    const traversalRoots = [worldRoot, worldOpaqueRoot].filter((root) => root?.isObject3D);

    if (lastWireframeRef.current !== uiStateRef.current.wireframe) {
      applyWireframe(worldRootRef.current, uiStateRef.current.wireframe);
      if (worldOpaqueRoot) applyWireframe(worldOpaqueRoot, uiStateRef.current.wireframe);
      this.rendererSession?.getWaterRuntime?.()?.setWireframe(uiStateRef.current.wireframe);
      lastWireframeRef.current = uiStateRef.current.wireframe;
    }
    if (lastDisableVertexColorRef.current !== uiStateRef.current.disableVertexColor) {
      applyDisableVertexColor(worldRootRef.current, uiStateRef.current.disableVertexColor);
      if (worldOpaqueRoot) applyDisableVertexColor(worldOpaqueRoot, uiStateRef.current.disableVertexColor);
      lastDisableVertexColorRef.current = uiStateRef.current.disableVertexColor;
    }
    if (lastDisableBackfaceCullingRef.current !== uiStateRef.current.disableBackfaceCulling) {
      applyGlobalBackfaceCulling(worldRootRef.current, uiStateRef.current.disableBackfaceCulling);
      if (worldOpaqueRoot) applyGlobalBackfaceCulling(worldOpaqueRoot, uiStateRef.current.disableBackfaceCulling);
      lastDisableBackfaceCullingRef.current = uiStateRef.current.disableBackfaceCulling;
    }
    if (lastRenderWaterRef.current !== uiStateRef.current.renderWater) {
      this.rendererSession?.getWaterRuntime?.()?.setEnabled(uiStateRef.current.renderWater);
      lastRenderWaterRef.current = uiStateRef.current.renderWater;
    }

    const pipelineRuntimeContext = this.buildPipelineRuntimeContext({
      ...context,
      activeBackend,
      worldGameVersionRef,
      timecycleCurrent,
      postFxDebugCapture,
    });
    this.rendererSession?.setBackend(activeBackend);
    this.rendererSession?.setSelection(uiStateRef.current.pipelineDebug);
    const pipelineSelectionSignature = getPipelineSelectionSignature(
      uiStateRef.current.pipelineDebug,
      activeBackend,
      worldGameVersionRef.current,
    );
    if (pipelineSelectionSignature !== lastPipelineSelectionSignatureRef.current) {
      this.rendererSession?.applyToRoot(worldRootRef.current, pipelineRuntimeContext);
      if (worldOpaqueRoot) this.rendererSession?.applyToRoot(worldOpaqueRoot, pipelineRuntimeContext);
      this.rendererSession?.setRoot?.(worldRoot, { traversalRoots });
      applyWireframe(worldRootRef.current, uiStateRef.current.wireframe);
      if (worldOpaqueRoot) applyWireframe(worldOpaqueRoot, uiStateRef.current.wireframe);
      applyDisableVertexColor(worldRootRef.current, uiStateRef.current.disableVertexColor);
      if (worldOpaqueRoot) applyDisableVertexColor(worldOpaqueRoot, uiStateRef.current.disableVertexColor);
      applyGlobalBackfaceCulling(worldRootRef.current, uiStateRef.current.disableBackfaceCulling);
      if (worldOpaqueRoot) applyGlobalBackfaceCulling(worldOpaqueRoot, uiStateRef.current.disableBackfaceCulling);
      lastPipelineSelectionSignatureRef.current = pipelineSelectionSignature;
      rwRenderQueueRef.current?.markDirty?.();
      this.rendererSession?.getCoronaRuntime?.()?.markOccludersDirty?.();
      this.rendererSession?.getShadowRuntime?.()?.markSceneMeshesDirty?.();
    } else {
      this.rendererSession?.updateRuntime?.(pipelineRuntimeContext);
    }

    if (!renderResourcesReadyRef.current) {
      renderer.setRenderTarget(null);
      renderer.autoClear = true;
      renderer.setClearColor(DEFAULT_SCENE_BACKGROUND, 1);
      renderer.clear(true, true, true);
      renderCutsceneSceneStage();
      renderHudStage();
      return;
    }

    const waterPipeline = this.rendererSession?.getWaterRuntime?.();
    const coronaRuntime = this.rendererSession?.getCoronaRuntime?.();
    const shadowRuntime = this.rendererSession?.getShadowRuntime?.();
    const frameVisibility = frameVisibilityRef.current;
    if (worldOpaqueScene?.isScene) {
      worldOpaqueScene.background = null;
      worldOpaqueScene.fog = scene.fog || null;
    }

    coronaRuntime?.setEnabled(render2dfxEnabled);
    shadowRuntime?.setEnabled(render2dfxEnabled && uiStateRef.current.shadows.enabled);
    coronaRuntime?.setDebugShowAll(uiStateRef.current.debug2dfx);
    waterPipeline?.applySettings?.({
      uvSpeed: uiStateRef.current.waterUvSpeed,
      waveHeight: uiStateRef.current.waterWaveHeight,
      farAlpha: uiStateRef.current.waterAlpha,
    });
    coronaRuntime?.setViewport?.(viewportWidth, viewportHeight);
    const coronaUpdateStartMs = beginCpuProfile(profileEnabled);
    coronaRuntime?.update?.(camera, {
      ...pipelineRuntimeContext,
      frameVisibility,
      timeMs: context.timeMs,
      dt: context.dt,
      viewportWidth,
      viewportHeight,
      forceRender2dfx: uiStateRef.current.forceRender2dfx,
      twoDfx: uiStateRef.current.twoDfx,
      trafficLights: uiStateRef.current.trafficLights,
    });
    const coronaUpdateCpuMs = endCpuProfile(profileEnabled, coronaUpdateStartMs);
    const coronaDebugStats = coronaRuntime?.raw?.debugStats || {};
    const shadowUpdateStartMs = beginCpuProfile(profileEnabled);
    shadowRuntime?.update?.(camera, {
      ...pipelineRuntimeContext,
      frameVisibility,
      timeMs: context.timeMs,
      dt: context.dt,
      viewportWidth,
      viewportHeight,
      forceRender2dfx: uiStateRef.current.forceRender2dfx,
      trafficLights: uiStateRef.current.trafficLights,
      shadows: uiStateRef.current.shadows,
    });
    const shadowUpdateCpuMs = endCpuProfile(profileEnabled, shadowUpdateStartMs);

    const farBackgroundColor = skyBottomColor;
    const rwRenderQueue = rwRenderQueueRef.current;
    const postFxSceneTarget = renderStages.postFx
      ? this.rendererSession?.beginPostFxSceneCapture?.({
        ...pipelineRuntimeContext,
        viewportWidth,
        viewportHeight,
      })
      : null;
    rwRenderQueue?.prepareFrame?.(camera, frameVisibility, { profileEnabled });
    const queueStats = rwRenderQueue?.debugStats || {};
    const hasBlendQueue = (queueStats.transparentCount || 0) > 0;
    const hasAdditiveQueue = (queueStats.additiveCount || 0) > 0;
    const hasOverlayQueue = (queueStats.overlayCount || 0) > 0;
    const transparentBuckets = [];
    if (renderStages.sceneTransparent && renderStages.sceneBlend && hasBlendQueue) transparentBuckets.push('transparent');
    if (renderStages.sceneTransparent && renderStages.sceneAdditive && hasAdditiveQueue) transparentBuckets.push('additive');
    if (renderStages.sceneTransparent && renderStages.sceneOverlay && hasOverlayQueue) transparentBuckets.push('overlay');

    renderer.setRenderTarget(postFxSceneTarget);
    renderer.autoClear = true;
    if (renderStages.skyDome && skyScene && skyCamera) {
      const beforeSkyDome = takeRenderStatsSnapshot(renderer);
      const skyDomeCpuStartMs = beginCpuProfile(detailedProfileEnabled);
      renderer.render(skyScene, skyCamera);
      const skyDomeCpuMs = endCpuProfile(detailedProfileEnabled, skyDomeCpuStartMs);
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeSkyDome);
      metrics.frameSkyDomeCpuMs = skyDomeCpuMs;
    } else {
      renderer.setClearColor(farBackgroundColor, 1);
      renderer.clear(true, true, true);
      metrics.frameSkyDomeCpuMs = 0;
    }
    renderer.autoClear = false;
    renderer.clearDepth();
    if (renderStages.skyBackdrop) {
      const beforeBackdrop = takeRenderStatsSnapshot(renderer);
      const skyBackdropCpuStartMs = beginCpuProfile(detailedProfileEnabled);
      skyFeature?.renderBackground?.(renderer);
      const skyBackdropCpuMs = endCpuProfile(detailedProfileEnabled, skyBackdropCpuStartMs);
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeBackdrop);
      metrics.frameSkyBackdropCpuMs = skyBackdropCpuMs;
    } else {
      metrics.frameSkyBackdropCpuMs = 0;
    }
    if (renderStages.skyClouds && skyCloudScene) {
      const beforeClouds = takeRenderStatsSnapshot(renderer);
      const skyCloudsCpuStartMs = beginCpuProfile(detailedProfileEnabled);
      const originalFar = camera.far;
      const cloudFar = Math.max(originalFar, 5000);
      let projectionPatched = false;
      if (Math.abs(cloudFar - originalFar) > 1e-6) {
        camera.far = cloudFar;
        camera.updateProjectionMatrix();
        projectionPatched = true;
      }
      try {
        renderer.render(skyCloudScene, camera);
        skyCloudsPassInvoked = true;
      } finally {
        if (projectionPatched) {
          camera.far = originalFar;
          camera.updateProjectionMatrix();
        }
      }
      const skyCloudsCpuMs = endCpuProfile(detailedProfileEnabled, skyCloudsCpuStartMs);
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeClouds);
      accumulateRenderStatsDelta(renderer, skyCloudPassStats, beforeClouds);
      metrics.frameSkyCloudsCpuMs = skyCloudsCpuMs;
      renderer.clearDepth();
    } else {
      metrics.frameSkyCloudsCpuMs = 0;
    }

    const renderOpaqueAndTransparent = (allowWater = false) => {
      renderer.autoClear = false;
      let worldOpaqueCpuMs = 0;
      let worldTransparentCpuMs = 0;
      let waterUpdateCpuMs = 0;
      let waterFarCpuMs = 0;
      let waterNearCpuMs = 0;
      let waterWavyCpuMs = 0;
      let waterWakeCpuMs = 0;
      let shadowRenderCpuMs = 0;
      let coronaRenderCpuMs = 0;
      if (allowWater && waterPipeline?.hasRenderableWater?.() && uiStateRef.current.renderWater) {
        let waterStage = 'update';
        try {
          const waterUpdateStartMs = beginCpuProfile(detailedProfileEnabled);
          waterPipeline.update(camera, context.timeMs, context.dt);
          waterUpdateCpuMs += endCpuProfile(detailedProfileEnabled, waterUpdateStartMs);

          if (renderStages.sceneOpaque) {
            if (worldOpaqueScene?.isScene && worldOpaqueRoot?.children?.length > 0) {
              const beforeStaticOpaque = takeRenderStatsSnapshot(renderer);
              const staticOpaqueCpuStartMs = beginCpuProfile(profileEnabled);
              renderer.render(worldOpaqueScene, camera);
              worldOpaqueCpuMs += endCpuProfile(profileEnabled, staticOpaqueCpuStartMs);
              accumulateRenderStatsDelta(renderer, stageWorldStats, beforeStaticOpaque);
            }
            waterStage = 'renderSceneOpaque';
            const beforeOpaque = takeRenderStatsSnapshot(renderer);
            const opaqueCpuStartMs = beginCpuProfile(profileEnabled);
            rwRenderQueue?.renderOpaque?.(renderer, camera, {
              allowedBuckets: ['opaque', 'cutout'],
              fog: scene.fog || null,
              scene,
            });
            worldOpaqueCpuMs += endCpuProfile(profileEnabled, opaqueCpuStartMs);
            accumulateRenderStatsDelta(renderer, stageWorldStats, beforeOpaque);
          }

          if (renderStages.waterFar) {
            waterStage = 'renderFar';
            const beforeWaterFar = takeRenderStatsSnapshot(renderer);
            const waterFarStartMs = beginCpuProfile(detailedProfileEnabled);
            waterPipeline.renderFar(renderer, camera, null);
            waterFarCpuMs += endCpuProfile(detailedProfileEnabled, waterFarStartMs);
            accumulateRenderStatsDelta(renderer, stageWaterStats, beforeWaterFar);
          }

          if (renderStages.waterNear) {
            waterStage = 'renderNear';
            const beforeWaterNear = takeRenderStatsSnapshot(renderer);
            const waterNearStartMs = beginCpuProfile(detailedProfileEnabled);
            waterPipeline.renderNear(renderer, camera);
            waterNearCpuMs += endCpuProfile(detailedProfileEnabled, waterNearStartMs);
            accumulateRenderStatsDelta(renderer, stageWaterStats, beforeWaterNear);
          }

          if (renderStages.waterWavy) {
            waterStage = 'renderWavy';
            const beforeWaterWavy = takeRenderStatsSnapshot(renderer);
            const waterWavyStartMs = beginCpuProfile(detailedProfileEnabled);
            waterPipeline.renderWavy(renderer, camera);
            waterWavyCpuMs += endCpuProfile(detailedProfileEnabled, waterWavyStartMs);
            accumulateRenderStatsDelta(renderer, stageWaterStats, beforeWaterWavy);
          }

          if (renderStages.waterWake) {
            waterStage = 'renderWake';
            const beforeWaterWake = takeRenderStatsSnapshot(renderer);
            const waterWakeStartMs = beginCpuProfile(detailedProfileEnabled);
            waterPipeline.renderWake(renderer, camera);
            waterWakeCpuMs += endCpuProfile(detailedProfileEnabled, waterWakeStartMs);
            accumulateRenderStatsDelta(renderer, stageWaterStats, beforeWaterWake);
          }

          if (render2dfxEnabled && uiStateRef.current.shadows.enabled) {
            const beforeShadows = takeRenderStatsSnapshot(renderer);
            const shadowRenderStartMs = beginCpuProfile(detailedProfileEnabled);
            shadowRuntime?.render?.(renderer, camera);
            shadowRenderCpuMs += endCpuProfile(detailedProfileEnabled, shadowRenderStartMs);
            accumulateRenderStatsDelta(renderer, stageWorldStats, beforeShadows);
          }
          if (transparentBuckets.length > 0) {
            waterStage = 'renderSceneTransparent';
            const beforeTransparent = takeRenderStatsSnapshot(renderer);
            const transparentCpuStartMs = beginCpuProfile(profileEnabled);
            rwRenderQueue?.renderTransparent?.(renderer, camera, {
              allowedBuckets: transparentBuckets,
              fog: scene.fog || null,
              scene,
            });
            worldTransparentCpuMs += endCpuProfile(profileEnabled, transparentCpuStartMs);
            accumulateRenderStatsDelta(renderer, stageWorldStats, beforeTransparent);
          }
          if (renderStages.coronas) {
            const beforeCoronas = takeRenderStatsSnapshot(renderer);
            const coronaRenderStartMs = beginCpuProfile(detailedProfileEnabled);
            coronaRuntime?.render?.(renderer, camera);
            coronaRenderCpuMs += endCpuProfile(detailedProfileEnabled, coronaRenderStartMs);
            accumulateRenderStatsDelta(renderer, stageWorldStats, beforeCoronas);
          }
          renderer.autoClear = true;
          return {
            worldOpaqueCpuMs,
            worldTransparentCpuMs,
            waterUpdateCpuMs,
            waterFarCpuMs,
            waterNearCpuMs,
            waterWavyCpuMs,
            waterWakeCpuMs,
            shadowRenderCpuMs,
            coronaRenderCpuMs,
          };
        } catch (waterError) {
          rwRenderQueue?.popCameraBucketMask?.(camera);
          rwRenderQueue?.popCameraBucketMask?.(camera);
          const farPos = waterPipeline?.farMesh?.geometry?.getAttribute?.('position')?.array?.byteLength ?? 'missing';
          const farUv = waterPipeline?.farMesh?.geometry?.getAttribute?.('uv')?.array?.byteLength ?? 'missing';
          const farIndex = waterPipeline?.farMesh?.geometry?.index?.array?.byteLength ?? 'missing';
          const nearPos = waterPipeline?.nearMesh?.geometry?.getAttribute?.('position')?.array?.byteLength ?? 'missing';
          const nearUv = waterPipeline?.nearMesh?.geometry?.getAttribute?.('uv')?.array?.byteLength ?? 'missing';
          const nearIndex = waterPipeline?.nearMesh?.geometry?.index?.array?.byteLength ?? 'missing';
          const nearNormal = waterPipeline?.nearMesh?.geometry?.getAttribute?.('normal')?.array?.byteLength ?? 'missing';
          const wakePos = waterPipeline?.wakeMesh?.geometry?.getAttribute?.('position')?.array?.byteLength ?? 'missing';
          pushConsoleLine?.('error', `Water runtime error @ ${waterStage}: ${formatConsoleArg(waterError)}`);
          pushConsoleLine?.(
            'error',
            `Water buffers: far.pos=${farPos} far.uv=${farUv} far.idx=${farIndex} near.pos=${nearPos} near.uv=${nearUv} near.idx=${nearIndex} near.normal=${nearNormal} wake.pos=${wakePos}`,
          );
          setStatus?.(`Water runtime error @ ${waterStage}: ${formatConsoleArg(waterError)}. Water disabled.`);
          this.rendererSession?.disposeWaterRuntime?.();
        }
      }

      const sceneBuckets = [];
      if (renderStages.sceneOpaque) sceneBuckets.push('opaque', 'cutout');
      sceneBuckets.push(...transparentBuckets);
      if (sceneBuckets.length > 0) {
        const opaqueBuckets = sceneBuckets.filter((bucket) => bucket === 'opaque' || bucket === 'cutout');
        const transparentSceneBuckets = sceneBuckets.filter((bucket) => bucket !== 'opaque' && bucket !== 'cutout');
        if (opaqueBuckets.length > 0) {
          if (worldOpaqueScene?.isScene && worldOpaqueRoot?.children?.length > 0) {
            const beforeStaticOpaque = takeRenderStatsSnapshot(renderer);
            const staticOpaqueCpuStartMs = beginCpuProfile(profileEnabled);
            renderer.render(worldOpaqueScene, camera);
            worldOpaqueCpuMs += endCpuProfile(profileEnabled, staticOpaqueCpuStartMs);
            accumulateRenderStatsDelta(renderer, stageWorldStats, beforeStaticOpaque);
          }
          const beforeOpaque = takeRenderStatsSnapshot(renderer);
          const opaqueCpuStartMs = beginCpuProfile(profileEnabled);
          rwRenderQueue?.renderOpaque?.(renderer, camera, {
            allowedBuckets: opaqueBuckets,
            fog: scene.fog || null,
            scene,
          });
          worldOpaqueCpuMs += endCpuProfile(profileEnabled, opaqueCpuStartMs);
          accumulateRenderStatsDelta(renderer, stageWorldStats, beforeOpaque);
        }
        if (render2dfxEnabled && uiStateRef.current.shadows.enabled) {
          const beforeShadows = takeRenderStatsSnapshot(renderer);
          shadowRuntime?.render?.(renderer, camera);
          accumulateRenderStatsDelta(renderer, stageWorldStats, beforeShadows);
        }
        if (transparentSceneBuckets.length > 0) {
          const beforeTransparent = takeRenderStatsSnapshot(renderer);
          const transparentCpuStartMs = beginCpuProfile(profileEnabled);
          rwRenderQueue?.renderTransparent?.(renderer, camera, {
            allowedBuckets: transparentSceneBuckets,
            fog: scene.fog || null,
            scene,
          });
          worldTransparentCpuMs += endCpuProfile(profileEnabled, transparentCpuStartMs);
          accumulateRenderStatsDelta(renderer, stageWorldStats, beforeTransparent);
        }
      } else if (render2dfxEnabled && uiStateRef.current.shadows.enabled) {
        const beforeShadows = takeRenderStatsSnapshot(renderer);
        const shadowRenderStartMs = beginCpuProfile(detailedProfileEnabled);
        shadowRuntime?.render?.(renderer, camera);
        shadowRenderCpuMs += endCpuProfile(detailedProfileEnabled, shadowRenderStartMs);
        accumulateRenderStatsDelta(renderer, stageWorldStats, beforeShadows);
      }
      if (renderStages.coronas) {
        const beforeCoronas = takeRenderStatsSnapshot(renderer);
        const coronaRenderStartMs = beginCpuProfile(detailedProfileEnabled);
        coronaRuntime?.render?.(renderer, camera);
        coronaRenderCpuMs += endCpuProfile(detailedProfileEnabled, coronaRenderStartMs);
        accumulateRenderStatsDelta(renderer, stageWorldStats, beforeCoronas);
      }
      return {
        worldOpaqueCpuMs,
        worldTransparentCpuMs,
        waterUpdateCpuMs,
        waterFarCpuMs,
        waterNearCpuMs,
        waterWavyCpuMs,
        waterWakeCpuMs,
        shadowRenderCpuMs,
        coronaRenderCpuMs,
      };
    };

    const passCpuMetrics = renderOpaqueAndTransparent(true) || {
      worldOpaqueCpuMs: 0,
      worldTransparentCpuMs: 0,
      waterUpdateCpuMs: 0,
      waterFarCpuMs: 0,
      waterNearCpuMs: 0,
      waterWavyCpuMs: 0,
      waterWakeCpuMs: 0,
      shadowRenderCpuMs: 0,
      coronaRenderCpuMs: 0,
    };

    if (postFxSceneTarget && postFxSunCoronaEnabled && renderStages.sunBloom) {
      renderer.clearDepth();
      const beforeSunBloom = takeRenderStatsSnapshot(renderer);
      const sunBloomCpuStartMs = beginCpuProfile(detailedProfileEnabled);
      skyFeature?.renderSun?.(renderer, { mode: 'bloom' });
      const sunBloomCpuMs = endCpuProfile(detailedProfileEnabled, sunBloomCpuStartMs);
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeSunBloom);
      metrics.frameSunBloomCpuMs = sunBloomCpuMs;
    } else {
      metrics.frameSunBloomCpuMs = 0;
    }
    renderer.setRenderTarget(null);
    if (postFxSceneTarget) {
      const postFxStartMs = beginCpuProfile(detailedProfileEnabled);
      this.rendererSession?.renderPostFx?.(renderer, {
        ...pipelineRuntimeContext,
        viewportWidth,
        viewportHeight,
      });
      metrics.framePostFxCpuMs = endCpuProfile(detailedProfileEnabled, postFxStartMs);
    } else {
      metrics.framePostFxCpuMs = 0;
    }
    if (renderStages.sunFinal) {
      renderer.clearDepth();
      const beforeSunFinal = takeRenderStatsSnapshot(renderer);
      const sunFinalCpuStartMs = beginCpuProfile(detailedProfileEnabled);
      skyFeature?.renderSun?.(renderer, { mode: 'full' });
      const sunFinalCpuMs = endCpuProfile(detailedProfileEnabled, sunFinalCpuStartMs);
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeSunFinal);
      metrics.frameSunFinalCpuMs = sunFinalCpuMs;
    } else {
      metrics.frameSunFinalCpuMs = 0;
    }

    renderCutsceneSceneStage();
    renderHudStage();

    metrics.transparentQueue = rwRenderQueueRef.current?.debugStats?.transparentCount ?? 0;
    metrics.additiveQueue = rwRenderQueueRef.current?.debugStats?.additiveCount ?? 0;
    metrics.overlayQueue = rwRenderQueueRef.current?.debugStats?.overlayCount ?? 0;
    metrics.drawCalls = renderer.info?.render?.calls ?? 0;
    metrics.triangles = renderer.info?.render?.triangles ?? 0;
    metrics.worldDrawCalls = stageWorldStats.drawCalls;
    metrics.worldTriangles = stageWorldStats.triangles;
    metrics.waterDrawCalls = stageWaterStats.drawCalls;
    metrics.waterTriangles = stageWaterStats.triangles;
    metrics.skyDrawCalls = stageSkyStats.drawCalls;
    metrics.skyTriangles = stageSkyStats.triangles;
    metrics.skyCloudsPassInvoked = skyCloudsPassInvoked;
    metrics.skyCloudsPassDrawCalls = skyCloudPassStats.drawCalls;
    metrics.skyCloudsPassTriangles = skyCloudPassStats.triangles;
    metrics.renderQueuePrepareMs = rwRenderQueueRef.current?.debugStats?.prepareCpuMs ?? 0;
    metrics.renderQueuePrepareReuseHitMs = rwRenderQueueRef.current?.debugStats?.prepareReuseHitMs ?? 0;
    metrics.renderQueuePrepareBucketBindMs = rwRenderQueueRef.current?.debugStats?.prepareBucketBindMs ?? 0;
    metrics.renderQueuePrepareTransparentOrderApplyMs = rwRenderQueueRef.current?.debugStats?.prepareTransparentOrderApplyMs ?? 0;
    metrics.worldOpaqueCpuMs = passCpuMetrics.worldOpaqueCpuMs ?? 0;
    metrics.worldTransparentCpuMs = passCpuMetrics.worldTransparentCpuMs ?? 0;
    metrics.coronaUpdateCpuMs = coronaUpdateCpuMs;
    metrics.coronaSourceEntries = coronaDebugStats.sourceCount || 0;
    metrics.coronaCandidates = coronaDebugStats.candidateCount || 0;
    metrics.coronaSelectedEntries = coronaDebugStats.selectedCount || 0;
    metrics.coronaSpriteCount = coronaDebugStats.spriteCount || 0;
    metrics.coronaLightCount = coronaDebugStats.lightCount || 0;
    metrics.coronaLastHour = coronaDebugStats.lastHour || 0;
    metrics.coronaRejectedByVisibility = coronaDebugStats.rejectedByVisibility || 0;
    metrics.coronaRejectedByDistance = coronaDebugStats.rejectedByDistance || 0;
    metrics.coronaRejectedByBudget = coronaDebugStats.rejectedByBudget || 0;
    metrics.coronaRejectedByLos = coronaDebugStats.rejectedByLos || 0;
    metrics.coronaRejectedByScreen = coronaDebugStats.rejectedByScreen || 0;
    metrics.coronaRejectedByTexture = coronaDebugStats.rejectedByTexture || 0;
    metrics.shadowUpdateCpuMs = shadowUpdateCpuMs;
    metrics.frameComposerCpuMs = endCpuProfile(profileEnabled, frameComposerStartMs);
    metrics.frameWaterUpdateCpuMs = passCpuMetrics.waterUpdateCpuMs ?? 0;
    metrics.frameWaterFarCpuMs = passCpuMetrics.waterFarCpuMs ?? 0;
    metrics.frameWaterNearCpuMs = passCpuMetrics.waterNearCpuMs ?? 0;
    metrics.frameWaterWavyCpuMs = passCpuMetrics.waterWavyCpuMs ?? 0;
    metrics.frameWaterWakeCpuMs = passCpuMetrics.waterWakeCpuMs ?? 0;
    metrics.frameShadowRenderCpuMs = passCpuMetrics.shadowRenderCpuMs ?? 0;
    metrics.frameCoronaRenderCpuMs = passCpuMetrics.coronaRenderCpuMs ?? 0;
  }
}

export default FrameComposer;
