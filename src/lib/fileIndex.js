import { normalizePath } from './gtaParsers';

function basename(path) {
  const chunks = path.split('/');
  return chunks[chunks.length - 1];
}

export function buildFileIndex(fileList) {
  const byPath = new Map();
  const byBasename = new Map();

  for (const file of fileList) {
    const rel = normalizePath(file.webkitRelativePath || file.name);
    byPath.set(rel, file);

    const base = basename(rel);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(rel);
  }

  function findByPathHint(inputPath) {
    const normalized = normalizePath(inputPath);
    if (byPath.has(normalized)) return byPath.get(normalized);

    const withDataPrefix = normalized.startsWith('data/') ? normalized : `data/${normalized}`;
    if (byPath.has(withDataPrefix)) return byPath.get(withDataPrefix);

    for (const [path, file] of byPath.entries()) {
      if (path.endsWith(`/${normalized}`) || path.endsWith(`/${withDataPrefix}`)) {
        return file;
      }
    }

    return null;
  }

  function findByBasename(name) {
    const normalized = normalizePath(name);
    const candidates = byBasename.get(normalized);
    if (!candidates || candidates.length === 0) return null;
    return byPath.get(candidates[0]);
  }

  return {
    count: byPath.size,
    byPath,
    byBasename,
    findByPathHint,
    findByBasename,
  };
}
