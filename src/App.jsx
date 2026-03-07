import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { DFFLoader, TXDLoader } from './lib/jsrw';
import { playerController as createExternalPlayerController } from 'three-player-controller';
import { formatConsoleArg } from './lib/console';
import { buildFileIndex } from './lib/fileIndex';
import { WORLD_UP, gtaPlacementQuaternionToThree, gtaPositionToThree } from './lib/gtaTransforms';
import { normalizePath, parseGtaDat, parseIde, parseIpl } from './lib/gtaParsers';
import { IMGParser } from './lib/imgArchive';
import { buildLodMapping, isLodModel } from './lib/lod';
import { PlayerControllerAdapter } from './lib/playerControllerAdapter';
import { APP_MODE_EDITOR, APP_MODE_TEST, PlayerModeManager } from './lib/PlayerModeManager';
import {
  applyDisableVertexColor,
  normalizeTextureDictionary,
  prepareTobjInstanceMaterials,
  toRWMaterial,
  tuneTransparentMaterial,
} from './lib/RWRender';
import { RWRenderQueue } from './lib/RWRenderQueue';
import { RWWaterPipeline } from './lib/RWWaterPipeline';
import { applyRwIdeFlagsToInstance, decodeRwIdeFlags } from './lib/rwFlags';
import {
  applyGlobalBackfaceCulling,
  applyWireframe,
  disposeWorld,
  makeAssetKey,
} from './lib/worldUtils';
import { WINDOW_DEFS } from './ui/windows';
import {
  applyObjectSelectionHighlight,
  clearObjectSelectionHighlight,
  getSelectableRootFromObject,
} from './lib/selection';
import { getWaterConfig, parseWaterproDat } from './lib/waterpro';
import saIcon from './assets/sa.png';
import vcsIcon from './assets/vcs.png';
import './App.css';

