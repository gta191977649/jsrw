import { appendManifestPath } from '../GTADatManifest.js';

export class ImagePathDatHandler {
  constructor() {
    this.keyword = 'IMAGEPATH';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'imagePaths', entry.path);
  }
}
