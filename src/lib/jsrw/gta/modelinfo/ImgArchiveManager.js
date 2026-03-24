import { IMGParser } from '../../utils/imgArchive.js';
import { normalizeAssetName } from './ResourceLocator.js';

export class ImgArchiveManager {
  constructor() {
    this.parser = new IMGParser();
  }

  async mount(imgRecord, dirRecord, sourcePath = '') {
    return this.parser.appendArchive(imgRecord.file, dirRecord.file, sourcePath || imgRecord.resolvedPath);
  }

  has(name) {
    return Boolean(this.parser.getAssetBytes(name));
  }

  readBytes(name, extension = '') {
    return this.parser.getAssetBytes(normalizeAssetName(name, extension));
  }

  getAssetSource(name, extension = '') {
    return this.parser.getAssetSource(normalizeAssetName(name, extension));
  }

  listAssets(extension = '') {
    return this.parser.listAssetNames(extension);
  }
}
