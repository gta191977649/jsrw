import { appendManifestPath } from '../GTADatManifest';

export class CDImageDatHandler {
  constructor() {
    this.keyword = 'CDIMAGE';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'cdImages', entry.path);
  }
}
