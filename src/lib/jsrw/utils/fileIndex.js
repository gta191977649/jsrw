import { normalizePath } from '../gta/loaders/SectionLoader.js';

function basename(path) {
  const chunks = path.split('/');
  return chunks[chunks.length - 1];
}

export function buildFileIndex(fileList) {
  const byPath = new Map();
  const byBasename = new Map();
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
    entries.push(entry);

    const base = basename(rel);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(entry);
  }

  function findByPathHint(inputPath) {
    const normalized = normalizePath(inputPath);
    if (byPath.has(normalized)) return byPath.get(normalized);

    const withDataPrefix = normalized.startsWith('data/') ? normalized : `data/${normalized}`;
    if (byPath.has(withDataPrefix)) return byPath.get(withDataPrefix);

    for (const entry of entries) {
      const path = entry.normalizedPath;
      if (path.endsWith(`/${normalized}`) || path.endsWith(`/${withDataPrefix}`)) {
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
    byBasename,
    findByPathHint,
    findByBasename,
    listByPathPrefix,
    listByExtension,
  };
}
