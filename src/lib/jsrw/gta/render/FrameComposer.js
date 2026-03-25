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

function getProfilingTimeNow() {
  return globalThis.performance?.now?.() ?? Date.now();
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
    const {
      renderer,
      rendererHost,
      scene,
      camera,
      activeBackend,
      worldGameVersionRef,
      uiStateRef,
      worldRootRef,
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
      hudScene,
      hudCamera,
      gameIconSprite,
      iconTextures,
      showGameIcon,
      pushConsoleLine,
      setStatus,
      postFxDebugCapture = false,
      render2dfxEnabled = true,
      grid,
      axes,
    } = context;

    if (!renderer || !scene || !camera) return;
    const frameCpuStart = getProfilingTimeNow();
    const frameStartStats = takeRenderStatsSnapshot(renderer);

    const stageWorldStats = { drawCalls: 0, triangles: 0 };
    const stageWaterStats = { drawCalls: 0, triangles: 0 };
    const stageSkyStats = { drawCalls: 0, triangles: 0 };
    const skyCloudPassStats = { drawCalls: 0, triangles: 0 };
    let skyCloudsPassInvoked = false;
    let queuePrepareCpuMs = 0;
    let coronaUpdateCpuMs = 0;
    let coronaRenderCpuMs = 0;
    let shadowUpdateCpuMs = 0;
    let shadowRenderCpuMs = 0;
    let waterUpdateCpuMs = 0;
    let waterRenderCpuMs = 0;
    let sceneOpaqueCpuMs = 0;
    let sceneTransparentCpuMs = 0;
    let skyCpuMs = 0;
    let postFxCpuMs = 0;
    let hudCpuMs = 0;
    const renderStages = uiStateRef.current.renderStages || {};
    const wantsTransparentStages = Boolean(
      renderStages.sceneTransparent
      && (renderStages.sceneBlend || renderStages.sceneAdditive || renderStages.sceneOverlay),
    );
    const wantsWaterStages = Boolean(
      renderStages.waterFar
      || renderStages.waterNear
      || renderStages.waterWavy
      || renderStages.waterWake,
    );
    const wantsCoronaStage = Boolean(render2dfxEnabled && renderStages.coronas);
    const wantsShadowStage = Boolean(
      render2dfxEnabled
      && uiStateRef.current.shadows.enabled
      && (renderStages.sceneOpaque || wantsWaterStages),
    );
    const needsQueuePreparation = Boolean(renderStages.sceneOpaque || wantsTransparentStages);

    if (grid) grid.visible = uiStateRef.current.showGrid;
    if (axes) axes.visible = uiStateRef.current.showAxes;
    if (lastWireframeRef.current !== uiStateRef.current.wireframe) {
      applyWireframe(worldRootRef.current, uiStateRef.current.wireframe);
      this.rendererSession?.getWaterRuntime?.()?.setWireframe(uiStateRef.current.wireframe);
      lastWireframeRef.current = uiStateRef.current.wireframe;
    }
    if (lastDisableVertexColorRef.current !== uiStateRef.current.disableVertexColor) {
      applyDisableVertexColor(worldRootRef.current, uiStateRef.current.disableVertexColor);
      lastDisableVertexColorRef.current = uiStateRef.current.disableVertexColor;
    }
    if (lastDisableBackfaceCullingRef.current !== uiStateRef.current.disableBackfaceCulling) {
      applyGlobalBackfaceCulling(worldRootRef.current, uiStateRef.current.disableBackfaceCulling);
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
      applyWireframe(worldRootRef.current, uiStateRef.current.wireframe);
      applyDisableVertexColor(worldRootRef.current, uiStateRef.current.disableVertexColor);
      applyGlobalBackfaceCulling(worldRootRef.current, uiStateRef.current.disableBackfaceCulling);
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
      renderer.autoClear = true;
      return;
    }

    const waterPipeline = this.rendererSession?.getWaterRuntime?.();
    const coronaRuntime = this.rendererSession?.getCoronaRuntime?.();
    const shadowRuntime = this.rendererSession?.getShadowRuntime?.();
    const frameVisibility = frameVisibilityRef.current;
    const frameVisibilityComputed = frameVisibility?.computed === true;
    const hasCoronaCandidates = (frameVisibility?.coronaCandidates?.length || 0) > 0;
    const hasShadowCandidates = (frameVisibility?.shadowCandidates?.length || 0) > 0;
    const shouldUpdateCoronas = wantsCoronaStage
      && (!frameVisibilityComputed || hasCoronaCandidates || coronaRuntime?.hasActiveEntries?.());
    const shouldUpdateShadows = wantsShadowStage
      && (!frameVisibilityComputed || hasShadowCandidates || shadowRuntime?.hasActiveEntries?.());

    coronaRuntime?.setEnabled(wantsCoronaStage);
    shadowRuntime?.setEnabled(wantsShadowStage);
    coronaRuntime?.setDebugShowAll(uiStateRef.current.debug2dfx);
    if (wantsWaterStages) {
      waterPipeline?.applySettings?.({
        uvSpeed: uiStateRef.current.waterUvSpeed,
        waveHeight: uiStateRef.current.waterWaveHeight,
        farAlpha: uiStateRef.current.waterAlpha,
      });
    }
    if (shouldUpdateCoronas) {
      const coronaUpdateStart = getProfilingTimeNow();
      coronaRuntime?.setViewport?.(viewportWidth, viewportHeight);
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
      coronaUpdateCpuMs += Math.max(0, getProfilingTimeNow() - coronaUpdateStart);
    }
    if (shouldUpdateShadows) {
      const shadowUpdateStart = getProfilingTimeNow();
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
      shadowUpdateCpuMs += Math.max(0, getProfilingTimeNow() - shadowUpdateStart);
    }

    const farBackgroundColor = skyBottomColor;
    const rwRenderQueue = rwRenderQueueRef.current;
    const postFxSceneTarget = renderStages.postFx
      ? this.rendererSession?.beginPostFxSceneCapture?.({
        ...pipelineRuntimeContext,
        viewportWidth,
        viewportHeight,
      })
      : null;
    if (needsQueuePreparation) {
      const queuePrepareStart = getProfilingTimeNow();
      rwRenderQueue?.prepareFrame?.(camera, frameVisibility);
      queuePrepareCpuMs += Math.max(0, getProfilingTimeNow() - queuePrepareStart);
    }
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
      const skyStageStart = getProfilingTimeNow();
      const beforeSkyDome = takeRenderStatsSnapshot(renderer);
      renderer.render(skyScene, skyCamera);
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeSkyDome);
      skyCpuMs += Math.max(0, getProfilingTimeNow() - skyStageStart);
    } else {
      renderer.setClearColor(farBackgroundColor, 1);
      renderer.clear(true, true, true);
    }
    renderer.autoClear = false;
    renderer.clearDepth();
    if (renderStages.skyBackdrop) {
      const skyStageStart = getProfilingTimeNow();
      const beforeBackdrop = takeRenderStatsSnapshot(renderer);
      skyFeature?.renderBackground?.(renderer);
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeBackdrop);
      skyCpuMs += Math.max(0, getProfilingTimeNow() - skyStageStart);
    }
    if (renderStages.skyClouds && skyCloudScene) {
      const skyStageStart = getProfilingTimeNow();
      const beforeClouds = takeRenderStatsSnapshot(renderer);
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
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeClouds);
      accumulateRenderStatsDelta(renderer, skyCloudPassStats, beforeClouds);
      renderer.clearDepth();
      skyCpuMs += Math.max(0, getProfilingTimeNow() - skyStageStart);
    }

    const renderOpaqueAndTransparent = (allowWater = false) => {
      renderer.autoClear = false;
      if (allowWater && waterPipeline?.hasRenderableWater?.() && uiStateRef.current.renderWater) {
        const shouldRunWaterPipeline = wantsWaterStages;
        let waterStage = 'update';
        try {
          if (shouldRunWaterPipeline) {
            const waterUpdateStart = getProfilingTimeNow();
            waterPipeline.update(camera, context.timeMs, context.dt);
            waterUpdateCpuMs += Math.max(0, getProfilingTimeNow() - waterUpdateStart);
          }

          if (renderStages.sceneOpaque) {
            waterStage = 'renderSceneOpaque';
            const opaqueStageStart = getProfilingTimeNow();
            const beforeOpaque = takeRenderStatsSnapshot(renderer);
            rwRenderQueue?.renderOpaque?.(renderer, camera, {
              allowedBuckets: ['opaque', 'cutout'],
              fog: scene.fog || null,
            });
            accumulateRenderStatsDelta(renderer, stageWorldStats, beforeOpaque);
            sceneOpaqueCpuMs += Math.max(0, getProfilingTimeNow() - opaqueStageStart);
          }

          if (renderStages.waterFar) {
            waterStage = 'renderFar';
            const waterRenderStart = getProfilingTimeNow();
            const beforeWaterFar = takeRenderStatsSnapshot(renderer);
            waterPipeline.renderFar(renderer, camera, null);
            accumulateRenderStatsDelta(renderer, stageWaterStats, beforeWaterFar);
            waterRenderCpuMs += Math.max(0, getProfilingTimeNow() - waterRenderStart);
          }

          if (renderStages.waterNear) {
            waterStage = 'renderNear';
            const waterRenderStart = getProfilingTimeNow();
            const beforeWaterNear = takeRenderStatsSnapshot(renderer);
            waterPipeline.renderNear(renderer, camera);
            accumulateRenderStatsDelta(renderer, stageWaterStats, beforeWaterNear);
            waterRenderCpuMs += Math.max(0, getProfilingTimeNow() - waterRenderStart);
          }

          if (renderStages.waterWavy) {
            waterStage = 'renderWavy';
            const waterRenderStart = getProfilingTimeNow();
            const beforeWaterWavy = takeRenderStatsSnapshot(renderer);
            waterPipeline.renderWavy(renderer, camera);
            accumulateRenderStatsDelta(renderer, stageWaterStats, beforeWaterWavy);
            waterRenderCpuMs += Math.max(0, getProfilingTimeNow() - waterRenderStart);
          }

          if (renderStages.waterWake) {
            waterStage = 'renderWake';
            const waterRenderStart = getProfilingTimeNow();
            const beforeWaterWake = takeRenderStatsSnapshot(renderer);
            waterPipeline.renderWake(renderer, camera);
            accumulateRenderStatsDelta(renderer, stageWaterStats, beforeWaterWake);
            waterRenderCpuMs += Math.max(0, getProfilingTimeNow() - waterRenderStart);
          }

          if (wantsShadowStage) {
            const shadowRenderStart = getProfilingTimeNow();
            const beforeShadows = takeRenderStatsSnapshot(renderer);
            shadowRuntime?.render?.(renderer, camera);
            accumulateRenderStatsDelta(renderer, stageWorldStats, beforeShadows);
            shadowRenderCpuMs += Math.max(0, getProfilingTimeNow() - shadowRenderStart);
          }
          if (transparentBuckets.length > 0) {
            waterStage = 'renderSceneTransparent';
            const transparentStageStart = getProfilingTimeNow();
            const beforeTransparent = takeRenderStatsSnapshot(renderer);
            rwRenderQueue?.renderTransparent?.(renderer, camera, {
              allowedBuckets: transparentBuckets,
              fog: scene.fog || null,
            });
            accumulateRenderStatsDelta(renderer, stageWorldStats, beforeTransparent);
            sceneTransparentCpuMs += Math.max(0, getProfilingTimeNow() - transparentStageStart);
          }
          if (renderStages.coronas) {
            const coronaRenderStart = getProfilingTimeNow();
            const beforeCoronas = takeRenderStatsSnapshot(renderer);
            coronaRuntime?.render?.(renderer, camera);
            accumulateRenderStatsDelta(renderer, stageWorldStats, beforeCoronas);
            coronaRenderCpuMs += Math.max(0, getProfilingTimeNow() - coronaRenderStart);
          }
          renderer.autoClear = true;
          return;
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
          const opaqueStageStart = getProfilingTimeNow();
          const beforeOpaque = takeRenderStatsSnapshot(renderer);
          rwRenderQueue?.renderOpaque?.(renderer, camera, {
            allowedBuckets: opaqueBuckets,
            fog: scene.fog || null,
          });
          accumulateRenderStatsDelta(renderer, stageWorldStats, beforeOpaque);
          sceneOpaqueCpuMs += Math.max(0, getProfilingTimeNow() - opaqueStageStart);
        }
        if (wantsShadowStage) {
          const shadowRenderStart = getProfilingTimeNow();
          const beforeShadows = takeRenderStatsSnapshot(renderer);
          shadowRuntime?.render?.(renderer, camera);
          accumulateRenderStatsDelta(renderer, stageWorldStats, beforeShadows);
          shadowRenderCpuMs += Math.max(0, getProfilingTimeNow() - shadowRenderStart);
        }
        if (transparentSceneBuckets.length > 0) {
          const transparentStageStart = getProfilingTimeNow();
          const beforeTransparent = takeRenderStatsSnapshot(renderer);
          rwRenderQueue?.renderTransparent?.(renderer, camera, {
            allowedBuckets: transparentSceneBuckets,
            fog: scene.fog || null,
          });
          accumulateRenderStatsDelta(renderer, stageWorldStats, beforeTransparent);
          sceneTransparentCpuMs += Math.max(0, getProfilingTimeNow() - transparentStageStart);
        }
      } else if (wantsShadowStage) {
        const shadowRenderStart = getProfilingTimeNow();
        const beforeShadows = takeRenderStatsSnapshot(renderer);
        shadowRuntime?.render?.(renderer, camera);
        accumulateRenderStatsDelta(renderer, stageWorldStats, beforeShadows);
        shadowRenderCpuMs += Math.max(0, getProfilingTimeNow() - shadowRenderStart);
      }
      if (renderStages.coronas) {
        const coronaRenderStart = getProfilingTimeNow();
        const beforeCoronas = takeRenderStatsSnapshot(renderer);
        coronaRuntime?.render?.(renderer, camera);
        accumulateRenderStatsDelta(renderer, stageWorldStats, beforeCoronas);
        coronaRenderCpuMs += Math.max(0, getProfilingTimeNow() - coronaRenderStart);
      }
    };

    renderOpaqueAndTransparent(true);

    if (postFxSceneTarget && postFxSunCoronaEnabled && renderStages.sunBloom) {
      const skyStageStart = getProfilingTimeNow();
      renderer.clearDepth();
      const beforeSunBloom = takeRenderStatsSnapshot(renderer);
      skyFeature?.renderSun?.(renderer, { mode: 'bloom' });
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeSunBloom);
      skyCpuMs += Math.max(0, getProfilingTimeNow() - skyStageStart);
    }
    renderer.setRenderTarget(null);
    if (postFxSceneTarget) {
      const postFxStart = getProfilingTimeNow();
      this.rendererSession?.renderPostFx?.(renderer, {
        ...pipelineRuntimeContext,
        viewportWidth,
        viewportHeight,
      });
      postFxCpuMs += Math.max(0, getProfilingTimeNow() - postFxStart);
    }
    if (renderStages.sunFinal) {
      const skyStageStart = getProfilingTimeNow();
      renderer.clearDepth();
      const beforeSunFinal = takeRenderStatsSnapshot(renderer);
      skyFeature?.renderSun?.(renderer, { mode: 'full' });
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeSunFinal);
      skyCpuMs += Math.max(0, getProfilingTimeNow() - skyStageStart);
    }

    const activeIcon = uiStateRef.current.gameVersion === 'SA' ? 'SA' : 'VCS';
    gameIconSprite.material.map = iconTextures[activeIcon];
    gameIconSprite.visible = showGameIcon;
    const iconPx = 80;
    const padXPx = 20;
    const padYPx = 56;
    gameIconSprite.position.set(
      1 - ((2 * padXPx) / viewportWidth),
      1 - ((2 * padYPx) / viewportHeight),
      0,
    );
    gameIconSprite.scale.set(
      (2 * iconPx) / viewportWidth,
      (2 * iconPx) / viewportHeight,
      1,
    );
    if (renderStages.hud) {
      const hudStart = getProfilingTimeNow();
      renderer.autoClear = false;
      renderer.clearDepth();
      const beforeHud = takeRenderStatsSnapshot(renderer);
      renderer.render(hudScene, hudCamera);
      accumulateRenderStatsDelta(renderer, stageSkyStats, beforeHud);
      renderer.autoClear = true;
      hudCpuMs += Math.max(0, getProfilingTimeNow() - hudStart);
    }

    const rendererRuntimeInfo = rendererHost?.getRuntimeInfo?.() || null;
    const sessionStats = this.rendererSession?.getStats?.() || null;
    const frameEndStats = takeRenderStatsSnapshot(renderer);
    const frameCpuMs = Math.max(0, getProfilingTimeNow() - frameCpuStart);
    renderMetricsRef.current = {
      ...renderMetricsRef.current,
      rendererBackend: rendererRuntimeInfo?.backend || String(activeBackend || 'UNKNOWN').toUpperCase(),
      rendererActualBackend: rendererRuntimeInfo?.actualBackend || 'unknown',
      rendererCurrentSamples: rendererRuntimeInfo?.currentSamples ?? 0,
      rendererOutputBufferType: rendererRuntimeInfo?.outputBufferType || 'unknown',
      pipelineActiveMaterials: sessionStats?.pipeline?.activeMaterialCount ?? 0,
      pipelineCachedMaterials: sessionStats?.pipeline?.cachedMaterialCount ?? 0,
      opaqueQueue: rwRenderQueueRef.current?.debugStats?.opaqueCount ?? 0,
      cutoutQueue: rwRenderQueueRef.current?.debugStats?.cutoutCount ?? 0,
      transparentQueue: rwRenderQueueRef.current?.debugStats?.transparentCount ?? 0,
      additiveQueue: rwRenderQueueRef.current?.debugStats?.additiveCount ?? 0,
      overlayQueue: rwRenderQueueRef.current?.debugStats?.overlayCount ?? 0,
      queueMeshCount: rwRenderQueueRef.current?.debugStats?.frameMeshCount ?? 0,
      drawCalls: Math.max(0, frameEndStats.calls - frameStartStats.calls),
      triangles: Math.max(0, frameEndStats.triangles - frameStartStats.triangles),
      worldDrawCalls: stageWorldStats.drawCalls,
      worldTriangles: stageWorldStats.triangles,
      waterDrawCalls: stageWaterStats.drawCalls,
      waterTriangles: stageWaterStats.triangles,
      waterVisibleFarCells: sessionStats?.water?.visibleFarCells ?? 0,
      waterVisibleFarCoarseCells: sessionStats?.water?.visibleFarCoarseCells ?? 0,
      skyDrawCalls: stageSkyStats.drawCalls,
      skyTriangles: stageSkyStats.triangles,
      skyCloudsPassInvoked,
      skyCloudsPassDrawCalls: skyCloudPassStats.drawCalls,
      skyCloudsPassTriangles: skyCloudPassStats.triangles,
      frameCpuMs,
      queuePrepareCpuMs,
      coronaUpdateCpuMs,
      coronaRenderCpuMs,
      shadowUpdateCpuMs,
      shadowRenderCpuMs,
      waterUpdateCpuMs,
      waterRenderCpuMs,
      sceneOpaqueCpuMs,
      sceneTransparentCpuMs,
      skyCpuMs,
      postFxCpuMs,
      hudCpuMs,
      coronaSpriteCount: sessionStats?.corona?.spriteCount ?? 0,
      coronaLightCount: sessionStats?.corona?.lightCount ?? 0,
      coronaLosChecks: sessionStats?.corona?.losChecks ?? 0,
      coronaRenderPasses: sessionStats?.corona?.renderPasses ?? 0,
    };
  }
}

export default FrameComposer;
