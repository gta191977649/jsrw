export function createRenderHostState() {
  return {
    surface: {
      rendererHost: null,
      renderer: null,
      rendererReady: false,
      cancelled: false,
      mounted: true,
      backendRuntimeFailed: false,
      rafId: 0,
    },
    sceneCamera: {
      scene: null,
      camera: null,
      orbitControls: null,
      playerController: null,
      playerModeManager: null,
      updateLookFromAngles: null,
      syncAnglesFromCamera: null,
      hudScene: null,
      hudCamera: null,
      iconTextures: null,
      gameIconSprite: null,
      sun: null,
      hemi: null,
      grid: null,
      axes: null,
    },
    sky: {
      skyScene: null,
      skyCamera: null,
      skyMaterial: null,
      skyCloudScene: null,
      lowCloudSprites: [],
      fluffyCloudSprites: [],
      fluffyCloudTexture: null,
      fluffyHighlightSprites: [],
      fluffyHighlightTexture: null,
      skyFeature: null,
    },
    frameTelemetry: {
      drawingBufferSize: null,
    },
  };
}

export function syncRenderHostRefs(renderHostState, refs = {}) {
  const { surface, sceneCamera, sky } = renderHostState || {};
  if (refs.rendererHostRef) refs.rendererHostRef.current = surface?.rendererHost || null;
  if (refs.rendererRef) refs.rendererRef.current = surface?.renderer || null;
  if (refs.sceneRef) refs.sceneRef.current = sceneCamera?.scene || null;
  if (refs.cameraRef) refs.cameraRef.current = sceneCamera?.camera || null;
  if (refs.skySceneRef) refs.skySceneRef.current = sky?.skyScene || null;
  if (refs.skyCameraRef) refs.skyCameraRef.current = sky?.skyCamera || null;
  if (refs.skyMaterialRef) refs.skyMaterialRef.current = sky?.skyMaterial || null;
  if (refs.skyCloudSceneRef) refs.skyCloudSceneRef.current = sky?.skyCloudScene || null;
  if (refs.lowCloudSpritesRef) refs.lowCloudSpritesRef.current = sky?.lowCloudSprites || [];
  if (refs.fluffyCloudSpritesRef) refs.fluffyCloudSpritesRef.current = sky?.fluffyCloudSprites || [];
  if (refs.fluffyCloudTextureRef) refs.fluffyCloudTextureRef.current = sky?.fluffyCloudTexture || null;
  if (refs.fluffyHighlightSpritesRef) refs.fluffyHighlightSpritesRef.current = sky?.fluffyHighlightSprites || [];
  if (refs.fluffyHighlightTextureRef) refs.fluffyHighlightTextureRef.current = sky?.fluffyHighlightTexture || null;
  if (refs.skyFeatureRef) refs.skyFeatureRef.current = sky?.skyFeature || null;
  if (refs.gridRef) refs.gridRef.current = sceneCamera?.grid || null;
  if (refs.axesRef) refs.axesRef.current = sceneCamera?.axes || null;
  if (refs.sunLightRef) refs.sunLightRef.current = sceneCamera?.sun || null;
  if (refs.hemiLightRef) refs.hemiLightRef.current = sceneCamera?.hemi || null;
}

export function resetRenderHostRefs(refs = {}) {
  syncRenderHostRefs(createRenderHostState(), refs);
}
