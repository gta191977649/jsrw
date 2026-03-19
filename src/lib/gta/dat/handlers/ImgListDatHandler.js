import { appendManifestPath } from '../GTADatManifest';

export class ImgListDatHandler {
  constructor() {
    this.keyword = 'IMGLIST';
  }

  handle(entry, manifest) {
    appendManifestPath(manifest, 'imgLists', entry.path);
  }
}
