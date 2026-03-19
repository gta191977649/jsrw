import { appendManifestPath } from '../GTADatManifest';

export class ColFileDatHandler {
  constructor() {
    this.keyword = 'COLFILE';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'colFiles', entry.path);
  }
}
