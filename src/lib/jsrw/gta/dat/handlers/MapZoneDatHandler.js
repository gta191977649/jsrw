import { appendManifestPath } from '../GTADatManifest.js';

export class MapZoneDatHandler {
  constructor() {
    this.keyword = 'MAPZONE';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'mapZones', entry.path);
  }
}