const MAX_CONSOLE_LINES = 500;
const MAX_FAILED_MODELS = 5000;

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function App() {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const imguiCanvasRef = useRef(null);
  const fileInputRef = useRef(null);

  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const worldRootRef = useRef(new THREE.Group());
  const rwRenderQueueRef = useRef(null);
  const rwWaterPipelineRef = useRef(null);
  const renderItemsRef = useRef([]);
  const selectedObjectRootRef = useRef(null);
  const selectedObjectRef = useRef(null);
  const selectedTextureDetailRef = useRef(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerNdcRef = useRef(new THREE.Vector2());
  const imguiGlRef = useRef(null);
  const imguiTextureCacheRef = useRef(new WeakMap());
  const imguiTextureListRef = useRef([]);
  const pointerStateRef = useRef({
    down: false,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const gridRef = useRef(null);
  const axesRef = useRef(null);
  const totalObjectsRef = useRef(0);
  const frameTimeRef = useRef(0);
  const fpsHistoryRef = useRef(new Float32Array(180));
  const fpsHistoryIndexRef = useRef(0);
  const lodUpdateAccumulatorRef = useRef(0);
  const lookStateRef = useRef({
    active: false,
    yaw: 0,
    pitch: 0,
    lastX: 0,
    lastY: 0,
  });
  const moveStateRef = useRef({
    forward: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false,
    boost: false,
  });

  const fileIndexRef = useRef(null);
  const buildTokenRef = useRef(0);
  const buildActiveRef = useRef(false);

  const imguiRef = useRef({ ImGui: null, ImGui_Impl: null, ready: false });
  const imguiCaptureRef = useRef({ mouse: false, keyboard: false });
  const backendSwitchingRef = useRef(false);
  const appUnmountingRef = useRef(false);
  const lodUpdateStateRef = useRef({
    needsRefresh: true,
    lastCameraPos: new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN),
    lastDrawDistance: 300,
    lastRenderingDistance: 5000,
    lastShowLods: true,
    lastForceLodOnly: false,
    lastShowTobjs: false,
  });

  const uiStateRef = useRef({
    gameVersion: 'VCS',
    quaternionOrder: 'XYZW',
    drawDistance: 300,
    renderingDistance: 5000,
    showLods: true,
    forceLodOnly: false,
    showTobjs: false,
    showGrid: true,
    showAxes: false,
    wireframe: false,
    disableVertexColor: false,
    disableBackfaceCulling: true,
    renderWater: true,
    waterUvSpeed: 1,
    waterWaveHeight: 35,
    waterNearAlpha: 0.72,
    waterWavyAlpha: 0.82,
    waterWakeAlpha: 0.55,
    waterShowWavy: true,
    waterShowWake: false,
    appMode: APP_MODE_EDITOR,
    backendSelection: 'WebGL',
    windows: Object.fromEntries(WINDOW_DEFS.map((item) => [item.key, item.defaultVisible])),
  });
  const lastWireframeRef = useRef(false);
  const lastDisableVertexColorRef = useRef(false);
  const lastDisableBackfaceCullingRef = useRef(true);
  const lastRenderWaterRef = useRef(true);

  const [status, setStatus] = useState('Select an extracted GTA folder to begin.');
  const [activeBackend, setActiveBackend] = useState('WebGL');
  const [buildProgress, setBuildProgress] = useState({ active: false, current: 0, total: 0 });
  const [showGameIcon, setShowGameIcon] = useState(false);
  const [stats, setStats] = useState({
    files: 0,
    ideFiles: 0,
    iplFiles: 0,
    ideDefs: 0,
    iplInst: 0,
    loaded: 0,
    failed: 0,
    unresolved: 0,
    nearOnly: 0,
  });
  const [consoleLines, setConsoleLines] = useState([]);
  const [failedModels, setFailedModels] = useState([]);
  const [loadedFiles, setLoadedFiles] = useState([]);
  const [selectedObject, setSelectedObject] = useState(null);
  const [selectedTextureDetail, setSelectedTextureDetail] = useState(null);
  const statusRef = useRef(status);
  const statsRef = useRef(stats);
  const buildProgressRef = useRef(buildProgress);
  const showGameIconRef = useRef(showGameIcon);
  const consoleLinesRef = useRef(consoleLines);
  const failedModelsRef = useRef(failedModels);
  const loadedFilesRef = useRef(loadedFiles);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    statsRef.current = stats;
  }, [stats]);

  useEffect(() => {
    buildProgressRef.current = buildProgress;
  }, [buildProgress]);

  useEffect(() => {
    showGameIconRef.current = showGameIcon;
  }, [showGameIcon]);

  useEffect(() => {
    uiStateRef.current.backendSelection = activeBackend;
  }, [activeBackend]);

  useEffect(() => {
    consoleLinesRef.current = consoleLines;
  }, [consoleLines]);

  useEffect(() => {
    failedModelsRef.current = failedModels;
  }, [failedModels]);

  useEffect(() => {
    loadedFilesRef.current = loadedFiles;
  }, [loadedFiles]);
  useEffect(() => {
    selectedObjectRef.current = selectedObject;
  }, [selectedObject]);
  useEffect(() => {
    selectedTextureDetailRef.current = selectedTextureDetail;
  }, [selectedTextureDetail]);

  useEffect(() => () => {
    appUnmountingRef.current = true;
  }, []);

  const pushConsoleLine = useCallback((level, message, source = 'app') => {
    setConsoleLines((prev) => {
      const next = [...prev, {
        ts: new Date().toLocaleTimeString(),
        level,
        source,
        message,
      }];
      return next.length > MAX_CONSOLE_LINES ? next.slice(next.length - MAX_CONSOLE_LINES) : next;
    });
  }, []);

  const pushLoadedFile = useCallback((kind, path, detail = '') => {
    const normalizedKind = String(kind || '').trim().toUpperCase();
    const normalizedPath = normalizePath(String(path || '').trim());
    const normalizedDetail = String(detail || '').trim();
    if (!normalizedKind || !normalizedPath) return;
    setLoadedFiles((prev) => {
      const index = prev.findIndex((entry) => (
        entry.kind === normalizedKind
        && entry.path === normalizedPath
      ));
      if (index === -1) {
        return [...prev, { kind: normalizedKind, path: normalizedPath, detail: normalizedDetail }];
      }
      if (prev[index].detail === normalizedDetail) return prev;
      const next = [...prev];
      next[index] = { ...next[index], detail: normalizedDetail };
      return next;
    });
  }, []);

  const pushFailedModel = useCallback((text) => {
    const line = String(text || '').trim();
    if (!line) return;
    setFailedModels((prev) => {
      const next = [...prev, line];
      return next.length > MAX_FAILED_MODELS ? next.slice(next.length - MAX_FAILED_MODELS) : next;
    });
  }, []);

  const isWindowOpen = useCallback((key) => Boolean(uiStateRef.current.windows[key]), []);
  const setWindowOpen = useCallback((key, value) => {
    const next = Boolean(value);
    uiStateRef.current.windows[key] = next;
    return next;
  }, []);

  useEffect(() => {
    const originalLog = console.log.bind(console);
    const originalWarn = console.warn.bind(console);
    const originalError = console.error.bind(console);

    console.log = (...args) => {
      pushConsoleLine('info', args.map(formatConsoleArg).join(' '), 'console');
      originalLog(...args);
    };
    console.warn = (...args) => {
      pushConsoleLine('warn', args.map(formatConsoleArg).join(' '), 'console');
      originalWarn(...args);
    };
    console.error = (...args) => {
      pushConsoleLine('error', args.map(formatConsoleArg).join(' '), 'console');
      originalError(...args);
    };

    const onWindowError = (event) => {
      const message = event?.error ? formatConsoleArg(event.error) : event.message;
      pushConsoleLine('error', message || 'Unknown window error', 'window');
    };
    const onUnhandledRejection = (event) => {
      pushConsoleLine('error', formatConsoleArg(event.reason), 'promise');
    };

    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, [pushConsoleLine]);

  const resetImguiTextureCache = useCallback(() => {
    const gl = imguiGlRef.current;
    if (gl) {
      for (const texture of imguiTextureListRef.current) {
        if (texture) gl.deleteTexture(texture);
      }
    }
    imguiTextureCacheRef.current = new WeakMap();
    imguiTextureListRef.current = [];
  }, []);

  const clearWorld = useCallback(() => {
    if (selectedObjectRootRef.current) {
      clearObjectSelectionHighlight(selectedObjectRootRef.current);
      selectedObjectRootRef.current = null;
    }
    selectedObjectRef.current = null;
    setSelectedObject(null);
    selectedTextureDetailRef.current = null;
    setSelectedTextureDetail(null);
    resetImguiTextureCache();
    const worldRoot = worldRootRef.current;
    disposeWorld(worldRoot);
    rwWaterPipelineRef.current?.dispose();
    rwWaterPipelineRef.current = null;
    renderItemsRef.current = [];
    rwRenderQueueRef.current?.markDirty();
    lodUpdateStateRef.current.needsRefresh = true;
    lodUpdateStateRef.current.lastCameraPos.set(Number.NaN, Number.NaN, Number.NaN);
    setShowGameIcon(false);
    setBuildProgress({ active: false, current: 0, total: 0 });
    setStats((prev) => ({ ...prev, loaded: 0, failed: 0, unresolved: 0, nearOnly: 0 }));
    setFailedModels([]);
    pushConsoleLine('info', 'World cleared');
  }, [pushConsoleLine, resetImguiTextureCache]);

  const rebuildWorld = useCallback(async () => {
    const fileIndex = fileIndexRef.current;
    if (!fileIndex) {
      setStatus('No files loaded. Choose a folder first.');
      pushConsoleLine('warn', 'Build requested without loaded files');
      return;
    }

    const worldRoot = worldRootRef.current;
    const token = ++buildTokenRef.current;
    buildActiveRef.current = true;

    try {
      clearWorld();
      setLoadedFiles([]);
      setFailedModels([]);
      setShowGameIcon(false);
      setStatus('Parsing gta.dat, IDE and IPL...');
      pushConsoleLine('info', 'Start building world');
      await yieldToBrowser();
      const parseStartTime = performance.now();

    const trackAndResolveFile = (kind, pathHint, options = {}) => {
      const {
        declaredDetail = 'declared',
        foundDetail = 'found',
        missingDetail = 'missing',
        warnOnMissing = true,
      } = options;
      const requestedPath = normalizePath(pathHint);
      if (declaredDetail) pushLoadedFile(kind, requestedPath, declaredDetail);
      const file = fileIndex.findByPathHint(requestedPath);
      if (!file) {
        pushLoadedFile(kind, requestedPath, missingDetail);
        if (warnOnMissing) pushConsoleLine('warn', `${kind} missing: ${requestedPath}`);
        return null;
      }
      const resolvedPath = normalizePath(file.webkitRelativePath || file.name || requestedPath);
      pushLoadedFile(kind, resolvedPath, foundDetail);
      return { file, requestedPath, resolvedPath };
    };

      const gtaDatRecord = trackAndResolveFile('DAT', 'data/gta.dat', {
        declaredDetail: 'required',
        foundDetail: 'loaded',
        missingDetail: 'missing',
        warnOnMissing: false,
      });
      const gtaDatFile = gtaDatRecord?.file ?? null;
      if (!gtaDatFile) {
        setStatus('gta.dat not found in uploaded files.');
        pushConsoleLine('error', 'gta.dat not found in selected folder');
        return;
      }

      const gtaDat = parseGtaDat(await gtaDatFile.text());
      pushConsoleLine(
        'info',
        `gta.dat parsed: IDE ${gtaDat.idePaths.length}, IPL ${gtaDat.iplPaths.length}, IMG ${gtaDat.imgPaths?.length || 0}, IMAGEPATH ${gtaDat.imagePaths?.length || 0}`,
      );

      const imgParser = new IMGParser();
      const imgPaths = [];
      const imgPathSet = new Set();
      const registerImgPath = (pathHint) => {
        const normalized = String(pathHint || '').trim().replaceAll('\\', '/').toLowerCase();
        if (!normalized || imgPathSet.has(normalized)) return;
        imgPathSet.add(normalized);
        imgPaths.push(normalized);
      };
      registerImgPath('models/gta3.img');
      for (const path of gtaDat.imgPaths || []) registerImgPath(path);

      for (const imgPath of imgPaths) {
      const imgRecord = trackAndResolveFile('IMG', imgPath, {
        foundDetail: 'found',
        missingDetail: 'missing img',
      });
      if (!imgRecord) {
        continue;
      }
      const dirPath = imgPath.replace(/\.img$/i, '.dir');
      const dirRecord = trackAndResolveFile('DIR', dirPath, {
        foundDetail: 'found',
        missingDetail: 'missing dir',
        warnOnMissing: false,
      });
      if (!dirRecord) {
        pushLoadedFile('IMG', imgPath, 'missing dir');
        pushConsoleLine('warn', `IMG directory missing: ${dirPath}`);
        continue;
      }
      try {
        const parsed = await imgParser.appendArchive(imgRecord.file, dirRecord.file, imgPath);
        pushLoadedFile('IMG', imgPath, `${parsed.total} entries`);
        pushConsoleLine(
          'info',
          `IMG loaded: ${imgPath} (${parsed.total} entries${parsed.overridden > 0 ? `, override ${parsed.overridden}` : ''})`,
        );
      } catch (error) {
        pushConsoleLine('error', `IMG parse failed: ${imgPath} (${formatConsoleArg(error)})`);
      }
      }

      if ((gtaDat.imagePaths || []).length > 0) {
        for (const imagePath of gtaDat.imagePaths) {
          pushLoadedFile('IMAGEPATH', imagePath, 'ignored');
        }
        pushConsoleLine('info', 'IMAGEPATH entries are ignored. Textures are resolved by IDE TXD only.');
      }

      const ideById = new Map();
      const ideByModel = new Map();
      let parsedIdeFiles = 0;

      for (const pathHint of gtaDat.idePaths) {
      const ideRecord = trackAndResolveFile('IDE', pathHint, {
        foundDetail: 'found',
        missingDetail: 'missing',
      });
      if (!ideRecord) {
        continue;
      }
      pushConsoleLine('info', `Loading IDE: ${ideRecord.requestedPath}`);

      const parsed = parseIde(await ideRecord.file.text());
      parsedIdeFiles += 1;
      pushLoadedFile('IDE', ideRecord.resolvedPath, 'loaded');

      for (const [id, def] of parsed.byId.entries()) ideById.set(id, def);
      for (const [name, def] of parsed.byModel.entries()) ideByModel.set(name, def);
      }

      let parsedIplFiles = 0;
      const placements = [];

      for (const pathHint of gtaDat.iplPaths) {
      const iplRecord = trackAndResolveFile('IPL', pathHint, {
        foundDetail: 'found',
        missingDetail: 'missing',
      });
      if (!iplRecord) {
        continue;
      }
      pushConsoleLine('info', `Loading IPL: ${iplRecord.requestedPath}`);

      const parsed = parseIpl(await iplRecord.file.text(), { gameVersion: uiStateRef.current.gameVersion });
      parsedIplFiles += 1;
      pushLoadedFile('IPL', iplRecord.resolvedPath, 'loaded');
      placements.push(...parsed);
      }
      pushConsoleLine('info', `IDE/IPL parsed in ${(performance.now() - parseStartTime).toFixed(1)} ms`);

      totalObjectsRef.current = placements.length;

      setStats({
        files: fileIndex.count,
        ideFiles: parsedIdeFiles,
        iplFiles: parsedIplFiles,
        ideDefs: ideByModel.size,
        iplInst: placements.length,
        loaded: 0,
        failed: 0,
        unresolved: 0,
        nearOnly: 0,
      });

      const txdLoader = new TXDLoader();
      const txdMetadataByNameRef = { current: new Map() };
      if (!txdLoader.__rwMetaPatched) {
      const baseReadTextureNative = txdLoader.readTextureNative.bind(txdLoader);
      txdLoader.readTextureNative = function patchedReadTextureNative(...args) {
        const parsed = baseReadTextureNative(...args);
        if (parsed?.name) {
          txdMetadataByNameRef.current.set(String(parsed.name).toLowerCase(), {
            compression: parsed.compression,
            d3dFormat: parsed.d3dFormat,
            rasterFormat: parsed.rasterFormat,
            platformId: parsed.platformId,
            width: parsed.width,
            height: parsed.height,
            hasAlpha: parsed.hasAlpha,
          });
        }
        return parsed;
      };
      const baseParse = txdLoader.parse.bind(txdLoader);
      txdLoader.parse = function patchedParse(...args) {
        txdMetadataByNameRef.current = new Map();
        return baseParse(...args);
      };
      txdLoader.__rwMetaPatched = true;
      }
      const modelCache = new Map();
      const txdCache = new Map();
      let pendingWaterPipeline = null;

      const getTextureDict = async (txdName) => {
      if (!txdName) return null;
      if (txdCache.has(txdName)) return txdCache.get(txdName);

      try {
        const txdFromFile = fileIndex.findByBasename(`${txdName}.txd`);
        let txdBuffer = null;
        let txdSource = '';
        if (txdFromFile) {
          txdBuffer = await txdFromFile.arrayBuffer();
          txdSource = normalizePath(txdFromFile.webkitRelativePath || txdFromFile.name || `${txdName}.txd`);
        } else {
          const txdFromImg = imgParser.getAssetBytes(`${txdName}.txd`);
          if (!txdFromImg) {
            txdCache.set(txdName, null);
            pushConsoleLine('warn', `TXD missing: ${txdName}.txd (file + IMG)`);
            return null;
          }
          txdBuffer = txdFromImg.buffer.slice(
            txdFromImg.byteOffset,
            txdFromImg.byteOffset + txdFromImg.byteLength,
          );
          txdSource = imgParser.getAssetSource(`${txdName}.txd`) || 'unknown IMG';
        }
        const txd = normalizeTextureDictionary(txdLoader.parse(txdBuffer), {
          metadataByName: txdMetadataByNameRef.current,
        });
        txdCache.set(txdName, txd);
        pushConsoleLine('info', `TXD loaded: ${txdName}.txd (${txdSource})`);
        return txd;
      } catch {
        txdCache.set(txdName, null);
        pushConsoleLine('error', `TXD parse failed: ${txdName}.txd`);
        return null;
      }
      };

      const tryBuildWater = async () => {
      const waterConfig = getWaterConfig(uiStateRef.current.gameVersion);
      if (waterConfig.source !== 'waterpro') {
        pushConsoleLine(
          'warn',
          `${waterConfig.gameVersion} uses water.dat in librw/euryopa. waterpro.dat loading is skipped, so water rendering is disabled.`,
        );
        return;
      }

      const waterRecord = trackAndResolveFile('DAT', 'data/waterpro.dat', {
        declaredDetail: 'optional',
        foundDetail: 'loaded',
        missingDetail: 'missing optional',
        warnOnMissing: false,
      });
      if (!waterRecord) {
        pushConsoleLine('warn', 'waterpro.dat not found. Water rendering disabled.');
        return;
      }

      try {
        setStatus('Building water...');
        await yieldToBrowser();
        const waterStartTime = performance.now();
        const parsed = parseWaterproDat(await waterRecord.file.arrayBuffer());
        const waterTextureName = String(waterConfig.textureName || '').toLowerCase();

        const pipeline = new RWWaterPipeline({
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
            nearAlpha: uiStateRef.current.waterNearAlpha,
            wavyAlpha: uiStateRef.current.waterWavyAlpha,
            wakeAlpha: uiStateRef.current.waterWakeAlpha,
            showWavy: uiStateRef.current.waterShowWavy,
            showWake: uiStateRef.current.waterShowWake,
          },
        });
        pendingWaterPipeline?.dispose();
        pendingWaterPipeline = pipeline;
        pipeline.setTimecycleProvider(() => null);
        const nearPosition = pipeline.nearMesh.geometry.getAttribute('position');
        const waterCells = nearPosition ? Math.floor(nearPosition.count / 6) : 0;
        pipeline.nearMesh.userData.water = {
          kind: 'waterpro',
          levelCount: parsed.levelCount,
          cells: waterCells,
        };
        pushConsoleLine(
          'info',
          `waterpro.dat loaded: ${parsed.levelCount} levels, ${waterCells} cells`,
        );
        pushConsoleLine('info', `Water pipeline built in ${(performance.now() - waterStartTime).toFixed(1)} ms`);

        void (async () => {
          const particleTxd = await getTextureDict('particle');
          if (buildTokenRef.current !== token) return;
          const waterTextureEntry = particleTxd?.get?.(waterTextureName) || null;
          const waterTexture = waterTextureEntry?.texture || waterTextureEntry || null;

          if (!waterTexture) {
            pushConsoleLine('warn', `Water texture missing: particle/${waterConfig.textureName}. Using flat color water.`);
            return;
          }

          pendingWaterPipeline?.setTexture(waterTexture);
          pushConsoleLine('info', `Water texture applied: particle/${waterConfig.textureName}`);
        })();
      } catch (error) {
        pushConsoleLine('error', `waterpro.dat parse failed: ${formatConsoleArg(error)}`);
      }
      };

      await tryBuildWater();

      const getModelTemplate = async (modelName, txdName) => {
      const key = makeAssetKey(modelName, txdName);
      if (modelCache.has(key)) return modelCache.get(key);

      const pending = (async () => {
        const dffLoader = new DFFLoader();
        const txd = await getTextureDict(txdName);
        if (txd) dffLoader.setTextureDictionary(txd);

        const dffFromFile = fileIndex.findByBasename(`${modelName}.dff`);
        let dffBuffer = null;
        let dffSource = '';
        if (dffFromFile) {
          dffBuffer = await dffFromFile.arrayBuffer();
          dffSource = normalizePath(dffFromFile.webkitRelativePath || dffFromFile.name || `${modelName}.dff`);
        } else {
          const dffFromImg = imgParser.getAssetBytes(`${modelName}.dff`);
          if (!dffFromImg) {
            pushConsoleLine('error', `DFF missing: ${modelName}.dff (file + IMG)`);
            throw new Error(`Missing DFF: ${modelName}.dff`);
          }
          dffBuffer = dffFromImg.buffer.slice(
            dffFromImg.byteOffset,
            dffFromImg.byteOffset + dffFromImg.byteLength,
          );
          dffSource = imgParser.getAssetSource(`${modelName}.dff`) || 'unknown IMG';
        }

        const template = dffLoader.parse(dffBuffer);
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
        const collectMaterialTextureNames = (material) => {
          if (!material) return;
          registerTexture(material.map?.name, material.map);
          registerTexture(material.alphaMap?.name, material.alphaMap);
          registerTexture(material.userData?.textureName, material.map);
        };
        template.traverse((node) => {
          if (!node.isMesh) return;
          const sourceMats = Array.isArray(node.material) ? node.material : [node.material];
          for (const mat of sourceMats) collectMaterialTextureNames(mat);
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
        pushConsoleLine('info', `DFF loaded: ${modelName}.dff (${dffSource})`);
        const txdTextures = txd && typeof txd.keys === 'function' ? txd : null;
        if (txdTextures) {
          for (const entry of usedTextureEntries.values()) {
            if (entry.texture) continue;
            const txdTexture = txdTextures.get(entry.name);
            if (txdTexture) {
              entry.texture = txdTexture.texture || txdTexture;
              entry.compressionMethod = txdTexture.compressionMethod || txdTexture.texture?.userData?.rwCompressionMethod || 'UNKNOWN';
              entry.pixelFormat = txdTexture.pixelFormat || txdTexture.texture?.userData?.rwPixelFormat || 'UNKNOWN';
            }
          }
        }
        return {
          key,
          modelName,
          txdName,
          template,
          usedTextureEntries: Array.from(usedTextureEntries.values()).sort((a, b) => a.name.localeCompare(b.name)),
          instancable,
          meshDescriptors,
        };
      })();

      modelCache.set(key, pending);
      return pending;
      };

      let loaded = 0;
      let failed = 0;
      let unresolved = 0;
      let tobjBuilt = 0;
      const effectivePlacements = placements;

      setStatus(`Loading ${effectivePlacements.length} placements...`);
      await yieldToBrowser();
      const placementStartTime = performance.now();

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
    const camera = cameraRef.current;
    if (camera) {
      nonLodIndices.sort((a, b) => {
        const pa = effectivePlacements[a].position;
        const pb = effectivePlacements[b].position;
        const da = camera.position.distanceTo(gtaPositionToThree(pa.x, pa.y, pa.z));
        const db = camera.position.distanceTo(gtaPositionToThree(pb.x, pb.y, pb.z));
        return da - db;
      });
    }
    const nonLodWithLodIndices = nonLodIndices.filter((index) => Number.isInteger(lodMapping.get(index)));
    const nonLodWithoutLodIndices = nonLodIndices.filter((index) => !Number.isInteger(lodMapping.get(index)));
    const missingLodModels = new Set();
    for (const index of nonLodIndices) {
      if (Number.isInteger(lodMapping.get(index))) continue;
      const modelName = String(effectivePlacements[index]?.modelName || '').trim().toLowerCase();
      if (modelName) missingLodModels.add(modelName);
    }
    if (missingLodModels.size > 0) {
      pushConsoleLine(
        'error',
        `Missing LOD mapping for ${missingLodModels.size} models (render as near-only using IDE draw distance).`,
        'lod',
      );
      for (const modelName of Array.from(missingLodModels).sort()) {
        pushConsoleLine('error', `No LOD match: ${modelName}`, 'lod');
      }
    }
    const standaloneLodModels = new Set(
      standaloneLodIndices.map((index) => String(effectivePlacements[index]?.modelName || '').trim().toLowerCase()).filter(Boolean),
    );
    if (standaloneLodModels.size > 0) {
      pushConsoleLine(
        'error',
        `Standalone LOD models found: ${standaloneLodModels.size} (no near model). They will render as LOD-only.`,
        'lod',
      );
      for (const modelName of Array.from(standaloneLodModels).sort()) {
        pushConsoleLine('error', `Standalone LOD: ${modelName}`, 'lod');
      }
    }
    const buildTotal = nonLodWithLodIndices.length + nonLodWithoutLodIndices.length + standaloneLodIndices.length;
    setBuildProgress({ active: true, current: 0, total: buildTotal });

    const getPlacementDef = (placement) => ideByModel.get(placement.modelName) ?? ideById.get(placement.id);
    const tobjPlacementCount = effectivePlacements.reduce((count, placement) => {
      const def = getPlacementDef(placement);
      return count + (def?.section === 'tobjs' ? 1 : 0);
    }, 0);
    pushConsoleLine('info', `TOBJ detected in IPL placements: ${tobjPlacementCount}`);
    const placementAnchors = effectivePlacements.map((placement) => gtaPositionToThree(
      placement.position.x,
      placement.position.y,
      placement.position.z,
    ));
    const renderItems = [];

    const buildPlacementObject = async (placement, lodKind, anchor) => {
      const ide = ideByModel.get(placement.modelName) ?? ideById.get(placement.id);
      if (!ide) {
        unresolved += 1;
        pushConsoleLine('error', `Missing IDE def for placement: model=${placement.modelName} id=${placement.id}`, 'build');
        return null;
      }

      try {
        const model = await getModelTemplate(ide.modelName, ide.txdName);

        const threePosition = anchor;
        const placementQuaternion = gtaPlacementQuaternionToThree(
          placement.rotation.x,
          placement.rotation.y,
          placement.rotation.z,
          placement.rotation.w,
          uiStateRef.current.quaternionOrder,
        );
        const worldMatrix = new THREE.Matrix4().compose(
          threePosition,
          placementQuaternion,
          new THREE.Vector3(1, 1, 1),
        );

        const instance = SkeletonUtils.clone(model.template);
        instance.applyMatrix4(worldMatrix);
        applyWireframe(instance, uiStateRef.current.wireframe);
        if (ide.section === 'tobjs') {
          prepareTobjInstanceMaterials(instance, uiStateRef.current.disableVertexColor);
          tobjBuilt += 1;
        }
        applyRwIdeFlagsToInstance(instance, ide.flags);
        applyDisableVertexColor(instance, uiStateRef.current.disableVertexColor);
        applyGlobalBackfaceCulling(instance, uiStateRef.current.disableBackfaceCulling);
        instance.visible = false;
        instance.userData.lodKind = lodKind;
        instance.userData.selectableRoot = true;
        instance.userData.objectDetail = {
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
        };
        worldRoot.add(instance);
        loaded += 1;
        return instance;
      } catch (error) {
        failed += 1;
        pushConsoleLine(
          'error',
          `Build failed: model=${ide.modelName} txd=${ide.txdName} lod=${lodKind} (${formatConsoleArg(error)})`,
          'build',
        );
        pushFailedModel(`model=${ide.modelName} txd=${ide.txdName} lod=${lodKind} error=${formatConsoleArg(error)}`);
        return null;
      }
    };

    const batchSize = 32;
    let completed = 0;
      for (let batchStart = 0; batchStart < nonLodWithLodIndices.length; batchStart += batchSize) {
        if (buildTokenRef.current !== token) {
          pendingWaterPipeline?.dispose();
          return;
        }
      const batch = nonLodWithLodIndices.slice(batchStart, batchStart + batchSize);

      await Promise.all(batch.map(async (index) => {
        const placement = effectivePlacements[index];
        const anchor = placementAnchors[index];
        const lodIndex = lodMapping.get(index);
        const lodPlacement = effectivePlacements[lodIndex];
        const lodAnchor = placementAnchors[lodIndex];
        const nearDef = getPlacementDef(placement);
        const isTobj = nearDef?.section === 'tobjs';
        const nearObj = await buildPlacementObject(placement, 'near', anchor);
        const lodObj = await buildPlacementObject(lodPlacement, 'lod', lodAnchor);
        if (nearObj || lodObj) {
          renderItems.push({
            isTobj,
            anchor: anchor.clone(),
            nearObj,
            lodObj,
            nearDrawDistance: Number.isFinite(nearDef?.drawDistance) ? nearDef.drawDistance : null,
            mode: 'hidden',
          });
        }
      }));
      completed += batch.length;

      setStats((prev) => ({ ...prev, loaded, failed, unresolved }));
      setBuildProgress({ active: true, current: completed, total: buildTotal });
      pushConsoleLine('info', `Build progress: ${completed}/${buildTotal}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

      for (let batchStart = 0; batchStart < nonLodWithoutLodIndices.length; batchStart += batchSize) {
        if (buildTokenRef.current !== token) {
          pendingWaterPipeline?.dispose();
          return;
        }
      const batch = nonLodWithoutLodIndices.slice(batchStart, batchStart + batchSize);

      await Promise.all(batch.map(async (index) => {
        const placement = effectivePlacements[index];
        const anchor = placementAnchors[index];
        const nearDef = getPlacementDef(placement);
        const isTobj = nearDef?.section === 'tobjs';
        const nearObj = await buildPlacementObject(placement, 'near', anchor);
        if (nearObj) {
          renderItems.push({
            isTobj,
            anchor: anchor.clone(),
            nearObj,
            lodObj: null,
            nearDrawDistance: Number.isFinite(nearDef?.drawDistance) ? nearDef.drawDistance : null,
            mode: 'hidden',
          });
        }
      }));
      completed += batch.length;

      setStats((prev) => ({ ...prev, loaded, failed, unresolved }));
      setBuildProgress({ active: true, current: completed, total: buildTotal });
      pushConsoleLine('info', `Build progress: ${completed}/${buildTotal}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

      for (let batchStart = 0; batchStart < standaloneLodIndices.length; batchStart += batchSize) {
        if (buildTokenRef.current !== token) {
          pendingWaterPipeline?.dispose();
          return;
        }
      const batch = standaloneLodIndices.slice(batchStart, batchStart + batchSize);

      await Promise.all(batch.map(async (index) => {
        const placement = effectivePlacements[index];
        const anchor = placementAnchors[index];
        const lodDef = getPlacementDef(placement);
        const isTobj = lodDef?.section === 'tobjs';
        const lodObj = await buildPlacementObject(placement, 'lod', anchor);
        if (lodObj) {
          renderItems.push({
            isTobj,
            anchor: anchor.clone(),
            nearObj: null,
            lodObj,
            nearDrawDistance: null,
            mode: 'hidden',
          });
        }
      }));
      completed += batch.length;

      setStats((prev) => ({ ...prev, loaded, failed, unresolved }));
      setBuildProgress({ active: true, current: completed, total: buildTotal });
      pushConsoleLine('info', `Build progress: ${completed}/${buildTotal}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

      rwWaterPipelineRef.current?.dispose();
      rwWaterPipelineRef.current = pendingWaterPipeline;
      renderItemsRef.current = renderItems;
      rwRenderQueueRef.current?.markDirty();
      lodUpdateStateRef.current.needsRefresh = true;
      lodUpdateStateRef.current.lastCameraPos.set(Number.NaN, Number.NaN, Number.NaN);
      setBuildProgress({ active: false, current: buildTotal, total: buildTotal });
      setStatus(`Done. Loaded ${loaded} placements.`);
      setShowGameIcon(true);
      pushConsoleLine('info', `Build done. loaded=${loaded} failed=${failed} unresolved=${unresolved} tobjBuilt=${tobjBuilt}`);
      pushConsoleLine('info', `Placement build finished in ${(performance.now() - placementStartTime).toFixed(1)} ms`);
    } finally {
      buildActiveRef.current = false;
    }
  }, [clearWorld, pushConsoleLine, pushFailedModel, pushLoadedFile]);

  const onPickFolder = useCallback((event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const index = buildFileIndex(files);
    fileIndexRef.current = index;
    pushConsoleLine('info', `Folder indexed: ${index.count} files`);

    setStats((prev) => ({ ...prev, files: index.count }));
    setStatus(`Indexed ${index.count} files. Click Build World.`);
  }, [pushConsoleLine]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const imguiCanvas = imguiCanvasRef.current;
    if (!container || !canvas || !imguiCanvas) return undefined;

    let renderer = null;
    let cancelled = false;
    let rendererReady = false;

    if (activeBackend === 'WebGPU') {
      if (!WebGPU.isAvailable()) {
        pushConsoleLine('warn', 'WebGPU is not supported in this browser. Fallback to WebGL.');
        setStatus('WebGPU not supported. Switched to WebGL.');
        uiStateRef.current.backendSelection = 'WebGL';
        backendSwitchingRef.current = true;
        setActiveBackend('WebGL');
        return undefined;
      }
      renderer = new WebGPURenderer({ canvas, antialias: true, alpha: false });
      renderer.init().then(() => {
        if (cancelled) {
          renderer.dispose();
          return;
        }
        pushConsoleLine('info', 'WebGPU backend initialized');
        resize();
        rendererReady = true;
        backendSwitchingRef.current = false;
      }).catch((error) => {
        if (cancelled) return;
        pushConsoleLine('error', `WebGPU init failed: ${formatConsoleArg(error)}. Fallback to WebGL.`);
        setStatus('WebGPU init failed. Switched to WebGL.');
        uiStateRef.current.backendSelection = 'WebGL';
        setActiveBackend('WebGL');
        try {
          renderer.dispose();
        } catch {
          // ignore disposal errors in fallback path
        }
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        rendererRef.current = renderer;
        resize();
        rendererReady = true;
        backendSwitchingRef.current = false;
      });
    } else {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      rendererReady = true;
      backendSwitchingRef.current = false;
    }

    canvas.tabIndex = 1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8ea9b5);
    const hudScene = new THREE.Scene();
    const hudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    hudCamera.position.set(0, 0, 1);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 60000);
    camera.up.copy(WORLD_UP);
    camera.position.set(300, 300, 220);
    camera.lookAt(0, 0, 0);
    const orbitControls = new OrbitControls(camera, canvas);
    orbitControls.enabled = false;
    orbitControls.enableDamping = true;
    orbitControls.target.set(0, 0, 0);
    orbitControls.update();

    const updateLookFromAngles = () => {
      const look = lookStateRef.current;
      const cp = Math.cos(look.pitch);
      const direction = new THREE.Vector3(
        Math.sin(look.yaw) * cp,
        Math.sin(look.pitch),
        Math.cos(look.yaw) * cp,
      );
      camera.lookAt(camera.position.clone().add(direction));
    };

    const syncAnglesFromCamera = () => {
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      lookStateRef.current.yaw = Math.atan2(direction.x, direction.z);
      lookStateRef.current.pitch = Math.asin(Math.max(-1, Math.min(1, direction.y)));
    };
    syncAnglesFromCamera();

    const playerController = new PlayerControllerAdapter({
      scene,
      camera,
      controls: orbitControls,
      externalFactory: createExternalPlayerController,
      getSpawnPosition: () => camera.position.clone(),
      playerModel: {
        url: '/glb/person.glb',
        scale: 0.01,
        idleAnim: 'idle1',
        walkAnim: 'walk',
        runAnim: 'run',
        jumpAnim: 'jump',
        flyAnim: 'flying',
        flyIdleAnim: 'flyidle',
        enterCarAnim: 'enterCar',
        exitCarAnim: 'exitCar',
        headObjName: 'mixamorigHead',
        rotateY: Math.PI,
      },
      minCamDistance: 80,
      maxCamDistance: 360,
      thirdMouseMode: 1,
      allowFallback: false,
      getMoveState: () => moveStateRef.current,
      getLookState: () => lookStateRef.current,
      worldUp: WORLD_UP,
    });
    const playerModeManager = new PlayerModeManager({
      playerController,
      getMode: () => uiStateRef.current.appMode,
      setMode: (nextMode) => {
        uiStateRef.current.appMode = nextMode;
      },
      onModeStatus: (nextMode, controllerMode, enableTest) => {
        setStatus(`Mode: ${nextMode}${enableTest ? ` (${controllerMode})` : ''}`);
      },
      onModeError: (error) => {
        pushConsoleLine('error', `Mode switch failed: ${formatConsoleArg(error)}`, 'mode');
        setStatus(`Mode switch failed: ${formatConsoleArg(error)}`);
      },
      onModeLog: (prevMode, nextMode, controllerMode) => {
        pushConsoleLine('info', `Mode switched: ${prevMode} -> ${nextMode}${nextMode === APP_MODE_TEST ? ` (${controllerMode})` : ''}`, 'mode');
      },
      onExitTestMode: () => {
        syncAnglesFromCamera();
      },
    });

    const hemi = new THREE.HemisphereLight(0xffffff, 0x677582, 0.8);
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(400, 250, 500);

    const grid = new THREE.GridHelper(5000, 140, 0x334455, 0x6e7f91);

    const axes = new THREE.AxesHelper(150);
    axes.visible = false;

    scene.add(hemi, sun, grid, axes, worldRootRef.current);

    const textureLoader = new THREE.TextureLoader();
    const iconTextures = {
      SA: textureLoader.load(saIcon),
      VCS: textureLoader.load(vcsIcon),
    };
    const iconMaterial = new THREE.SpriteMaterial({
      map: iconTextures.VCS,
      transparent: true,
      alphaTest: 0.01,
      depthTest: false,
      depthWrite: false,
    });
    const gameIconSprite = new THREE.Sprite(iconMaterial);
    gameIconSprite.center.set(1, 1);
    gameIconSprite.visible = false;
    gameIconSprite.renderOrder = 9999;
    hudScene.add(gameIconSprite);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    rwRenderQueueRef.current = new RWRenderQueue(worldRootRef.current);
    gridRef.current = grid;
    axesRef.current = axes;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(container.clientWidth));
      const height = Math.max(1, Math.floor(container.clientHeight));
      imguiCanvas.width = Math.max(1, Math.floor(width * dpr));
      imguiCanvas.height = Math.max(1, Math.floor(height * dpr));
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      hudCamera.updateProjectionMatrix();
      if (!rendererReady) return;
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
    };

    resize();
    window.addEventListener('resize', resize);

    const setKeyState = (code, value) => {
      const move = moveStateRef.current;
      if (code === 'KeyW') move.forward = value;
      if (code === 'KeyS') move.back = value;
      if (code === 'KeyA') move.left = value;
      if (code === 'KeyD') move.right = value;
      if (code === 'KeyE') move.up = value;
      if (code === 'KeyQ') move.down = value;
      if (code === 'ShiftLeft' || code === 'ShiftRight') move.boost = value;
    };

    const onKeyDown = (event) => {
      setKeyState(event.code, true);
    };
    const onKeyUp = (event) => {
      setKeyState(event.code, false);
    };
    const setSelectedObjectRoot = (nextRoot) => {
      const previous = selectedObjectRootRef.current;
      if (previous && previous !== nextRoot) {
        clearObjectSelectionHighlight(previous);
        rwRenderQueueRef.current?.markDirty();
      }
      if (!nextRoot) {
        selectedObjectRootRef.current = null;
        selectedObjectRef.current = null;
        setSelectedObject(null);
        return;
      }
      applyObjectSelectionHighlight(nextRoot);
      rwRenderQueueRef.current?.markDirty();
      selectedObjectRootRef.current = nextRoot;
      selectedObjectRef.current = nextRoot.userData?.objectDetail || null;
      setSelectedObject(selectedObjectRef.current);
      setWindowOpen('objectDetail', true);
    };

    const trySelectObjectFromPointer = (event) => {
      if (playerModeManager.isTestMode()) return;
      if (imguiCaptureRef.current.mouse) return;
      const cameraObj = cameraRef.current;
      const worldRoot = worldRootRef.current;
      if (!cameraObj || !worldRoot) return;

      const rect = container.getBoundingClientRect();
      const nx = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ny = -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
      pointerNdcRef.current.set(nx, ny);

      const raycaster = raycasterRef.current;
      raycaster.setFromCamera(pointerNdcRef.current, cameraObj);
      const intersections = raycaster.intersectObject(worldRoot, true);
      for (const hit of intersections) {
        const selectable = getSelectableRootFromObject(hit.object);
        if (!selectable || !selectable.visible) continue;
        setSelectedObjectRoot(selectable);
        return;
      }
      setSelectedObjectRoot(null);
    };

    const onMouseDown = (event) => {
      if (playerModeManager.isTestMode()) return;
      if (event.button !== 0 || imguiCaptureRef.current.mouse) return;
      pointerStateRef.current.down = true;
      pointerStateRef.current.startX = event.clientX;
      pointerStateRef.current.startY = event.clientY;
      pointerStateRef.current.moved = false;
      lookStateRef.current.active = true;
      lookStateRef.current.lastX = event.clientX;
      lookStateRef.current.lastY = event.clientY;
      event.preventDefault();
    };
    const onMouseUp = (event) => {
      if (event.button !== 0) return;
      const pointer = pointerStateRef.current;
      const treatAsClick = pointer.down && !pointer.moved;
      pointer.down = false;
      lookStateRef.current.active = false;
      if (treatAsClick) {
        trySelectObjectFromPointer(event);
      }
    };
    const onMouseMove = (event) => {
      if (playerModeManager.isTestMode()) return;
      if (pointerStateRef.current.down) {
        const dx = event.clientX - pointerStateRef.current.startX;
        const dy = event.clientY - pointerStateRef.current.startY;
        if ((dx * dx) + (dy * dy) > 9) {
          pointerStateRef.current.moved = true;
        }
      }
      if (!lookStateRef.current.active || imguiCaptureRef.current.mouse) return;
      const look = lookStateRef.current;
      const dx = event.clientX - look.lastX;
      const dy = event.clientY - look.lastY;
      look.lastX = event.clientX;
      look.lastY = event.clientY;

      const sensitivity = 0.003;
      look.yaw -= dx * sensitivity;
      look.pitch = Math.max(-1.55, Math.min(1.55, look.pitch - (dy * sensitivity)));
      updateLookFromAngles();
    };
    const switchAppMode = (nextModeRaw) => {
      lookStateRef.current.active = false;
      return playerModeManager.switchMode(nextModeRaw);
    };
    const getImguiTextureForImage = (textureSource) => {
      const gl = imguiGlRef.current;
      if (!gl || !textureSource) return null;

      const cached = imguiTextureCacheRef.current.get(textureSource);
      if (cached) return cached;

      const texture = gl.createTexture();
      if (!texture) return null;

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      try {
        const image = textureSource?.image ?? textureSource;
        const width = image?.videoWidth ?? image?.width ?? 0;
        const height = image?.videoHeight ?? image?.height ?? 0;
        if (!width || !height) throw new Error('invalid texture size');

        if (image?.data && ArrayBuffer.isView(image.data)) {
          const format = textureSource?.format === THREE.RGBFormat ? gl.RGB : gl.RGBA;
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            format,
            width,
            height,
            0,
            format,
            gl.UNSIGNED_BYTE,
            image.data,
          );
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        }
      } catch {
        gl.deleteTexture(texture);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return null;
      }
      gl.bindTexture(gl.TEXTURE_2D, null);

      imguiTextureCacheRef.current.set(textureSource, texture);
      imguiTextureListRef.current.push(texture);
      return texture;
    };
    const getTextureSize = (textureSource) => {
      const image = textureSource?.image ?? textureSource;
      const width = image?.videoWidth ?? image?.width ?? 0;
      const height = image?.videoHeight ?? image?.height ?? 0;
      return { width, height };
    };
    const openTextureDetail = (entry, detail) => {
      const textureSource = entry?.texture || null;
      if (!textureSource) return;
      const { width, height } = getTextureSize(textureSource);
      const compressionMethod = String(
        entry?.compressionMethod
        || textureSource?.userData?.rwCompressionMethod
        || 'UNKNOWN',
      );
      const pixelFormat = String(
        entry?.pixelFormat
        || textureSource?.userData?.rwPixelFormat
        || 'UNKNOWN',
      );
      const nextDetail = {
        name: String(entry?.name || ''),
        txdName: `${String(detail?.txdName || '')}.txd`,
        compressionMethod,
        pixelFormat,
        width,
        height,
        texture: textureSource,
      };
      selectedTextureDetailRef.current = nextDetail;
      setSelectedTextureDetail(nextDetail);
    };
    const onContextMenu = (event) => event.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('contextmenu', onContextMenu);

    let rafId = 0;
    let mounted = true;
    let backendRuntimeFailed = false;
    const drawingBufferSize = new THREE.Vector2();

    const animate = (time) => {
      if (!mounted) return;
      if (!rendererReady) {
        rafId = window.requestAnimationFrame(animate);
        return;
      }

      const dt = frameTimeRef.current > 0 ? Math.min(0.05, (time - frameTimeRef.current) / 1000) : 0;
      frameTimeRef.current = time;
      if (dt > 0) {
        const fps = Math.min(240, 1 / dt);
        fpsHistoryRef.current[fpsHistoryIndexRef.current] = fps;
        fpsHistoryIndexRef.current = (fpsHistoryIndexRef.current + 1) % fpsHistoryRef.current.length;
      }

      if (dt > 0) {
        if (playerModeManager.isTestMode()) {
          // In test mode, let three-player-controller fully drive character/camera.
          playerModeManager.update(dt);
        } else if (!imguiCaptureRef.current.keyboard) {
          const move = moveStateRef.current;
          const inputX = (move.right ? 1 : 0) - (move.left ? 1 : 0);
          const inputY = (move.forward ? 1 : 0) - (move.back ? 1 : 0);
          const inputZ = (move.up ? 1 : 0) - (move.down ? 1 : 0);
          if (inputX || inputY || inputZ) {
            const look = lookStateRef.current;
            const cp = Math.cos(look.pitch);
            const forward = new THREE.Vector3(
              Math.sin(look.yaw) * cp,
              Math.sin(look.pitch),
              Math.cos(look.yaw) * cp,
            ).normalize();
            const right = new THREE.Vector3().crossVectors(WORLD_UP, forward).normalize().negate();
            const velocity = move.boost ? 800 : 250;

            const delta = new THREE.Vector3();
            delta.addScaledVector(forward, inputY);
            delta.addScaledVector(right, inputX);
            delta.y += inputZ;
            if (delta.lengthSq() > 0) {
              delta.normalize().multiplyScalar(velocity * dt);
              camera.position.add(delta);
              updateLookFromAngles();
            }
          }
        }
      }

      lodUpdateAccumulatorRef.current += dt;
      const lodState = lodUpdateStateRef.current;
      const drawDistance = uiStateRef.current.drawDistance;
      const renderingDistance = uiStateRef.current.renderingDistance;
      const showLods = uiStateRef.current.showLods;
      const forceLodOnly = uiStateRef.current.forceLodOnly;
      const showTobjs = uiStateRef.current.showTobjs;

      const configChanged = (
        lodState.lastDrawDistance !== drawDistance
        || lodState.lastRenderingDistance !== renderingDistance
        || lodState.lastShowLods !== showLods
        || lodState.lastForceLodOnly !== forceLodOnly
        || lodState.lastShowTobjs !== showTobjs
      );
      if (configChanged) {
        lodState.lastDrawDistance = drawDistance;
        lodState.lastRenderingDistance = renderingDistance;
        lodState.lastShowLods = showLods;
        lodState.lastForceLodOnly = forceLodOnly;
        lodState.lastShowTobjs = showTobjs;
        lodState.needsRefresh = true;
      }

      const knownCameraPos = Number.isFinite(lodState.lastCameraPos.x)
        && Number.isFinite(lodState.lastCameraPos.y)
        && Number.isFinite(lodState.lastCameraPos.z);
      if (!knownCameraPos || camera.position.distanceToSquared(lodState.lastCameraPos) > 9) {
        lodState.lastCameraPos.copy(camera.position);
        lodState.needsRefresh = true;
      }

      if (lodState.needsRefresh && lodUpdateAccumulatorRef.current >= 0.02) {
        lodUpdateAccumulatorRef.current = 0;
        const renderDistSq = renderingDistance * renderingDistance;
        const drawDistSq = drawDistance * drawDistance;
        for (const item of renderItemsRef.current) {
          const distSq = camera.position.distanceToSquared(item.anchor);
          const inRange = distSq <= renderDistSq;

          let targetMode = 'hidden';
          if (inRange) {
            const tobjAllowed = !item.isTobj || showTobjs;
            if (!tobjAllowed) {
              targetMode = 'hidden';
            } else if (forceLodOnly) {
              targetMode = item.lodObj ? 'lod' : 'hidden';
            } else if (!showLods) {
              targetMode = item.nearObj ? 'near' : (item.lodObj ? 'lod' : 'hidden');
            } else if (!item.nearObj && item.lodObj) {
              targetMode = 'lod';
            } else if (item.nearObj && item.lodObj) {
              targetMode = distSq > drawDistSq ? 'lod' : 'near';
            } else {
              targetMode = item.nearObj ? 'near' : (item.lodObj ? 'lod' : 'hidden');
            }

            // mapviewer-like behavior: if this placement has no LOD pair,
            // keep near model only within IDE draw distance.
            if (targetMode === 'near' && item.nearObj && !item.lodObj && !item.isTobj) {
              const ideDrawDistance = Number(item.nearDrawDistance);
              if (Number.isFinite(ideDrawDistance) && ideDrawDistance > 0) {
                if (distSq > (ideDrawDistance * ideDrawDistance)) {
                  targetMode = 'hidden';
                }
              }
            }
          }

          item.mode = targetMode;
          if (item.nearObj) item.nearObj.visible = targetMode === 'near';
          if (item.lodObj) item.lodObj.visible = targetMode === 'lod';
        }
        lodState.needsRefresh = false;
      }

      grid.visible = uiStateRef.current.showGrid;
      axes.visible = uiStateRef.current.showAxes;
      const targetFarClip = Math.max(camera.near + 1, uiStateRef.current.renderingDistance);
      if (Math.abs(camera.far - targetFarClip) > 1e-6) {
        camera.far = targetFarClip;
        camera.updateProjectionMatrix();
      }

      if (lastWireframeRef.current !== uiStateRef.current.wireframe) {
        applyWireframe(worldRootRef.current, uiStateRef.current.wireframe);
        rwWaterPipelineRef.current?.setWireframe(uiStateRef.current.wireframe);
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
        rwWaterPipelineRef.current?.setEnabled(uiStateRef.current.renderWater);
        lastRenderWaterRef.current = uiStateRef.current.renderWater;
      }

      const waterPipeline = rwWaterPipelineRef.current;
      waterPipeline?.applySettings({
        uvSpeed: uiStateRef.current.waterUvSpeed,
        waveHeight: uiStateRef.current.waterWaveHeight,
        nearAlpha: uiStateRef.current.waterNearAlpha,
        wavyAlpha: uiStateRef.current.waterWavyAlpha,
        wakeAlpha: uiStateRef.current.waterWakeAlpha ?? 0.55,
        showWavy: uiStateRef.current.waterShowWavy,
        showWake: uiStateRef.current.waterShowWake ?? false,
      });
      const savedSceneBackground = scene.background;
      try {
        rwRenderQueueRef.current?.prepareFrame(camera);
        if (waterPipeline?.hasRenderableWater() && uiStateRef.current.renderWater) {
          let waterStage = 'update';
          try {
            waterPipeline.update(camera, time, dt);
            scene.background = null;

            waterStage = 'renderFar';
            renderer.autoClear = true;
            waterPipeline.renderFar(renderer, camera, savedSceneBackground);
            renderer.autoClear = false;
            renderer.clearDepth();

            waterStage = 'renderScene';
            renderer.render(scene, camera);

            waterStage = 'renderNear';
            waterPipeline.renderNear(renderer, camera);

            waterStage = 'renderWavy';
            waterPipeline.renderWavy(renderer, camera);

            waterStage = 'renderWake';
            waterPipeline.renderWake(renderer, camera);
            renderer.autoClear = true;
            scene.background = savedSceneBackground;
          } catch (waterError) {
            scene.background = savedSceneBackground;
            console.error('Water pipeline runtime error:', waterError);
            const farPos = waterPipeline?.farMesh?.geometry?.getAttribute?.('position')?.array?.byteLength ?? 'missing';
            const farUv = waterPipeline?.farMesh?.geometry?.getAttribute?.('uv')?.array?.byteLength ?? 'missing';
            const farIndex = waterPipeline?.farMesh?.geometry?.index?.array?.byteLength ?? 'missing';
            const nearPos = waterPipeline?.nearMesh?.geometry?.getAttribute?.('position')?.array?.byteLength ?? 'missing';
            const nearUv = waterPipeline?.nearMesh?.geometry?.getAttribute?.('uv')?.array?.byteLength ?? 'missing';
            const nearIndex = waterPipeline?.nearMesh?.geometry?.index?.array?.byteLength ?? 'missing';
            const nearNormal = waterPipeline?.nearMesh?.geometry?.getAttribute?.('normal')?.array?.byteLength ?? 'missing';
            const wakePos = waterPipeline?.wakeMesh?.geometry?.getAttribute?.('position')?.array?.byteLength ?? 'missing';
            pushConsoleLine('error', `Water runtime error @ ${waterStage}: ${formatConsoleArg(waterError)}`);
            pushConsoleLine(
              'error',
              `Water buffers: far.pos=${farPos} far.uv=${farUv} far.idx=${farIndex} near.pos=${nearPos} near.uv=${nearUv} near.idx=${nearIndex} near.normal=${nearNormal} wake.pos=${wakePos}`,
            );
            setStatus(`Water runtime error @ ${waterStage}: ${formatConsoleArg(waterError)}. Water disabled.`);
            rwWaterPipelineRef.current?.dispose();
            rwWaterPipelineRef.current = null;
            renderer.autoClear = true;
            renderer.render(scene, camera);
          }
        } else {
          renderer.autoClear = true;
          renderer.render(scene, camera);
        }

        const activeIcon = uiStateRef.current.gameVersion === 'SA' ? 'SA' : 'VCS';
        gameIconSprite.material.map = iconTextures[activeIcon];
        gameIconSprite.visible = showGameIconRef.current;
        renderer.getDrawingBufferSize(drawingBufferSize);
        const viewportWidth = Math.max(1, drawingBufferSize.x);
        const viewportHeight = Math.max(1, drawingBufferSize.y);
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
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(hudScene, hudCamera);
        renderer.autoClear = true;
      } catch (error) {
        scene.background = savedSceneBackground;
        console.error('Renderer runtime error:', error);
        if (!backendRuntimeFailed) {
          backendRuntimeFailed = true;
          pushConsoleLine('error', `Renderer runtime error: ${formatConsoleArg(error)}`);
          if (activeBackend !== 'WebGL') {
            setStatus('Renderer backend failed at runtime. Switched to WebGL.');
            uiStateRef.current.backendSelection = 'WebGL';
            backendSwitchingRef.current = true;
            setActiveBackend('WebGL');
          } else {
            setStatus(`Renderer runtime error: ${formatConsoleArg(error)}`);
            backendSwitchingRef.current = false;
          }
        }
        rafId = window.requestAnimationFrame(animate);
        return;
      }

      const { ImGui, ImGui_Impl, ready } = imguiRef.current;
      if (!backendSwitchingRef.current && ready && ImGui && ImGui_Impl) {
        const liveStats = statsRef.current;
        const liveStatus = statusRef.current;

        try {
          ImGui_Impl.NewFrame(time);
          ImGui.NewFrame();
          const io = ImGui.GetIO();
          imguiCaptureRef.current.mouse = Boolean(io?.WantCaptureMouse);
          imguiCaptureRef.current.keyboard = Boolean(io?.WantCaptureKeyboard);

        if (ImGui.BeginMainMenuBar()) {
          if (ImGui.BeginMenu('File')) {
            if (ImGui.MenuItem('Load map')) {
              fileInputRef.current?.click();
            }
            ImGui.EndMenu();
          }
          if (ImGui.BeginMenu('View')) {
            for (const item of WINDOW_DEFS) {
              if (ImGui.MenuItem(item.title, '', isWindowOpen(item.key))) {
                setWindowOpen(item.key, !isWindowOpen(item.key));
              }
            }
            ImGui.EndMenu();
          }
          if (ImGui.BeginMenu('Rendering')) {
            if (ImGui.MenuItem('Settings', '', isWindowOpen('rendering'))) {
              setWindowOpen('rendering', !isWindowOpen('rendering'));
            }
            ImGui.EndMenu();
          }
          if (ImGui.BeginMenu('Mode')) {
            if (ImGui.MenuItem('Editor', '', uiStateRef.current.appMode === APP_MODE_EDITOR)) {
              switchAppMode(APP_MODE_EDITOR).catch(() => {});
            }
            if (ImGui.MenuItem('Test', '', uiStateRef.current.appMode === APP_MODE_TEST)) {
              switchAppMode(APP_MODE_TEST).catch(() => {});
            }
            ImGui.EndMenu();
          }
          if (ImGui.BeginMenu('Help')) {
            if (ImGui.MenuItem('About')) {
              setWindowOpen('about', true);
            }
            ImGui.EndMenu();
          }
          const fpsHistory = fpsHistoryRef.current;
          let fpsSum = 0;
          let fpsCount = 0;
          for (let index = 0; index < fpsHistory.length; index += 1) {
            const sample = fpsHistory[index];
            if (sample > 0) {
              fpsSum += sample;
              fpsCount += 1;
            }
          }
          const fpsValue = fpsCount > 0 ? Math.round(fpsSum / fpsCount) : 0;
          const fpsText = `FPS: ${fpsValue}`;
          const brandText = 'jsrw By Nurupo';
          const fpsTextSize = ImGui.CalcTextSize(fpsText);
          const brandTextSize = ImGui.CalcTextSize(brandText);
          const menuBarWidth = ImGui.GetWindowWidth();
          const style = ImGui.GetStyle();
          const rightPadding = style?.FramePadding?.x ?? 0;
          const itemSpacing = style?.ItemSpacing?.x ?? 0;
          const separatorWidth = ImGui.CalcTextSize(' | ').x;
          const totalWidth = fpsTextSize.x + brandTextSize.x + separatorWidth + (itemSpacing * 2) + (rightPadding * 4);
          ImGui.SetCursorPosX(Math.max(ImGui.GetCursorPosX(), menuBarWidth - totalWidth));
          if (ImGui.SmallButton(fpsText)) {
            setWindowOpen('statistics', true);
          }
          ImGui.SameLine();
          ImGui.TextUnformatted('|');
          ImGui.SameLine();
          ImGui.TextUnformatted(brandText);
          ImGui.EndMainMenuBar();
        }

        const Vec2 = ImGui.ImVec2 ?? ImGui.Vec2;
        if (isWindowOpen('mapControls')) {
          ImGui.SetNextWindowPos(new Vec2(16, 16), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(420, 0), ImGui.Cond.Once);
          ImGui.Begin(
            'GTA Map Controls',
            (value = isWindowOpen('mapControls')) => setWindowOpen('mapControls', value),
          );

        ImGui.Text(`Files: ${liveStats.files}`);
        ImGui.Text(`Mode: ${uiStateRef.current.appMode}`);
        ImGui.Text(`IDE loaded: ${liveStats.ideFiles} | defs: ${liveStats.ideDefs}`);
        ImGui.Text(`IPL loaded: ${liveStats.iplFiles} | inst: ${liveStats.iplInst}`);
        ImGui.Text(`Rendered: ${liveStats.loaded} | failed: ${liveStats.failed} | missing IDE: ${liveStats.unresolved}`);

        ImGui.Separator();

        const versionOptions = ['SA', 'VCS'];
        if (ImGui.BeginCombo('GAME VERION', uiStateRef.current.gameVersion)) {
          for (const option of versionOptions) {
            const selected = uiStateRef.current.gameVersion === option;
            if (ImGui.Selectable(option, selected)) {
              uiStateRef.current.gameVersion = option;
            }
            if (selected) {
              ImGui.SetItemDefaultFocus();
            }
          }
          ImGui.EndCombo();
        }
        const quaternionOrderOptions = ['XYZW', 'WXYZ'];
        if (ImGui.BeginCombo('Quaternion Order', uiStateRef.current.quaternionOrder)) {
          for (const option of quaternionOrderOptions) {
            const selected = uiStateRef.current.quaternionOrder === option;
            if (ImGui.Selectable(option, selected)) {
              uiStateRef.current.quaternionOrder = option;
            }
            if (selected) {
              ImGui.SetItemDefaultFocus();
            }
          }
          ImGui.EndCombo();
        }
        ImGui.Checkbox(
          'Show LODs',
          (value = uiStateRef.current.showLods) => (uiStateRef.current.showLods = value),
        );
        ImGui.Checkbox(
          'Force LOD only',
          (value = uiStateRef.current.forceLodOnly) => (uiStateRef.current.forceLodOnly = value),
        );
        ImGui.Checkbox(
          'Show TOBJs',
          (value = uiStateRef.current.showTobjs) => (uiStateRef.current.showTobjs = value),
        );
        ImGui.Text('draw dist: LOD switch distance (near model <-> LOD)');
        ImGui.PushItemWidth(-1);
        ImGui.SliderInt(
          'draw dist',
          (value = Math.round(uiStateRef.current.drawDistance)) => {
            uiStateRef.current.drawDistance = value;
            return value;
          },
          20,
          3000,
        );
        ImGui.Text('rendering dist: max visible distance (hide all beyond this)');
        ImGui.SliderInt(
          'rendering dist',
          (value = Math.round(uiStateRef.current.renderingDistance)) => {
            uiStateRef.current.renderingDistance = value;
            return value;
          },
          50,
          20000,
        );
        ImGui.PopItemWidth();
        ImGui.Checkbox(
          'Show grid',
          (value = uiStateRef.current.showGrid) => (uiStateRef.current.showGrid = value),
        );
        ImGui.Checkbox(
          'Show axes',
          (value = uiStateRef.current.showAxes) => (uiStateRef.current.showAxes = value),
        );
        ImGui.Checkbox(
          'Wireframe',
          (value = uiStateRef.current.wireframe) => (uiStateRef.current.wireframe = value),
        );
        ImGui.Checkbox(
          'Disable Vertex Color',
          (value = uiStateRef.current.disableVertexColor) => (uiStateRef.current.disableVertexColor = value),
        );

        if (ImGui.Button('Build / Rebuild')) {
          rebuildWorld();
        }
        ImGui.SameLine();
        if (ImGui.Button('Clear')) {
          clearWorld();
        }
        const liveProgress = buildProgressRef.current;
        if (liveProgress.active) {
          const progressTotal = Math.max(1, liveProgress.total);
          const progressFraction = liveProgress.current / progressTotal;
          ImGui.ProgressBar(
            progressFraction,
            new Vec2(-1, 0),
            `${Math.floor(progressFraction * 100)}% (${liveProgress.current}/${progressTotal})`,
          );
        }

          ImGui.TextWrapped(liveStatus);
          ImGui.End();
        }

        if (isWindowOpen('objectDetail')) {
          ImGui.SetNextWindowPos(new Vec2(860, 16), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(420, 320), ImGui.Cond.Once);
          ImGui.Begin(
            'Object Detail',
            (value = isWindowOpen('objectDetail')) => setWindowOpen('objectDetail', value),
          );
          const detail = selectedObjectRef.current;
          if (!detail) {
            ImGui.TextWrapped('No object selected. Click an object in Editor mode.');
          } else {
            const defaultOpen = ImGui.TreeNodeFlags?.DefaultOpen ?? 0;
            if (ImGui.CollapsingHeader('Identity', defaultOpen)) {
              ImGui.Text(`ID: ${detail.id}`);
              ImGui.Text(`Placement ID: ${detail.placementId}`);
              ImGui.Text(`Model: ${detail.modelName}`);
              ImGui.Text(`Texture (TXD): ${detail.txdName}`);
              ImGui.Text(`Section: ${detail.section}`);
              ImGui.Text(`LOD Kind: ${detail.lodKind}`);
              ImGui.Text(`Flags: ${detail.flags}`);
              const flagNames = Array.isArray(detail.activeFlagNames) ? detail.activeFlagNames : [];
              ImGui.Text(`Flag Names: ${flagNames.length}`);
              if (flagNames.length > 0) {
                ImGui.BeginChild('obj-flag-names', new Vec2(0, 80), true);
                for (const flagName of flagNames) {
                  ImGui.TextUnformatted(flagName);
                }
                ImGui.EndChild();
              }
              ImGui.Text(`Draw Distance: ${Number.isFinite(detail.drawDistance) ? detail.drawDistance : 'N/A'}`);
            }
            if (ImGui.CollapsingHeader('Transform', defaultOpen)) {
              ImGui.Text(
                `Position: ${detail.position.x.toFixed(3)}, ${detail.position.y.toFixed(3)}, ${detail.position.z.toFixed(3)}`,
              );
              ImGui.Text(
                `Rotation(q): ${detail.rotation.x.toFixed(6)}, ${detail.rotation.y.toFixed(6)}, ${detail.rotation.z.toFixed(6)}, ${detail.rotation.w.toFixed(6)}`,
              );
            }
            if (ImGui.CollapsingHeader('Textures In Model', defaultOpen)) {
              const items = Array.isArray(detail.usedTextureEntries) ? detail.usedTextureEntries : [];
              ImGui.Text(`Count: ${items.length}`);
              ImGui.BeginChild('obj-used-tex', new Vec2(0, 180), true);
              const thumbSize = 48;
              const tileWidth = 92;
              const avail = Math.max(1, ImGui.GetContentRegionAvail().x);
              const perRow = Math.max(1, Math.floor(avail / tileWidth));
              if (items.length > 0) {
                ImGui.Columns(perRow, 'obj-used-tex-grid', false);
                for (const entry of items) {
                  ImGui.BeginGroup();
                  const texId = getImguiTextureForImage(entry.texture);
                  if (texId) {
                    ImGui.Image(texId, new Vec2(thumbSize, thumbSize));
                    if (ImGui.IsItemHovered() && ImGui.IsMouseDoubleClicked(0)) {
                      openTextureDetail(entry, detail);
                    }
                  } else {
                    ImGui.Dummy(new Vec2(thumbSize, thumbSize));
                  }
                  ImGui.TextWrapped(entry.name);
                  if (ImGui.IsItemHovered() && ImGui.IsMouseDoubleClicked(0)) {
                    openTextureDetail(entry, detail);
                  }
                  ImGui.EndGroup();
                  ImGui.NextColumn();
                }
                ImGui.Columns(1);
              }
              if (items.length === 0) {
                ImGui.TextUnformatted('No texture references found.');
              }
              ImGui.EndChild();
            }
          }
          ImGui.End();
        }

        if (selectedTextureDetailRef.current) {
          ImGui.SetNextWindowPos(new Vec2(980, 360), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(320, 0), ImGui.Cond.Once);
          let textureDetailOpen = true;
          ImGui.Begin(
            'Texture Detail',
            (value = textureDetailOpen) => {
              textureDetailOpen = value;
              return value;
            },
            ImGui.WindowFlags.AlwaysAutoResize,
          );
          if (!textureDetailOpen) {
            selectedTextureDetailRef.current = null;
            setSelectedTextureDetail(null);
            ImGui.End();
          } else {
            const texDetail = selectedTextureDetailRef.current;
            ImGui.Text(`name = ${texDetail.name}`);
            ImGui.Text(`txd = ${texDetail.txdName}`);
            ImGui.Text(`compress = ${texDetail.compressionMethod}`);
            ImGui.Text(`pixel format = ${texDetail.pixelFormat}`);
            ImGui.Text(`size = ${texDetail.width} x ${texDetail.height}`);
            ImGui.Separator();
            const texId = getImguiTextureForImage(texDetail.texture);
            if (texId && texDetail.width > 0 && texDetail.height > 0) {
              const maxPreview = 256;
              const aspect = texDetail.width / texDetail.height;
              const previewW = aspect >= 1 ? maxPreview : (maxPreview * aspect);
              const previewH = aspect >= 1 ? (maxPreview / aspect) : maxPreview;
              ImGui.Image(texId, new Vec2(previewW, previewH));
            } else {
              ImGui.TextUnformatted('Preview unavailable');
            }
            ImGui.End();
          }
        }

        if (isWindowOpen('statistics')) {
          try {
            ImGui.SetNextWindowPos(new Vec2(460, 270), ImGui.Cond.Once);
            ImGui.SetNextWindowSize(new Vec2(360, 180), ImGui.Cond.Once);
            ImGui.Begin(
              'Statistics',
              (value = isWindowOpen('statistics')) => setWindowOpen('statistics', value),
            );
            const fpsValues = fpsHistoryRef.current;
            let fpsMin = Number.POSITIVE_INFINITY;
            let fpsMax = 0;
            let fpsSum = 0;
            let fpsCount = 0;
            for (let i = 0; i < fpsValues.length; i += 1) {
              const value = fpsValues[i];
              if (value <= 0) continue;
              fpsMin = Math.min(fpsMin, value);
              fpsMax = Math.max(fpsMax, value);
              fpsSum += value;
              fpsCount += 1;
            }
            const fpsAvg = fpsCount > 0 ? (fpsSum / fpsCount) : 0;
            const fpsCurrentIndex = (fpsHistoryIndexRef.current - 1 + fpsValues.length) % fpsValues.length;
            const fpsCurrent = fpsValues[fpsCurrentIndex] || 0;
            ImGui.Text(`FPS: ${fpsCurrent.toFixed(1)} | avg ${fpsAvg.toFixed(1)} | min ${fpsCount > 0 ? fpsMin.toFixed(1) : '0.0'} | max ${fpsMax.toFixed(1)}`);
            ImGui.Text('FPS Graph');
            const fpsPlotValues = Array.from({ length: fpsValues.length }, (_, i) => {
              const idx = (fpsHistoryIndexRef.current + i) % fpsValues.length;
              const value = fpsValues[idx];
              return value > 0 ? value : fpsCurrent;
            });
            const fpsPlotMin = fpsCount > 0 ? Math.max(0, fpsMin * 0.9) : 0;
            const fpsPlotMax = Math.max(fpsPlotMin + 1, fpsMax * 1.1, fpsAvg * 1.1, fpsCurrent * 1.1, 60);
            ImGui.PlotLines(
              '##fps-plot',
              (values = fpsPlotValues, idx) => values[idx],
              fpsPlotValues,
              fpsPlotValues.length,
              0,
              '',
              fpsPlotMin,
              fpsPlotMax,
              new Vec2(-1, 120),
            );
            ImGui.End();
          } catch (error) {
            pushConsoleLine('error', `Statistics window error: ${formatConsoleArg(error)}`);
            setWindowOpen('statistics', false);
          }
        }

        if (isWindowOpen('console')) {
          ImGui.SetNextWindowPos(new Vec2(16, 370), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(720, 260), ImGui.Cond.Once);
          ImGui.Begin(
            'Console',
            (value = isWindowOpen('console')) => setWindowOpen('console', value),
          );
          if (ImGui.Button('Clear logs')) {
            setConsoleLines([]);
            setFailedModels([]);
          }
          ImGui.SameLine();
          ImGui.Text(`Lines: ${consoleLinesRef.current.length}`);
          ImGui.Separator();
          if (ImGui.BeginTabBar('console-tabs')) {
            if (ImGui.BeginTabItem('Console')) {
              ImGui.BeginChild('console-scroll', new Vec2(0, 0), true);
              const lines = consoleLinesRef.current;
              const start = Math.max(0, lines.length - 500);
              let text = lines
                .slice(start)
                .map((line) => `[${line.ts}] [${line.level.toUpperCase()}] [${line.source}] ${line.message}`)
                .join('\n');
              ImGui.InputTextMultiline(
                '##console-text',
                (value = text) => { text = value; return text; },
                Math.max(4096, text.length + 1),
                new Vec2(-1, -1),
                ImGui.InputTextFlags.ReadOnly,
              );
              ImGui.EndChild();
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('Files')) {
              ImGui.BeginChild('console-files-scroll', new Vec2(0, 0), true);
              const files = loadedFilesRef.current.filter((entry) => {
                const detail = String(entry.detail || '').trim().toLowerCase();
                if (!detail) return false;
                if (detail === 'declared' || detail === 'required' || detail === 'found') return false;
                if (detail.includes('missing')) return false;
                return true;
              });
              const start = Math.max(0, files.length - 1000);
              let text = files
                .slice(start)
                .map((entry) => {
                  const detail = entry.detail ? ` (${entry.detail})` : '';
                  return `[${entry.kind}] ${entry.path}${detail}`;
                })
                .join('\n');
              ImGui.InputTextMultiline(
                '##files-text',
                (value = text) => { text = value; return text; },
                Math.max(4096, text.length + 1),
                new Vec2(-1, -1),
                ImGui.InputTextFlags.ReadOnly,
              );
              ImGui.EndChild();
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('Error')) {
              ImGui.BeginChild('console-error-scroll', new Vec2(0, 0), true);
              const errorLines = consoleLinesRef.current.filter((line) => line.level === 'error');
              const start = Math.max(0, errorLines.length - 500);
              let text = errorLines
                .slice(start)
                .map((line) => `[${line.ts}] [${line.source}] ${line.message}`)
                .join('\n');
              ImGui.InputTextMultiline(
                '##error-text',
                (value = text) => { text = value; return text; },
                Math.max(4096, text.length + 1),
                new Vec2(-1, -1),
                ImGui.InputTextFlags.ReadOnly,
              );
              ImGui.EndChild();
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('Failed')) {
              ImGui.BeginChild('console-failed-scroll', new Vec2(0, 0), true);
              const entries = failedModelsRef.current;
              const start = Math.max(0, entries.length - 2000);
              let text = entries
                .slice(start)
                .join('\n');
              ImGui.InputTextMultiline(
                '##failed-text',
                (value = text) => { text = value; return text; },
                Math.max(4096, text.length + 1),
                new Vec2(-1, -1),
                ImGui.InputTextFlags.ReadOnly,
              );
              ImGui.EndChild();
              ImGui.EndTabItem();
            }
            ImGui.EndTabBar();
          }
          ImGui.End();
        }

        if (isWindowOpen('rendering')) {
          ImGui.SetNextWindowPos(new Vec2(460, 16), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(320, 240), ImGui.Cond.Once);
          ImGui.Begin(
            'Rendering',
            (value = isWindowOpen('rendering')) => setWindowOpen('rendering', value),
          );
          if (ImGui.BeginTabBar('rendering-tabs')) {
            if (ImGui.BeginTabItem('Pipeline')) {
              ImGui.Checkbox(
                'Disable Backface Culling',
                (value = uiStateRef.current.disableBackfaceCulling) => (uiStateRef.current.disableBackfaceCulling = value),
              );
              const defaultOpen = ImGui.TreeNodeFlags?.DefaultOpen ?? 0;
              if (ImGui.CollapsingHeader('Water', defaultOpen)) {
                ImGui.TextWrapped('Wave Height is the RW-style master control for visible water motion. Far water stays flat; near water and the local wavy sector use this value.');
                ImGui.Checkbox(
                  'Render Water',
                  (value = uiStateRef.current.renderWater) => (uiStateRef.current.renderWater = value),
                );
                ImGui.Checkbox(
                  'Show Wavy Sector',
                  (value = uiStateRef.current.waterShowWavy) => (uiStateRef.current.waterShowWavy = value),
                );
                ImGui.Checkbox(
                  'Show Wake Layer',
                  (value = uiStateRef.current.waterShowWake) => (uiStateRef.current.waterShowWake = value),
                );
                const renderWaterSliderRow = (id, label, getter, setter, min, max, format = '%.2f') => {
                  ImGui.PushID(id);
                  ImGui.Columns(2, `water-row-${id}`, false);
                  ImGui.SetColumnWidth(0, 170);
                  ImGui.PushItemWidth(-1);
                  ImGui.SliderFloat(
                    '##value',
                    (value = getter()) => {
                      setter(value);
                      return value;
                    },
                    min,
                    max,
                    format,
                  );
                  ImGui.PopItemWidth();
                  ImGui.NextColumn();
                  ImGui.AlignTextToFramePadding();
                  ImGui.TextUnformatted(label);
                  ImGui.Columns(1);
                  ImGui.PopID();
                };
                renderWaterSliderRow(
                  'uv-speed',
                  'Main Scroll Speed',
                  () => uiStateRef.current.waterUvSpeed,
                  (value) => { uiStateRef.current.waterUvSpeed = value; },
                  0,
                  4,
                );
                renderWaterSliderRow(
                  'wave-height',
                  'Wave Height',
                  () => uiStateRef.current.waterWaveHeight,
                  (value) => { uiStateRef.current.waterWaveHeight = value; },
                  0,
                  100,
                  '%.0f',
                );
                renderWaterSliderRow(
                  'near-alpha',
                  'Near Layer Alpha',
                  () => uiStateRef.current.waterNearAlpha,
                  (value) => { uiStateRef.current.waterNearAlpha = value; },
                  0,
                  1,
                );
                renderWaterSliderRow(
                  'wavy-alpha',
                  'Wavy Sector Alpha',
                  () => uiStateRef.current.waterWavyAlpha,
                  (value) => { uiStateRef.current.waterWavyAlpha = value; },
                  0,
                  1,
                );
                renderWaterSliderRow(
                  'wake-alpha',
                  'Wake Layer Alpha',
                  () => uiStateRef.current.waterWakeAlpha,
                  (value) => { uiStateRef.current.waterWakeAlpha = value; },
                  0,
                  1,
                );
              }
              ImGui.EndTabItem();
            }
            if (ImGui.BeginTabItem('Backend')) {
              ImGui.Text(`WebGPU: ${WebGPU.isAvailable() ? 'available' : 'unavailable'}`);
              const backendOptions = ['WebGL', 'WebGPU'];
              if (ImGui.BeginCombo('Graphics Backend', uiStateRef.current.backendSelection)) {
                for (const option of backendOptions) {
                  const selected = uiStateRef.current.backendSelection === option;
                  const disableOption = option === 'WebGPU' && !WebGPU.isAvailable();
                  if (disableOption) ImGui.BeginDisabled();
                  if (ImGui.Selectable(option, selected)) {
                    uiStateRef.current.backendSelection = option;
                  }
                  if (disableOption) ImGui.EndDisabled();
                  if (selected) ImGui.SetItemDefaultFocus();
                }
                ImGui.EndCombo();
              }
              ImGui.Text(`Active: ${activeBackend}`);
              const backendChanged = uiStateRef.current.backendSelection !== activeBackend;
              if (!backendChanged) ImGui.BeginDisabled();
              if (ImGui.Button('Apply Backend')) {
                pushConsoleLine('info', `Switch backend: ${activeBackend} -> ${uiStateRef.current.backendSelection}`);
                setStatus(`Switching backend to ${uiStateRef.current.backendSelection}...`);
                backendSwitchingRef.current = true;
                setActiveBackend(uiStateRef.current.backendSelection);
                setShowGameIcon(false);
              }
              if (!backendChanged) ImGui.EndDisabled();
              ImGui.TextWrapped('Switching backend recreates renderer. Rebuild map afterwards.');
              ImGui.EndTabItem();
            }
            ImGui.EndTabBar();
          }
          ImGui.End();
        }

        if (isWindowOpen('about')) {
          ImGui.SetNextWindowPos(new Vec2(80, 70), ImGui.Cond.Once);
          ImGui.SetNextWindowSize(new Vec2(320, 0), ImGui.Cond.Once);
          ImGui.Begin(
            'About',
            (value = isWindowOpen('about')) => setWindowOpen('about', value),
            ImGui.WindowFlags.AlwaysAutoResize,
          );
          ImGui.Text('GTA Map Renderer');
          ImGui.Separator();
          ImGui.Text('Author: Nurupo');
          ImGui.End();
        }

          ImGui.EndFrame();
          ImGui.Render();
          ImGui_Impl.RenderDrawData(ImGui.GetDrawData());
          if (renderer.state && typeof renderer.state.reset === 'function') {
            renderer.state.reset();
          }
        } catch (error) {
          console.error('ImGui runtime error:', error);
          pushConsoleLine('error', `ImGui runtime error: ${formatConsoleArg(error)}`);
          imguiRef.current = { ImGui: null, ImGui_Impl: null, ready: false };
          imguiCaptureRef.current = { mouse: false, keyboard: false };
        }
      }

      rafId = window.requestAnimationFrame(animate);
    };

    const worldRoot = worldRootRef.current;

    const initImGui = async () => {
      if (imguiRef.current.ready) {
        backendSwitchingRef.current = false;
        return;
      }
      try {
        const imguiModule = await import('imgui-js');
        const implModule = await import('imgui-js/dist/imgui_impl.umd.js');

        const imguiCandidates = [
          imguiModule,
          imguiModule?.default,
          imguiModule?.default?.default,
        ];
        const ImGui = imguiCandidates.find(
          (candidate) =>
            candidate &&
            typeof candidate.CreateContext === 'function' &&
            typeof candidate.NewFrame === 'function',
        );
        if (!ImGui) {
          throw new Error('Could not resolve ImGui API namespace');
        }

        const initCandidates = [
          imguiModule?.default,
          ImGui?.default,
          imguiModule,
        ];
        const initImGuiRuntime = initCandidates.find((candidate) => typeof candidate === 'function');
        if (typeof initImGuiRuntime !== 'function') {
          throw new Error('Could not resolve ImGui runtime init function');
        }
        await initImGuiRuntime();

        const implCandidates = [
          implModule,
          implModule?.default,
          implModule?.default?.default,
        ];
        const ImGui_Impl = implCandidates.find(
          (candidate) =>
            candidate &&
            typeof candidate.Init === 'function' &&
            typeof candidate.NewFrame === 'function' &&
            typeof candidate.RenderDrawData === 'function',
        );
        if (!ImGui_Impl) {
          throw new Error('Could not resolve ImGui implementation backend');
        }

        if (!mounted) return;

        const checkVersion = ImGui.CHECKVERSION ?? ImGui.IMGUI_CHECKVERSION;
        if (typeof checkVersion === 'function') {
          checkVersion();
        }
        ImGui.CreateContext();
        ImGui.StyleColorsDark();
        const imguiGlContext = imguiCanvas.getContext('webgl2', {
          alpha: true,
          antialias: true,
          premultipliedAlpha: true,
        }) || imguiCanvas.getContext('webgl', {
          alpha: true,
          antialias: true,
          premultipliedAlpha: true,
        });
        if (!imguiGlContext) {
          throw new Error('Failed to create ImGui WebGL context');
        }
        imguiGlRef.current = imguiGlContext;
        ImGui_Impl.Init(imguiGlContext);

        imguiRef.current = { ImGui, ImGui_Impl, ready: true };
        backendSwitchingRef.current = false;
      } catch (error) {
        console.error('imgui-js init error:', error);
        setStatus(`imgui-js failed to initialize: ${error?.message ?? 'unknown error'}`);
      }
    };

    initImGui();
    rafId = window.requestAnimationFrame(animate);

    return () => {
      mounted = false;
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('contextmenu', onContextMenu);

      const { ImGui, ImGui_Impl, ready } = imguiRef.current;
      if (appUnmountingRef.current && ready && ImGui && ImGui_Impl) {
        try {
          resetImguiTextureCache();
          ImGui_Impl.Shutdown();
          ImGui.DestroyContext();
        } catch {
          // Ignore context teardown errors during app shutdown.
        }
        imguiRef.current = { ImGui: null, ImGui_Impl: null, ready: false };
        imguiCaptureRef.current = { mouse: false, keyboard: false };
      }
      backendSwitchingRef.current = true;
      playerModeManager.destroy();
      orbitControls.dispose();

      if (renderer && typeof renderer.dispose === 'function') renderer.dispose();
      Object.values(iconTextures).forEach((texture) => texture.dispose());
      iconMaterial.dispose();
      imguiGlRef.current = null;
      rwWaterPipelineRef.current?.dispose();
      rwWaterPipelineRef.current = null;
      disposeWorld(worldRoot);
    };
  }, [activeBackend, clearWorld, isWindowOpen, pushConsoleLine, rebuildWorld, resetImguiTextureCache, setWindowOpen]);

  const fileSummary = useMemo(() => `Indexed files: ${stats.files}`, [stats.files]);

  return (
    <div className="app-root" ref={containerRef}>
      <canvas key={`renderer-${activeBackend}`} ref={canvasRef} className="viewport" />
      <canvas ref={imguiCanvasRef} className="imgui-overlay" />

      <div className="hud">
        <label className="picker">
          <span>Pick extracted GTA folder</span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            webkitdirectory="true"
            directory="true"
            onChange={onPickFolder}
          />
        </label>

        <button type="button" onClick={rebuildWorld}>Build World</button>
        <button type="button" onClick={clearWorld}>Clear</button>
        <p>{fileSummary}</p>
        <p>{status}</p>
      </div>
    </div>
  );
}

export default App;
