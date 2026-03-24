import { formatConsoleArg } from '../../lib/console.js';
import { normalizePath } from '../../lib/jsrw/gta/loaders/SectionLoader.js';
import { buildFileIndex } from '../../lib/jsrw/utils/fileIndex.js';
import { expandZipArchive } from '../../lib/jsrw/utils/mapArchive.js';

export function createResourceCacheState() {
  return {
    rawAssetCache: new Map(),
    parsedTxdCache: new Map(),
    modelTemplateCache: new Map(),
    missingDff: new Set(),
    missingTxd: new Set(),
  };
}

export function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

export function yieldToNextTask() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function createAppSessionController(options = {}) {
  const {
    activeBackend,
    clearObjectSelectionHighlight,
    fileInputRef,
    zipInputRef,
    gtaSessionRef,
    refs = {},
    setters = {},
    callbacks = {},
  } = options;

  const {
    activeFadeCountRef,
    activeRenderChunksRef,
    bigBuildingItemsRef,
    buildActiveRef,
    buildTokenRef,
    cameraRef,
    chunkOcclusionStateRef,
    fileIndexRef,
    frameVisibilityRef,
    lastPipelineSelectionSignatureRef,
    lodUpdateStateRef,
    renderChunkLookupRef,
    renderChunksRef,
    renderItemsRef,
    renderMetricsRef,
    renderResourcesReadyRef,
    resourceCacheRef,
    rwRenderQueueRef,
    selectedInstanceHighlightRef,
    selectedObjectRef,
    selectedObjectRootRef,
    selectedTextureDetailRef,
    streamingBuildRef,
    timecycleDataRef,
    timecycleStateRef,
    totalObjectsRef,
    uiStateRef,
    worldGameVersionRef,
    worldRootRef,
  } = refs;

  const {
    setBuildProgress,
    setFailedModels,
    setLoadedFiles,
    setSelectedObject,
    setSelectedTextureDetail,
    setShowGameIcon,
    setShowMapPickerFallback,
    setStats,
    setStatus,
  } = setters;

  const {
    pushConsoleLine,
    pushFailedModel,
    pushLoadedFile,
    pushLoadedFileConsoleEvent,
    resetImguiTextureCache,
    setResolvedParticleTextures,
  } = callbacks;

  const applyImportedEntries = (entries, options = {}) => {
    const index = buildFileIndex(entries);
    fileIndexRef.current = index;
    pushConsoleLine('info', options.consoleMessage || `Map indexed: ${index.count} files`);
    setStats((prev) => ({ ...prev, files: index.count }));
    setShowMapPickerFallback(false);
    setStatus(options.statusMessage || `Indexed ${index.count} files. Click Build World.`);
    return index;
  };

  const importZipMap = async (archiveFile, options = {}) => {
    const sourceLabel = options.sourceLabel || archiveFile?.name || 'archive.zip';
    setStatus(`Loading ${sourceLabel}...`);
    pushConsoleLine('info', `Reading zip archive: ${sourceLabel}`);
    try {
      const entries = await expandZipArchive(archiveFile);
      return applyImportedEntries(entries, {
        consoleMessage: `Zip indexed: ${sourceLabel} (${entries.length} files)`,
        statusMessage: `Indexed ${entries.length} files from ${sourceLabel}. Click Build World.`,
      });
    } catch (error) {
      setStatus(`Failed to load ${sourceLabel}.`);
      pushConsoleLine('error', `Zip import failed: ${sourceLabel} | ${formatConsoleArg(error)}`);
      return null;
    }
  };

  const onPickFolder = (event) => {
    const input = event.target;
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length === 0) return;
    applyImportedEntries(files, {
      consoleMessage: `Folder indexed: ${files.length} files`,
      statusMessage: `Indexed ${files.length} files. Click Build World.`,
    });
  };

  const onPickZip = async (event) => {
    const input = event.target;
    const archiveFile = input.files?.[0] || null;
    input.value = '';
    if (!archiveFile) return;
    await importZipMap(archiveFile);
  };

  const loadDefaultMap = async (sourceUrl, sourceLabel) => {
    setStatus(`Loading ${sourceLabel}...`);
    pushConsoleLine('info', `Fetching default map: ${sourceLabel}`);
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }
      const archiveBuffer = await response.arrayBuffer();
      const archiveFile = new File([archiveBuffer], sourceLabel, {
        lastModified: Date.now(),
        type: 'application/zip',
      });
      await importZipMap(archiveFile, { sourceLabel });
    } catch (error) {
      setStatus(`Failed to load ${sourceLabel}.`);
      pushConsoleLine('error', `Default map load failed: ${sourceLabel} | ${formatConsoleArg(error)}`);
    }
  };

  const openMapPicker = (source = 'dom') => {
    const input = fileInputRef.current;
    if (!input) return false;

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS/i.test(ua);

    input.value = '';

    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        setShowMapPickerFallback(false);
        return true;
      }
    } catch {
      // Safari may reject showPicker/click outside a trusted DOM gesture.
    }

    try {
      input.click();
      if (source !== 'imgui' || !isSafari) {
        setShowMapPickerFallback(false);
      } else {
        setShowMapPickerFallback(true);
        setStatus('Safari may block file dialogs from the ImGui menu. Click the HUD folder picker below.');
      }
      return true;
    } catch {
      if (isSafari) {
        setShowMapPickerFallback(true);
        setStatus('Safari blocked the ImGui file dialog. Click the HUD folder picker below.');
      }
      return false;
    }
  };

  const openZipPicker = () => {
    const input = zipInputRef.current;
    if (!input) return false;

    input.value = '';

    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        return true;
      }
    } catch {
      // Some browsers only allow file pickers from trusted DOM gestures.
    }

    try {
      input.click();
      return true;
    } catch {
      setStatus('Browser blocked the zip file dialog. Use the HUD zip picker below.');
      return false;
    }
  };

  const clearWorld = () => {
    streamingBuildRef.current = {
      token: buildTokenRef.current,
      running: false,
      queue: [],
      queuedKeys: new Set(),
      context: null,
      startedAt: 0,
      firstChunkReadyAt: 0,
    };
    setResolvedParticleTextures?.(null);
    resourceCacheRef.current = createResourceCacheState();
    gtaSessionRef.current.clearWorld({
      activeBackend,
      activeFadeCountRef,
      activeRenderChunksRef,
      bigBuildingItemsRef,
      buildTokenRef,
      chunkOcclusionStateRef,
      clearObjectSelectionHighlight,
      frameVisibilityRef,
      lastPipelineSelectionSignatureRef,
      lodUpdateStateRef,
      pushConsoleLine,
      renderChunkLookupRef,
      renderChunksRef,
      renderItemsRef,
      renderMetricsRef,
      renderResourcesReadyRef,
      resetImguiTextureCache,
      rwRenderQueueRef,
      selectedInstanceHighlightRef,
      selectedObjectRef,
      selectedObjectRootRef,
      selectedTextureDetailRef,
      setBuildProgress,
      setFailedModels,
      setSelectedObject,
      setSelectedTextureDetail,
      setShowGameIcon,
      setStats,
      timecycleDataRef,
      timecycleStateRef,
      uiStateRef,
      worldGameVersionRef,
      worldRootRef,
    });
  };

  const rebuildWorld = async () => {
    await gtaSessionRef.current.buildWorld({
      activeBackend,
      activeRenderChunksRef,
      bigBuildingItemsRef,
      buildActiveRef,
      buildTokenRef,
      cameraRef,
      clearWorld,
      fileIndexRef,
      lastPipelineSelectionSignatureRef,
      lodUpdateStateRef,
      renderChunkLookupRef,
      renderChunksRef,
      renderItemsRef,
      renderResourcesReadyRef,
      rwRenderQueueRef,
      setBuildProgress,
      setFailedModels,
      setLoadedFiles,
      setShowGameIcon,
      setStats,
      setStatus,
      timecycleDataRef,
      timecycleStateRef,
      totalObjectsRef,
      uiStateRef,
      worldGameVersionRef,
      worldRootRef,
      yieldToBrowser,
      yieldToNextTask,
      onParticleTexturesResolved: setResolvedParticleTextures,
      pushConsoleLine,
      pushFailedModel,
      pushLoadedFile,
      pushLoadedFileConsoleEvent,
    });
  };

  return {
    applyImportedEntries,
    clearWorld,
    importZipMap,
    loadDefaultMap,
    onPickFolder,
    onPickZip,
    openMapPicker,
    openZipPicker,
    rebuildWorld,
  };
}

export function pushLoadedFileEntry(list, kind, path, detail = '') {
  const normalizedKind = String(kind || '').trim().toUpperCase();
  const rawPath = String(path || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const normalizedPath = normalizePath(rawPath);
  const normalizedDetail = String(detail || '').trim();
  if (!normalizedKind || !normalizedPath) return list;

  const index = list.findIndex((entry) => (
    entry.kind === normalizedKind
    && entry.normalizedPath === normalizedPath
  ));

  if (index === -1) {
    return [...list, {
      kind: normalizedKind,
      path: rawPath,
      normalizedPath,
      detail: normalizedDetail,
    }];
  }

  if (list[index].detail === normalizedDetail) return list;

  const next = [...list];
  next[index] = {
    ...next[index],
    path: rawPath || next[index].path,
    normalizedPath,
    detail: normalizedDetail,
  };
  return next;
}
