import { appendManifestPath } from '../GTADatManifest';

export class MapZoneDatHandler {
  constructor() {
    this.keyword = 'MAPZONE';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'mapZones', entry.path);
  }
}
