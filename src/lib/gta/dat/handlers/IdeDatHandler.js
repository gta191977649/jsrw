import { appendManifestPath } from '../GTADatManifest';

export class IdeDatHandler {
  constructor() {
    this.keyword = 'IDE';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'ideFiles', entry.path);
  }
}
