import { appendManifestPath } from '../GTADatManifest';

export class IplDatHandler {
  constructor() {
    this.keyword = 'IPL';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'iplFiles', entry.path);
  }
}
