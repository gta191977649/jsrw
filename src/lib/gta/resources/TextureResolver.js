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
    this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const patchedLoader = createMetadataPatchedLoader();
    this.loader = patchedLoader.loader;
    this.metadataByNameRef = patchedLoader.metadataByNameRef;
    this.sources = new Map();
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

  async loadTextureDictionary(name) {
    const txdFileName = normalizeAssetName(name, 'txd');
    const directFile = this.fileSystem.findByBasename(txdFileName);
    const imagePathFile = directFile || this.findFromImagePaths(txdFileName);

    if (imagePathFile) {
      const dict = normalizeTextureDictionary(this.loader.parse(await imagePathFile.file.arrayBuffer()), {
        metadataByName: this.metadataByNameRef.current,
      });
      this.sources.set(name, imagePathFile.resolvedPath);
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
