import { getWaterConfig, parseWaterproDat } from '../../waterpro';

export class WaterproLoader {
  constructor(options = {}) {
    this.gameVersion = String(options.gameVersion || 'VCS').toUpperCase();
  }

  async load(record) {
    return {
      sourcePath: record.resolvedPath,
      config: getWaterConfig(this.gameVersion),
      data: parseWaterproDat(await record.file.arrayBuffer()),
    };
  }
}
