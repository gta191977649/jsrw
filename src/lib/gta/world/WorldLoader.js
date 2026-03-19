import { GTADatLoader } from '../dat/GTADatLoader';
import { IdeLoader } from '../ide/IdeLoader';
import { IdeRegistry } from '../ide/IdeRegistry';
import { IplLoader } from '../ipl/IplLoader';
import { IplRegistry } from '../ipl/IplRegistry';
import { ColLoader } from '../col/ColLoader';
import { ColRegistry } from '../col/ColRegistry';
import { MapZoneLoader } from '../zone/MapZoneLoader';
import { MapZoneRegistry } from '../zone/MapZoneRegistry';
import { TimecycLoader } from '../loaders/TimecycLoader';
import { WaterproLoader } from '../loaders/WaterproLoader';
import { ObjectDatLoader } from '../loaders/ObjectDatLoader';
import { ImgArchiveManager } from '../resources/ImgArchiveManager';
import { TxdRegistry } from '../resources/TxdRegistry';
import { DffRegistry } from '../resources/DffRegistry';
import { TextureResolver } from '../resources/TextureResolver';
import { ModelResolver } from '../resources/ModelResolver';
import { WeatherBuilder } from './builders/WeatherBuilder';
import { WaterBuilder } from './builders/WaterBuilder';
import { WorldBuilder } from './builders/WorldBuilder';
import { createWorldContext } from './WorldContext';
import { normalizePath } from '../resources/ResourceLocator';

const DEFAULT_DAT_PATH = 'data/gta.dat';
const DEFAULT_OBJECT_DAT_PATH = 'data/object.dat';
const DEFAULT_TIMECYC_PATH = 'data/timecyc.dat';
const DEFAULT_WATERPRO_PATH = 'data/waterpro.dat';

function sanitizeImgList(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(#|;|\/\/).*$/g, '').trim())
    .filter(Boolean)
    .map((line) => normalizePath(line));
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
    const imgArchives = new ImgArchiveManager();
    await this.mountArchives(expandedImgPaths, imgArchives);

    const ideRegistry = await this.loadIdeDefinitions(manifest);
    const iplRegistry = await this.loadIplDefinitions(manifest);
    const colRegistry = await this.loadColDefinitions(manifest);
    const mapZoneRegistry = await this.loadMapZones(manifest);
    const timecyc = await this.loadOptionalTimecyc(options.timecycPath || DEFAULT_TIMECYC_PATH);
    const water = await this.loadOptionalWater(options.waterPath || DEFAULT_WATERPRO_PATH);
    const objectDat = await this.loadOptionalObjectDat(options.objectDatPath || DEFAULT_OBJECT_DAT_PATH);

    const textureResolver = new TextureResolver({
      fileSystem: this.fileSystem,
      imgArchives,
      registry: new TxdRegistry(),
      imagePaths: manifest.imagePaths,
      onLog: this.onLog,
    });
    const modelResolver = new ModelResolver({
      fileSystem: this.fileSystem,
      imgArchives,
      textureResolver,
      registry: new DffRegistry(),
    });

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
        iplInst: iplRegistry.size,
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
    const normalizedPath = normalizePath(pathHint);
    if (declaredDetail) this.onFileEvent?.(kind, normalizedPath, declaredDetail);
    const record = this.fileSystem.findByPath(normalizedPath);
    if (!record) {
      this.onFileEvent?.(kind, normalizedPath, missingDetail);
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

    registerPath('models/gta3.img');
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

  async mountArchives(imgPaths, imgArchives) {
    for (const imgPath of imgPaths) {
      const imgRecord = this.resolveByPath('IMG', imgPath, {
        foundDetail: 'found',
        missingDetail: 'missing img',
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

  async loadColDefinitions(manifest) {
    const registry = new ColRegistry();

    for (const pathHint of manifest.colFiles) {
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
