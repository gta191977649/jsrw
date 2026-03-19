export class WorldBuilder {
  async build(context) {
    return {
      manifest: context.manifest,
      ideRegistry: context.ideRegistry,
      iplRegistry: context.iplRegistry,
      modelResolver: context.modelResolver,
      textureResolver: context.textureResolver,
    };
  }
}
