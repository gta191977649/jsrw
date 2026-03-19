import { normalizeTextureDictionary, TXDLoader } from '../../jsrw';
import { hasExtension, joinPath, normalizeAssetName, normalizeName, stripExtension } from './ResourceLocator';

function createMetadataPatchedLoader() {
  const loader = new TXDLoader();
  const metadataByNameRef = { current: new Map() };

  const baseReadTextureNative = loader.readTextureNative.bind(loader);
  loader.readTextureNative = function patchedReadTextureNative(...args) {
    const parsed = baseReadTextureNative(...args);
    if (parsed?.name) {
      metadataByNameRef.current.set(String(parsed.name).toLowerCase(), {
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

  const baseParse = loader.parse.bind(loader);
  loader.parse = function patchedParse(...args) {
    metadataByNameRef.current = new Map();
    return baseParse(...args);
  };

  return {
    loader,
    metadataByNameRef,
  };
}

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export class TextureResolver {
  constructor(options = {}) {
    this.fileSystem = options.fileSystem;
    this.imgArchives = options.imgArchives;
    this.registry = options.registry;
    this.imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
    this.sourceIndex = options.sourceIndex || null;
    this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const patchedLoader = createMetadataPatchedLoader();
    this.loader = patchedLoader.loader;
    this.metadataByNameRef = patchedLoader.metadataByNameRef;
    this.sources = new Map();
    this.textureEntryCache = new Map();
  }

  getSource(name) {
    return this.sources.get(stripExtension(name)) || '';
  }

  async resolveTextureDictionary(name) {
    const normalizedName = stripExtension(name);
    if (!normalizedName) return null;
    if (this.registry.has(normalizedName)) return this.registry.get(normalizedName);

    const pending = this.loadTextureDictionary(normalizedName).catch((error) => {
      this.registry.set(normalizedName, null);
      throw error;
    });
    this.registry.set(normalizedName, pending);

    const resolved = await pending;
    this.registry.set(normalizedName, resolved);
    return resolved;
  }

  async resolveTextureEntry(name, options = {}) {
    const normalizedName = stripExtension(normalizeName(name));
    if (!normalizedName) return null;
    if (this.textureEntryCache.has(normalizedName)) {
      return this.textureEntryCache.get(normalizedName);
    }

    const pending = this.loadTextureEntry(normalizedName, options).catch((error) => {
      this.textureEntryCache.set(normalizedName, null);
      throw error;
    });
    this.textureEntryCache.set(normalizedName, pending);

    const resolved = await pending;
    this.textureEntryCache.set(normalizedName, resolved);
    return resolved;
  }

  getKnownTextureDictionaryNames() {
    const names = [];
    const seen = new Set();
    const addName = (value) => {
      const normalized = stripExtension(normalizeName(value));
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      names.push(normalized);
    };

    for (const name of this.sourceIndex?.keys?.() || []) addName(name);
    for (const name of this.registry?.records?.keys?.() || []) addName(name);
    for (const pathHint of this.imagePaths || []) {
      if (hasExtension(pathHint, 'txd')) addName(pathHint);
    }
    for (const assetName of this.imgArchives?.listAssets?.('txd') || []) addName(assetName);
    for (const record of this.fileSystem?.listByExtension?.('txd') || []) {
      addName(record.basename || record.resolvedPath || '');
    }

    return names;
  }

  async loadTextureEntry(name, options = {}) {
    const normalizedName = stripExtension(normalizeName(name));
    const preferredDictionaries = Array.isArray(options.preferredDictionaries)
      ? options.preferredDictionaries
      : [];
    const orderedDictionaryNames = [];
    const seen = new Set();
    const addDictionary = (value) => {
      const normalized = stripExtension(normalizeName(value));
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      orderedDictionaryNames.push(normalized);
    };

    preferredDictionaries.forEach(addDictionary);
    this.getKnownTextureDictionaryNames().forEach(addDictionary);

    for (const dictionaryName of orderedDictionaryNames) {
      const dictionary = await this.resolveTextureDictionary(dictionaryName);
      if (!dictionary?.get) continue;
      const entry = dictionary.get(normalizedName) || null;
      if (!entry) continue;
      return {
        ...entry,
        txdName: dictionaryName,
        sourcePath: this.getSource(dictionaryName),
      };
    }

    return null;
  }

  async loadTextureDictionary(name) {
    const normalizedName = stripExtension(name);
    const indexedSource = this.sourceIndex?.get?.(normalizedName) || null;
    if (indexedSource?.kind === 'file' && indexedSource.record) {
      const dict = normalizeTextureDictionary(this.loader.parse(await indexedSource.record.file.arrayBuffer()), {
        metadataByName: this.metadataByNameRef.current,
      });
      this.sources.set(name, indexedSource.record.resolvedPath);
      return dict;
    }

    if (indexedSource?.kind === 'img') {
      const txdFromImg = this.imgArchives.readBytes(indexedSource.name, 'txd');
      if (txdFromImg) {
        const dict = normalizeTextureDictionary(this.loader.parse(toArrayBuffer(txdFromImg)), {
          metadataByName: this.metadataByNameRef.current,
        });
        this.sources.set(name, indexedSource.sourcePath || this.imgArchives.getAssetSource(indexedSource.name, 'txd') || 'unknown IMG');
        return dict;
      }
    }

    const txdFileName = normalizeAssetName(name, 'txd');
    const directFile = this.fileSystem.findByBasename(txdFileName) || this.findFromImagePaths(txdFileName);
    if (directFile) {
      const dict = normalizeTextureDictionary(this.loader.parse(await directFile.file.arrayBuffer()), {
        metadataByName: this.metadataByNameRef.current,
      });
      this.sources.set(name, directFile.resolvedPath);
      return dict;
    }

    const txdFromImg = this.imgArchives.readBytes(name, 'txd');
    if (!txdFromImg) {
      this.sources.set(name, '');
      this.onLog?.('warn', `TXD missing: ${txdFileName} (file + IMG)`);
      return null;
    }

    const dict = normalizeTextureDictionary(this.loader.parse(toArrayBuffer(txdFromImg)), {
      metadataByName: this.metadataByNameRef.current,
    });
    this.sources.set(name, this.imgArchives.getAssetSource(name, 'txd') || 'unknown IMG');
    return dict;
  }

  findFromImagePaths(fileName) {
    const normalizedFileName = normalizeName(fileName);

    for (const imagePath of this.imagePaths) {
      const pathHint = hasExtension(imagePath, 'txd')
        ? imagePath
        : joinPath(imagePath, normalizedFileName);
      const record = this.fileSystem.findByPath(pathHint);
      if (!record) continue;
      if (hasExtension(record.resolvedPath, 'txd')) return record;
    }

    return null;
  }
}
