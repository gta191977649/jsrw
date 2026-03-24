import { appendManifestPath } from '../GTADatManifest.js';

export class ImgDatHandler {
  constructor() {
    this.keyword = 'IMG';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'imgs', entry.path);
  }
}
