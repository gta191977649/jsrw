import { appendManifestPath } from '../GTADatManifest';

export class ImagePathDatHandler {
  constructor() {
    this.keyword = 'IMAGEPATH';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'imagePaths', entry.path);
  }
}
