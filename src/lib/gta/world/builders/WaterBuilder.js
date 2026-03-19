export class WaterBuilder {
  async build(context) {
    return {
      sourcePath: context.waterSourcePath,
      config: context.waterConfig,
      data: context.water,
    };
  }
}
