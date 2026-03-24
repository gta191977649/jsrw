import { appendManifestPath } from '../GTADatManifest.js';

export class CDImageDatHandler {
  constructor(keyword = 'CDIMAGE') {
    this.keyword = String(keyword || 'CDIMAGE').toUpperCase();
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'cdImages', entry.path);
  }
}
