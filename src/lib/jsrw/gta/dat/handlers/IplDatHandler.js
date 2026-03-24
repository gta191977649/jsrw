import { appendManifestPath } from '../GTADatManifest.js';

export class IplDatHandler {
  constructor() {
    this.keyword = 'IPL';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'iplFiles', entry.path);
  }
}
