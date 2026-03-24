import { appendManifestPath } from '../GTADatManifest.js';

export class ColFileDatHandler {
  constructor() {
    this.keyword = 'COLFILE';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'colFiles', entry.path);
  }
}
