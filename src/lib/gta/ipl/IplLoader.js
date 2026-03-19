import { parseIpl } from '../loaders/SectionLoader';

export class IplLoader {
  constructor(options = {}) {
    this.gameVersion = String(options.gameVersion || 'VCS').toUpperCase();
  }

  async load(record) {
    return {
      sourcePath: record.resolvedPath,
      placements: parseIpl(await record.file.text(), {
        gameVersion: this.gameVersion,
      }),
    };
  }
}
