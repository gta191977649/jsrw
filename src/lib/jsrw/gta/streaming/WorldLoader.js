import { GTADatLoader } from '../dat/GTADatLoader.js';
import { IdeLoader } from '../ide/IdeLoader.js';
import { IdeRegistry } from '../ide/IdeRegistry.js';
import { IplLoader } from '../ipl/IplLoader.js';
import { IplRegistry } from '../ipl/IplRegistry.js';
import { ColLoader } from '../col/ColLoader.js';
import { ColRegistry } from '../col/ColRegistry.js';
import { MapZoneLoader } from '../zone/MapZoneLoader.js';
import { MapZoneRegistry } from '../zone/MapZoneRegistry.js';
import { TimecycLoader } from '../loaders/TimecycLoader.js';
import { WaterproLoader } from '../loaders/WaterproLoader.js';
import { ObjectDatLoader } from '../loaders/ObjectDatLoader.js';
import { ImgArchiveManager } from '../modelinfo/ImgArchiveManager.js';
import { TxdRegistry } from '../modelinfo/TxdRegistry.js';
import { DffRegistry } from '../modelinfo/DffRegistry.js';
import { TextureResolver } from '../modelinfo/TextureResolver.js';
import { ModelResolver } from '../modelinfo/ModelResolver.js';
import { WeatherBuilder } from '../world/builders/WeatherBuilder.js';
import { WaterBuilder } from '../world/builders/WaterBuilder.js';
import { WorldBuilder } from '../world/builders/WorldBuilder.js';
import { createWorldContext } from '../world/WorldContext.js';
import { normalizePath, stripExtension } from '../modelinfo/ResourceLocator.js';

const DEFAULT_DAT_PATH = 'data/gta.dat';
const DEFAULT_OBJECT_DAT_PATH = 'data/object.dat';
const DEFAULT_TIMECYC_PATH = 'data/timecyc.dat';
const DEFAULT_WATERPRO_PATH = 'data/waterpro.dat';
const DEFAULT_IMG_PATHS = Object.freeze([
  'models/gta3.img',
  'models/gta_int.img',
  'models/player.img',
]);
const OPTIONAL_DEFAULT_IMG_PATHS = new Set([
  'models/gta_int.img',
  'models/player.img',
]);
const DEFAULT_TEXTURE_PATHS = Object.freeze([
  'models/generic.txd',
  'models/particle.txd',
]);
const DEFAULT_COL_DIR = 'models/coll';

