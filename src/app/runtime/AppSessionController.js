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

function formatByteRate(bytesPerSecond) {
  const value = Math.max(0, Number(bytesPerSecond) || 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${Math.round(value)} B/s`;
}

async function readResponseWithProgress(response, onProgress) {
  const total = Math.max(0, Number(response.headers.get('content-length')) || 0);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    onProgress?.({
      active: true,
      loaded: buffer.byteLength,
      total,
      speedBytesPerSecond: 0,
      speedLabel: formatByteRate(0),
      indeterminate: total <= 0,
    });
    return buffer;
  }

  const chunks = [];
  let loaded = 0;
  let chunkCount = 0;
  const startedAt = performance.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    chunkCount += 1;
    const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
    const speedBytesPerSecond = loaded / elapsedSeconds;
    onProgress?.({
      active: true,
      loaded,
      total,
      speedBytesPerSecond,
      speedLabel: formatByteRate(speedBytesPerSecond),
      indeterminate: total <= 0,
      chunkCount,
    });
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
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
    worldOpaqueRootRef,
  } = refs;

  const {
    setBuildProgress,
    setFailedModels,
    setLoadedFiles,
    setSelectedObject,
    setSelectedTextureDetail,
    setShowGameIcon,
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
    setDefaultMapDownload,
  } = callbacks;

  const applyImportedEntries = (entries, options = {}) => {
    const index = buildFileIndex(entries);
    fileIndexRef.current = index;
    pushConsoleLine('info', options.consoleMessage || `Map indexed: ${index.count} files`);
    setStats((prev) => ({ ...prev, files: index.count }));
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
    setDefaultMapDownload?.({
      active: true,
      label: sourceLabel,
      loaded: 0,
      total: 0,
      speedBytesPerSecond: 0,
      speedLabel: formatByteRate(0),
      indeterminate: true,
    });
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }
      const archiveBuffer = await readResponseWithProgress(response, (progress) => {
        setDefaultMapDownload?.({
          ...progress,
          label: sourceLabel,
        });
        const percent = progress.total > 0
          ? `${Math.floor((progress.loaded / Math.max(progress.total, 1)) * 100)}%`
          : `${Math.round(progress.loaded / 1024)} KB`;
        setStatus(`Downloading ${sourceLabel}... ${percent} @ ${progress.speedLabel}`);
      });
      const archiveFile = new File([archiveBuffer], sourceLabel, {
        lastModified: Date.now(),
        type: 'application/zip',
      });
      await importZipMap(archiveFile, { sourceLabel });
    } catch (error) {
      setStatus(`Failed to load ${sourceLabel}.`);
      pushConsoleLine('error', `Default map load failed: ${sourceLabel} | ${formatConsoleArg(error)}`);
    } finally {
      setDefaultMapDownload?.({
        active: false,
        label: sourceLabel,
        loaded: 0,
        total: 0,
        speedBytesPerSecond: 0,
        speedLabel: '',
        indeterminate: false,
      });
    }
  };

  const openMapPicker = () => {
    const input = fileInputRef.current;
    if (!input) return false;

    input.value = '';

    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        return true;
      }
    } catch {
      // Some browsers may reject showPicker outside a trusted DOM gesture.
    }

    try {
      input.click();
      return true;
    } catch {
      setStatus('Browser blocked the folder dialog from the ImGui menu.');
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
      setStatus('Browser blocked the zip file dialog from the ImGui menu.');
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
      worldOpaqueRootRef,
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
      worldOpaqueRootRef,
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
