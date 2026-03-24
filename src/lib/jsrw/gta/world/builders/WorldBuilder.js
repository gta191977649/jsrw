import { buildLodMapping, isLodModel } from '../../../utils/lod.js';
import { buildRenderItemGraph } from '../entities/RenderItem.js';
import { buildWorldChunkGraph } from '../entities/WorldChunk.js';
import { createWeatherTimecycleState } from '../../../core/TimecycleState.js';

export class WorldBuilder {
  async build(context) {
    const placements = context.iplRegistry?.getAll?.() || [];
    const { mapping: lodMapping, usedLodIndices } = buildLodMapping(placements, context.gameVersion);
    const standaloneLodIndices = [];

    for (let index = 0; index < placements.length; index += 1) {
      if (!isLodModel(placements[index]?.modelName)) continue;
      if (usedLodIndices.has(index)) continue;
      standaloneLodIndices.push(index);
    }

    return {
      manifest: context.manifest,
      ideRegistry: context.ideRegistry,
      iplRegistry: context.iplRegistry,
      modelResolver: context.modelResolver,
      textureResolver: context.textureResolver,
      placements,
      placementCount: placements.length,
      chunkGraph: buildWorldChunkGraph(placements),
      lodMapping,
      usedLodIndices,
      standaloneLodIndices,
      emitters: [],
      weather: createWeatherTimecycleState({
        sourcePath: context.timecycSourcePath || '',
        data: context.timecyc || null,
      }),
      water: {
        sourcePath: context.waterSourcePath || '',
        config: context.waterConfig || null,
        data: context.water || null,
      },
      dependencies: {
        models: buildRenderItemGraph(placements, context.ideRegistry),
        textures: [],
      },
    };
  }
}