function sanitizeImgList(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(#|;|\/\/).*$/g, '').trim())
    .filter(Boolean)
    .map((line) => normalizePath(line));
}

function countLoadedEntries(entries = []) {
  return entries.filter((entry) => entry?.found).length;
}

export class WorldLoader {
  constructor(options = {}) {
    this.fileSystem = options.fileSystem;
    this.gameVersion = String(options.gameVersion || 'VCS').toUpperCase();
    this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
    this.onFileEvent = typeof options.onFileEvent === 'function' ? options.onFileEvent : null;
    this.datLoader = options.datLoader || new GTADatLoader();
    this.ideLoader = options.ideLoader || new IdeLoader();
    this.iplLoader = options.iplLoader || new IplLoader({ gameVersion: this.gameVersion });
    this.colLoader = options.colLoader || new ColLoader();
    this.mapZoneLoader = options.mapZoneLoader || new MapZoneLoader();
    this.timecycLoader = options.timecycLoader || new TimecycLoader({ gameVersion: this.gameVersion });
    this.waterproLoader = options.waterproLoader || new WaterproLoader({ gameVersion: this.gameVersion });
    this.objectDatLoader = options.objectDatLoader || new ObjectDatLoader();
    this.weatherBuilder = options.weatherBuilder || new WeatherBuilder();
    this.waterBuilder = options.waterBuilder || new WaterBuilder();
    this.worldBuilder = options.worldBuilder || new WorldBuilder();
  }

  async load(options = {}) {
    const datRecord = this.resolveByPath('DAT', options.datPath || DEFAULT_DAT_PATH, {
      declaredDetail: 'required',
      foundDetail: 'loaded',
      missingDetail: 'missing',
      warnOnMissing: false,
    });
    if (!datRecord) {
      throw new Error('gta.dat not found in selected files');
    }

    const manifest = this.datLoader.parse(await datRecord.file.text(), {
      sourcePath: datRecord.resolvedPath,
    });
    this.onLog?.(
      'info',
      `gta.dat parsed: IDE ${manifest.ideFiles.length}, IPL ${manifest.iplFiles.length}, IMG ${manifest.cdImages.length + manifest.imgs.length}, IMAGEPATH ${manifest.imagePaths.length}`,
    );

    const expandedImgPaths = await this.collectImgPaths(manifest, options.extraImgPaths || []);
    const texturePaths = this.collectTexturePaths(manifest);
    const staticColPaths = this.discoverStaticColPaths();
    const imgArchives = new ImgArchiveManager();
    await this.mountArchives(expandedImgPaths, imgArchives);
    const textureSourceIndex = this.buildTextureSourceIndex(texturePaths, imgArchives);

    const ideRegistry = await this.loadIdeDefinitions(manifest);
    const iplRegistry = await this.loadIplDefinitions(manifest);
    const colRegistry = await this.loadColDefinitions(manifest, staticColPaths);
    const mapZoneRegistry = await this.loadMapZones(manifest);
    const timecyc = await this.loadOptionalTimecyc(options.timecycPath || DEFAULT_TIMECYC_PATH);
    const water = await this.loadOptionalWater(options.waterPath || DEFAULT_WATERPRO_PATH);
    const objectDat = await this.loadOptionalObjectDat(options.objectDatPath || DEFAULT_OBJECT_DAT_PATH);

    const textureResolver = new TextureResolver({
      fileSystem: this.fileSystem,
      imgArchives,
      registry: new TxdRegistry(),
      imagePaths: texturePaths,
      sourceIndex: textureSourceIndex,
      onLog: this.onLog,
    });
    const modelResolver = new ModelResolver({
      fileSystem: this.fileSystem,
      imgArchives,
      textureResolver,
      registry: new DffRegistry(),
    });

    const defaultResources = this.buildDefaultResourceSummary({
      manifest,
      imgPaths: expandedImgPaths,
      texturePaths,
      staticColPaths,
      textureSourceIndex,
    });
    this.logDefaultResourceSummary(defaultResources);

    const context = createWorldContext({
      gameVersion: this.gameVersion,
      fileSystem: this.fileSystem,
      manifest,
      imgArchives,
      textureResolver,
      modelResolver,
      ideRegistry,
      iplRegistry,
      colRegistry,
      defaultResources,
      mapZoneRegistry,
      timecyc: timecyc?.data || null,
      timecycSourcePath: timecyc?.sourcePath || '',
      water: water?.data || null,
      waterConfig: water?.config || null,
      waterSourcePath: water?.sourcePath || '',
      objectDat: objectDat?.raw || null,
      objectDatSourcePath: objectDat?.sourcePath || '',
    });

    const build = {
      weather: await this.weatherBuilder.build(context),
      water: await this.waterBuilder.build(context),
      world: await this.worldBuilder.build(context),
    };

    return {
      context,
      build,
      stats: {
        ideFiles: ideRegistry.files.length,
        iplFiles: iplRegistry.files.length,
        ideDefs: ideRegistry.size,
        ideEffects: ideRegistry.effectsCount,
        iplInst: iplRegistry.size,
        defaultResources,
      },
    };
  }

  resolveByPath(kind, pathHint, options = {}) {
    const {
      declaredDetail = 'declared',
      foundDetail = 'found',
      missingDetail = 'missing',
      warnOnMissing = true,
    } = options;
    const requestedPath = String(pathHint || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
    const normalizedPath = normalizePath(pathHint);
    if (declaredDetail) this.onFileEvent?.(kind, requestedPath || normalizedPath, declaredDetail);
    const record = this.fileSystem.findByPath(normalizedPath);
    if (!record) {
      this.onFileEvent?.(kind, requestedPath || normalizedPath, missingDetail);
      if (warnOnMissing) this.onLog?.('warn', `${kind} missing: ${normalizedPath}`);
      return null;
    }
    this.onFileEvent?.(kind, record.resolvedPath, foundDetail);
    return record;
  }

  async collectImgPaths(manifest, extraImgPaths = []) {
    const orderedPaths = [];
    const knownPaths = new Set();
    const registerPath = (pathHint) => {
      const normalizedPath = normalizePath(pathHint);
      if (!normalizedPath || knownPaths.has(normalizedPath)) return;
      knownPaths.add(normalizedPath);
      orderedPaths.push(normalizedPath);
    };

    DEFAULT_IMG_PATHS.forEach(registerPath);
    extraImgPaths.forEach(registerPath);
    manifest.cdImages.forEach(registerPath);
    manifest.imgs.forEach(registerPath);

    for (const imgListPath of manifest.imgLists) {
      const listRecord = this.resolveByPath('IMGLIST', imgListPath, {
        foundDetail: 'loaded',
        missingDetail: 'missing',
      });
      if (!listRecord) continue;
      const listEntries = sanitizeImgList(await listRecord.file.text());
      listEntries.forEach(registerPath);
      this.onLog?.('info', `IMGLIST loaded: ${listRecord.resolvedPath} (${listEntries.length} archives)`);
    }

    return orderedPaths;
  }

  collectTexturePaths(manifest) {
    const orderedPaths = [];
    const knownPaths = new Set();
    const registerPath = (pathHint) => {
      const normalizedPath = normalizePath(pathHint);
      if (!normalizedPath || knownPaths.has(normalizedPath)) return;
      knownPaths.add(normalizedPath);
      orderedPaths.push(normalizedPath);
    };

    DEFAULT_TEXTURE_PATHS.forEach(registerPath);
    manifest.imagePaths.forEach(registerPath);
    return orderedPaths;
  }

  async mountArchives(imgPaths, imgArchives) {
    for (const imgPath of imgPaths) {
      const normalizedImgPath = normalizePath(imgPath);
      const isOptionalDefaultArchive = OPTIONAL_DEFAULT_IMG_PATHS.has(normalizedImgPath);
      const imgRecord = this.resolveByPath('IMG', imgPath, {
        foundDetail: 'found',
        missingDetail: 'missing img',
        warnOnMissing: !isOptionalDefaultArchive,
      });
      if (!imgRecord) continue;

      const dirRecord = this.resolveByPath('DIR', imgPath.replace(/\.img$/i, '.dir'), {
        foundDetail: 'found',
        missingDetail: 'missing dir',
        warnOnMissing: false,
      });
      if (!dirRecord) {
        this.onLog?.('warn', `IMG directory missing: ${imgPath.replace(/\.img$/i, '.dir')}`);
        continue;
      }

      const parsed = await imgArchives.mount(imgRecord, dirRecord, imgPath);
      this.onFileEvent?.('IMG', imgRecord.resolvedPath, `${parsed.total} entries`);
      this.onLog?.(
        'info',
        `IMG loaded: ${imgPath} (${parsed.total} entries${parsed.overridden > 0 ? `, override ${parsed.overridden}` : ''})`,
      );
    }
  }

  buildTextureSourceIndex(texturePaths = [], imgArchives) {
    const index = new Map();
    const requestedPaths = new Set(texturePaths.map((path) => normalizePath(path)));
    const explicitTextureRecords = [];
    const fileRecords = this.fileSystem?.listByExtension?.('txd') || [];
    const sortKey = (record) => {
      const path = normalizePath(record?.resolvedPath || '');
      return requestedPaths.has(path) ? 1 : 2;
    };

    for (const texturePath of texturePaths) {
      const record = this.resolveByPath('TXD', texturePath, {
        foundDetail: 'loaded',
        missingDetail: 'missing',
        warnOnMissing: false,
      });
      if (!record) continue;
      explicitTextureRecords.push(record);
      const normalizedName = stripExtension(record.basename || record.resolvedPath || '');
      if (!normalizedName) continue;
      index.set(normalizedName, {
        kind: 'file',
        record,
        sourcePath: record.resolvedPath || '',
      });
    }

    const imgAssetNames = imgArchives?.listAssets?.('txd') || [];
    for (const assetName of imgAssetNames) {
      const normalizedName = stripExtension(assetName);
      if (!normalizedName) continue;
      index.set(normalizedName, {
        kind: 'img',
        name: normalizedName,
        sourcePath: imgArchives.getAssetSource(normalizedName, 'txd') || '',
      });
    }

    fileRecords
      .slice()
      .sort((a, b) => {
        const keyDiff = sortKey(a) - sortKey(b);
        if (keyDiff !== 0) return keyDiff;
        return String(a.resolvedPath || '').localeCompare(String(b.resolvedPath || ''));
      })
      .forEach((record) => {
        const normalizedName = stripExtension(record.basename || record.resolvedPath || '');
        if (!normalizedName) return;
        if (index.has(normalizedName)) return;
        index.set(normalizedName, {
          kind: 'file',
          record,
          sourcePath: record.resolvedPath || '',
        });
      });

    return index;
  }

  buildDefaultResourceSummary({ manifest, imgPaths = [], texturePaths = [], staticColPaths = [], textureSourceIndex = null }) {
    const defaultImgEntries = DEFAULT_IMG_PATHS.map((pathHint) => {
      const record = this.fileSystem?.findByPath?.(pathHint) || null;
      const dirPath = pathHint.replace(/\.img$/i, '.dir');
      const dirRecord = this.fileSystem?.findByPath?.(dirPath) || null;
      return {
        path: normalizePath(pathHint),
        kind: 'img',
        optional: OPTIONAL_DEFAULT_IMG_PATHS.has(normalizePath(pathHint)),
        declaredInManifest: manifest.cdImages.includes(pathHint) || manifest.imgs.includes(pathHint),
        requested: imgPaths.includes(normalizePath(pathHint)),
        found: Boolean(record),
        hasDirectory: Boolean(dirRecord),
        mounted: Boolean(record && dirRecord),
        sourcePath: record?.resolvedPath || '',
        directoryPath: dirRecord?.resolvedPath || '',
      };
    });

    const defaultTextureEntries = DEFAULT_TEXTURE_PATHS.map((pathHint) => {
      const record = this.fileSystem?.findByPath?.(pathHint) || null;
      return {
        path: normalizePath(pathHint),
        kind: 'txd',
        declaredInManifest: manifest.imagePaths.includes(pathHint),
        requested: texturePaths.includes(normalizePath(pathHint)),
        found: Boolean(record),
        sourcePath: record?.resolvedPath || '',
      };
    });

    const staticColEntries = staticColPaths.map((pathHint) => {
      const record = this.fileSystem?.findByPath?.(pathHint) || null;
      return {
        path: normalizePath(pathHint),
        kind: 'col',
        found: Boolean(record),
        sourcePath: record?.resolvedPath || '',
      };
    });

    return {
      imgArchives: defaultImgEntries,
      textures: defaultTextureEntries,
      collisionDirectory: {
        path: DEFAULT_COL_DIR,
        files: staticColEntries,
        fileCount: staticColEntries.length,
        loadedCount: countLoadedEntries(staticColEntries),
      },
      counts: {
        imgRequested: defaultImgEntries.filter((entry) => entry.requested).length,
        imgMounted: defaultImgEntries.filter((entry) => entry.mounted).length,
        textureRequested: defaultTextureEntries.filter((entry) => entry.requested).length,
        textureFound: countLoadedEntries(defaultTextureEntries),
        collisionFound: countLoadedEntries(staticColEntries),
        textureIndexed: textureSourceIndex?.size || 0,
      },
    };
  }

  logDefaultResourceSummary(defaultResources) {
    if (!defaultResources) return;

    for (const entry of defaultResources.imgArchives || []) {
      if (entry.mounted) {
        this.onLog?.('info', `Default IMG ready: ${entry.path}`);
      } else if (!entry.optional) {
        this.onLog?.('warn', `Default IMG unavailable: ${entry.path}`);
      }
    }

    for (const entry of defaultResources.textures || []) {
      if (entry.found) {
        this.onLog?.('info', `Default TXD ready: ${entry.path}`);
      } else {
        this.onLog?.('warn', `Default TXD unavailable: ${entry.path}`);
      }
    }

    if (defaultResources.collisionDirectory?.fileCount > 0) {
      this.onLog?.(
        'info',
        `Default COL directory ready: ${defaultResources.collisionDirectory.path} (${defaultResources.collisionDirectory.loadedCount} files)`,
      );
    }
  }

  async loadIdeDefinitions(manifest) {
    const registry = new IdeRegistry();

    for (const pathHint of manifest.ideFiles) {
      const record = this.resolveByPath('IDE', pathHint, {
        foundDetail: 'found',
        missingDetail: 'missing',
      });
      if (!record) continue;
      this.onLog?.('info', `Loading IDE: ${record.requestedPath}`);
      const { sourcePath, parsed } = await this.ideLoader.load(record);
      registry.addParsed(parsed, sourcePath);
      this.onFileEvent?.('IDE', sourcePath, 'loaded');
      let effectCount = 0;
      for (const effects of parsed?.effectsById?.values?.() || []) {
        effectCount += Array.isArray(effects) ? effects.length : 0;
      }
      if (effectCount > 0) {
        this.onFileEvent?.('2DFX', sourcePath, `${effectCount} effects`);
        this.onLog?.('info', `2DFX parsed: ${sourcePath} (${effectCount} effects)`);
      }
    }

    return registry;
  }

  async loadIplDefinitions(manifest) {
    const registry = new IplRegistry();

    for (const pathHint of manifest.iplFiles) {
      const record = this.resolveByPath('IPL', pathHint, {
        foundDetail: 'found',
        missingDetail: 'missing',
      });
      if (!record) continue;
      this.onLog?.('info', `Loading IPL: ${record.requestedPath}`);
      const { sourcePath, placements } = await this.iplLoader.load(record);
      registry.addPlacements(sourcePath, placements);
      this.onFileEvent?.('IPL', sourcePath, 'loaded');
    }

    return registry;
  }

  async loadColDefinitions(manifest, staticColPaths = []) {
    const registry = new ColRegistry();
    const orderedPaths = [];
    const knownPaths = new Set();
    const registerPath = (pathHint) => {
      const normalizedPath = normalizePath(pathHint);
      if (!normalizedPath || knownPaths.has(normalizedPath)) return;
      knownPaths.add(normalizedPath);
      orderedPaths.push(normalizedPath);
    };

    manifest.colFiles.forEach(registerPath);
    staticColPaths.forEach(registerPath);

    for (const pathHint of orderedPaths) {
      const record = this.resolveByPath('COLFILE', pathHint, {
        foundDetail: 'found',
        missingDetail: 'missing',
        warnOnMissing: false,
      });
      if (!record) continue;
      registry.add(await this.colLoader.load(record));
      this.onFileEvent?.('COLFILE', record.resolvedPath, 'loaded');
    }

    return registry;
  }

  discoverStaticColPaths() {
    const records = this.fileSystem?.listByPathPrefix?.(DEFAULT_COL_DIR) || [];
    const colPaths = records
      .map((record) => record.resolvedPath)
      .filter((path) => /\.col$/i.test(path));

    if (colPaths.length > 0) {
      this.onLog?.('info', `Static COL directory discovered: ${DEFAULT_COL_DIR} (${colPaths.length} files)`);
    }

    return colPaths;
  }

  async loadMapZones(manifest) {
    const registry = new MapZoneRegistry();

    for (const pathHint of manifest.mapZones) {
      const record = this.resolveByPath('MAPZONE', pathHint, {
        foundDetail: 'found',
        missingDetail: 'missing',
        warnOnMissing: false,
      });
      if (!record) continue;
      registry.add(await this.mapZoneLoader.load(record));
      this.onFileEvent?.('MAPZONE', record.resolvedPath, 'loaded');
    }

    return registry;
  }

  async loadOptionalTimecyc(pathHint) {
    const record = this.resolveByPath('DAT', pathHint, {
      declaredDetail: 'optional',
      foundDetail: 'loaded',
      missingDetail: 'missing optional',
      warnOnMissing: false,
    });
    if (!record) {
      this.onLog?.('warn', 'timecyc.dat not found. Fog/timecycle disabled.');
      return null;
    }

    try {
      return await this.timecycLoader.load(record);
    } catch (error) {
      this.onLog?.('warn', `timecyc.dat parse failed: ${error?.message || error}`);
      return null;
    }
  }

  async loadOptionalWater(pathHint) {
    const record = this.resolveByPath('DAT', pathHint, {
      declaredDetail: 'optional',
      foundDetail: 'loaded',
      missingDetail: 'missing optional',
      warnOnMissing: false,
    });
    if (!record) {
      this.onLog?.('warn', 'waterpro.dat not found. Water rendering disabled.');
      return null;
    }

    try {
      return await this.waterproLoader.load(record);
    } catch (error) {
      this.onLog?.('warn', `waterpro.dat parse failed: ${error?.message || error}`);
      return null;
    }
  }

  async loadOptionalObjectDat(pathHint) {
    const record = this.resolveByPath('DAT', pathHint, {
      declaredDetail: 'optional',
      foundDetail: 'loaded',
      missingDetail: 'missing optional',
      warnOnMissing: false,
    });
    if (!record) return null;

    try {
      return await this.objectDatLoader.load(record);
    } catch (error) {
      this.onLog?.('warn', `object.dat parse failed: ${error?.message || error}`);
      return null;
    }
  }
}
