export function createWorldContext(input = {}) {
  return {
    gameVersion: input.gameVersion || 'VCS',
    fileSystem: input.fileSystem || null,
    manifest: input.manifest || null,
    imgArchives: input.imgArchives || null,
    textureResolver: input.textureResolver || null,
    modelResolver: input.modelResolver || null,
    ideRegistry: input.ideRegistry || null,
    iplRegistry: input.iplRegistry || null,
    colRegistry: input.colRegistry || null,
    mapZoneRegistry: input.mapZoneRegistry || null,
    timecyc: input.timecyc || null,
    timecycSourcePath: input.timecycSourcePath || '',
    water: input.water || null,
    waterConfig: input.waterConfig || null,
    waterSourcePath: input.waterSourcePath || '',
    objectDat: input.objectDat || null,
    objectDatSourcePath: input.objectDatSourcePath || '',
  };
}
