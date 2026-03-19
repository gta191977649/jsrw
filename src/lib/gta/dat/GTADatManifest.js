function pushUnique(list, value) {
  if (!value || list.includes(value)) return;
  list.push(value);
}

export function createGTADatManifest(sourcePath = '') {
  return {
    sourcePath,
    entries: [],
    unknownEntries: [],
    cdImages: [],
    imgs: [],
    imgLists: [],
    imagePaths: [],
    ideFiles: [],
    iplFiles: [],
    colFiles: [],
    mapZones: [],
  };
}

export function appendManifestEntry(manifest, entry) {
  manifest.entries.push(entry);
}

export function appendManifestPath(manifest, key, value) {
  if (!Array.isArray(manifest[key])) {
    throw new Error(`GTADatManifest field "${key}" is not an array`);
  }
  pushUnique(manifest[key], value);
}
