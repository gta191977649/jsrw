import { parseTimecyc } from '../../utils/Timecycle.js';

export class TimecycLoader {
  constructor(options = {}) {
    this.gameVersion = String(options.gameVersion || 'VCS').toUpperCase();
  }

  async load(record) {
    return {
      sourcePath: record.resolvedPath,
      data: parseTimecyc(await record.file.text(), {
        gameVersion: this.gameVersion,
      }),
    };
  }
}
