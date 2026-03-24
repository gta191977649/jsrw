import { appendManifestPath } from '../GTADatManifest.js';

export class CDImageDatHandler {
  constructor() {
    this.keyword = 'CDIMAGE';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'cdImages', entry.path);
  }
}
