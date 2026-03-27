import { normalizePath } from '../gta/loaders/SectionLoader.js';

function basename(path) {
  const chunks = path.split('/');
  return chunks[chunks.length - 1];
}

export function buildFileIndex(fileList) {
  const byPath = new Map();
  const byPathLower = new Map();
  const byBasename = new Map();
  const byBasenameLower = new Map();
  const entries = [];

  for (const inputEntry of fileList) {
    const file = inputEntry?.file || inputEntry;
    if (!file) continue;
    const rawPath = String(inputEntry?.path || file.webkitRelativePath || file.name || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
    const rel = normalizePath(rawPath);
    const entry = {
      file,
      path: rawPath,
      normalizedPath: rel,
    };
    byPath.set(rel, entry);
    byPathLower.set(rel.toLowerCase(), entry);
    entries.push(entry);

    const base = basename(rel);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(entry);
    const baseLower = base.toLowerCase();
    if (!byBasenameLower.has(baseLower)) byBasenameLower.set(baseLower, []);
    byBasenameLower.get(baseLower).push(entry);
  }

  function findByPathHint(inputPath) {
    const normalized = normalizePath(inputPath);
    const normalizedLower = normalized.toLowerCase();
    if (byPath.has(normalized)) return byPath.get(normalized);
    if (byPathLower.has(normalizedLower)) return byPathLower.get(normalizedLower);

    const withDataPrefix = normalized.startsWith('data/') ? normalized : `data/${normalized}`;
    const withDataPrefixLower = withDataPrefix.toLowerCase();
    if (byPath.has(withDataPrefix)) return byPath.get(withDataPrefix);
    if (byPathLower.has(withDataPrefixLower)) return byPathLower.get(withDataPrefixLower);

    for (const entry of entries) {
      const path = entry.normalizedPath.toLowerCase();
      if (path.endsWith(`/${normalizedLower}`) || path.endsWith(`/${withDataPrefixLower}`)) {
        return entry;
      }
    }

    return null;
  }

  function findByBasename(name) {
    const normalized = normalizePath(name);
    const candidates = byBasename.get(normalized);
    if (!candidates || candidates.length === 0) return null;
    return candidates[0];
  }
  function findByBasenameInsensitive(name) {
    const normalized = normalizePath(name).toLowerCase();
    const candidates = byBasenameLower.get(normalized);
    if (!candidates || candidates.length === 0) return null;
    return candidates[0];
  }

  function listByPathPrefix(pathPrefix) {
    const normalizedPrefix = normalizePath(pathPrefix).replace(/\/+$/g, '');
    if (!normalizedPrefix) return [];
    const prefixWithSlash = `${normalizedPrefix}/`;
    const matches = [];
    for (const entry of entries) {
      const path = entry.normalizedPath;
      if (path === normalizedPrefix || path.startsWith(prefixWithSlash)) {
        matches.push(entry);
      }
    }
    matches.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath));
    return matches;
  }

  function listByExtension(extension) {
    const normalizedExtension = String(extension || '').trim().replace(/^\./, '').toLowerCase();
    if (!normalizedExtension) return [];
    const suffix = `.${normalizedExtension}`;
    const matches = [];
    for (const entry of entries) {
      if (entry.normalizedPath.endsWith(suffix)) matches.push(entry);
    }
    matches.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath));
    return matches;
  }

  return {
    count: byPath.size,
    byPath,
    byPathLower,
    byBasename,
    byBasenameLower,
    findByPathHint,
    findByBasename: (name) => findByBasename(name) || findByBasenameInsensitive(name),
    listByPathPrefix,
    listByExtension,
  };
}
