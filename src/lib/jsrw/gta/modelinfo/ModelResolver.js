import { DFFLoader } from '../../DFFLoader.js';
import { normalizeAssetName, stripExtension } from './ResourceLocator.js';

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export class ModelResolver {
  constructor(options = {}) {
    this.fileSystem = options.fileSystem;
    this.imgArchives = options.imgArchives;
    this.textureResolver = options.textureResolver;
    this.registry = options.registry;
  }

  async resolve(modelName, txdName = '') {
    const normalizedModelName = stripExtension(modelName);
    const normalizedTxdName = stripExtension(txdName);
    if (!normalizedModelName) return null;
    if (this.registry.has(normalizedModelName, normalizedTxdName)) {
      return this.registry.get(normalizedModelName, normalizedTxdName);
    }

    const pending = this.loadModel(normalizedModelName, normalizedTxdName).catch((error) => {
      this.registry.set(normalizedModelName, normalizedTxdName, null);
      throw error;
    });
    this.registry.set(normalizedModelName, normalizedTxdName, pending);

    const resolved = await pending;
    this.registry.set(normalizedModelName, normalizedTxdName, resolved);
    return resolved;
  }

  async loadModel(modelName, txdName) {
    const loader = new DFFLoader();
    const textureDictionary = await this.textureResolver.resolveTextureDictionary(txdName);
    if (textureDictionary) loader.setTextureDictionary(textureDictionary);

    const dffFileName = normalizeAssetName(modelName, 'dff');
    const directFile = this.fileSystem.findByBasename(dffFileName);
    let dffBuffer = null;
    let dffSource = '';

    if (directFile) {
      dffBuffer = await directFile.file.arrayBuffer();
      dffSource = directFile.resolvedPath;
    } else {
      const dffFromImg = this.imgArchives.readBytes(modelName, 'dff');
      if (!dffFromImg) {
        throw new Error(`Missing DFF: ${dffFileName}`);
      }
      dffBuffer = toArrayBuffer(dffFromImg);
      dffSource = this.imgArchives.getAssetSource(modelName, 'dff') || 'unknown IMG';
    }

    return {
      modelName,
      txdName,
      dffSource,
      txdSource: this.textureResolver.getSource(txdName),
      textureDictionary,
      template: loader.parse(dffBuffer),
    };
  }
}
