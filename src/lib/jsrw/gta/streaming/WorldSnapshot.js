export function toPlainData(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const cloned = [];
    seen.set(value, cloned);
    for (const item of value) cloned.push(toPlainData(item, seen));
    return cloned;
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (value instanceof DataView) {
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (ArrayBuffer.isView(value)) return Array.from(value);

  if (value instanceof Map) {
    const cloned = [];
    seen.set(value, cloned);
    for (const [key, entryValue] of value.entries()) {
      cloned.push([toPlainData(key, seen), toPlainData(entryValue, seen)]);
    }
    return cloned;
  }

  if (value instanceof Set) {
    const cloned = [];
    seen.set(value, cloned);
    for (const entryValue of value.values()) cloned.push(toPlainData(entryValue, seen));
    return cloned;
  }

  const cloned = {};
  seen.set(value, cloned);
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === 'function') continue;
    cloned[key] = toPlainData(entryValue, seen);
  }
  return cloned;
}

function snapshotRegistryFiles(files) {
  return toPlainData(Array.isArray(files) ? files : []);
}

export function snapshotIdeRegistry(registry) {
  if (!registry) return null;
  return {
    files: snapshotRegistryFiles(registry.files),
    definitions: toPlainData(Array.from(registry.byId?.values?.() || [])),
    definitionsByModel: toPlainData(Array.from(registry.byModel?.values?.() || [])),
    effectsById: Array.from(registry.effectsById?.entries?.() || []).map(([id, effects]) => [
      id,
      toPlainData(effects),
    ]),
    size: registry.size || 0,
    effectsCount: registry.effectsCount || 0,
  };
}

export function snapshotIplRegistry(registry) {
  if (!registry) return null;
  return {
    files: snapshotRegistryFiles(registry.files),
    placements: toPlainData(registry.placements || []),
    size: registry.size || 0,
  };
}

export function snapshotSimpleRegistry(registry, fieldName = 'records') {
  if (!registry) return null;
  return {
    [fieldName]: toPlainData(registry[fieldName] || []),
  };
}

export function snapshotWorldBuild(build = {}) {
  const lodMapping = build?.lodMapping instanceof Map
    ? Array.from(build.lodMapping.entries())
    : toPlainData(build?.lodMapping || []);
  const usedLodIndices = build?.usedLodIndices instanceof Set
    ? Array.from(build.usedLodIndices.values())
    : toPlainData(build?.usedLodIndices || []);

  return {
    manifest: toPlainData(build.manifest || null),
    placements: toPlainData(build.placements || []),
    placementCount: Number.isFinite(build.placementCount)
      ? build.placementCount
      : (Array.isArray(build.placements) ? build.placements.length : 0),
    chunkGraph: toPlainData(build.chunkGraph || []),
    lodMapping,
    usedLodIndices,
    standaloneLodIndices: toPlainData(build.standaloneLodIndices || []),
    emitters: toPlainData(build.emitters || []),
    weather: toPlainData(build.weather || null),
    water: toPlainData(build.water || null),
    dependencies: {
      models: toPlainData(build.dependencies?.models || []),
      textures: toPlainData(build.dependencies?.textures || []),
    },
  };
}

export function snapshotWorldContext(context = {}) {
  return {
    gameVersion: String(context.gameVersion || 'VCS').toUpperCase(),
    manifest: toPlainData(context.manifest || null),
    defaultResources: toPlainData(context.defaultResources || null),
    timecyc: toPlainData(context.timecyc || null),
    timecycSourcePath: String(context.timecycSourcePath || ''),
    water: toPlainData(context.water || null),
    waterConfig: toPlainData(context.waterConfig || null),
    waterSourcePath: String(context.waterSourcePath || ''),
    objectDat: toPlainData(context.objectDat ?? null),
    objectDatSourcePath: String(context.objectDatSourcePath || ''),
    registries: {
      ide: snapshotIdeRegistry(context.ideRegistry),
      ipl: snapshotIplRegistry(context.iplRegistry),
      col: snapshotSimpleRegistry(context.colRegistry),
      mapZones: snapshotSimpleRegistry(context.mapZoneRegistry),
    },
  };
}

export function buildWorldLoaderSnapshot(loadResult = {}) {
  return {
    context: snapshotWorldContext(loadResult.context || {}),
    build: {
      weather: toPlainData(loadResult.build?.weather || null),
      water: toPlainData(loadResult.build?.water || null),
      world: snapshotWorldBuild(loadResult.build?.world || {}),
    },
    stats: toPlainData(loadResult.stats || {}),
  };
}
