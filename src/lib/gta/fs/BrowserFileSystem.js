import { normalizeName, normalizePath } from '../resources/ResourceLocator';

function toResolvedRecord(entry, requestedPath) {
  if (!entry?.file) return null;
  const file = entry.file;
  const rawResolvedPath = String(entry.path || file.webkitRelativePath || file.name || requestedPath || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');

  return {
    file,
    requestedPath: normalizePath(requestedPath || file.webkitRelativePath || file.name || ''),
    resolvedPath: rawResolvedPath,
    normalizedResolvedPath: normalizePath(rawResolvedPath),
    basename: normalizeName(rawResolvedPath),
  };
}

export class BrowserFileSystem {
  constructor(fileIndex) {
    this.fileIndex = fileIndex;
  }

  get count() {
    return this.fileIndex?.count || 0;
  }

  findByPath(pathHint) {
    if (!this.fileIndex) return null;
    return toResolvedRecord(this.fileIndex.findByPathHint(pathHint), pathHint);
  }

  findByBasename(name) {
    if (!this.fileIndex) return null;
    return toResolvedRecord(this.fileIndex.findByBasename(name), name);
  }

  listByPathPrefix(pathPrefix) {
    if (!this.fileIndex?.listByPathPrefix) return [];
    return this.fileIndex
      .listByPathPrefix(pathPrefix)
      .map((entry) => toResolvedRecord(entry, entry.path))
      .filter(Boolean);
  }

  listByExtension(extension) {
    if (!this.fileIndex?.listByExtension) return [];
    return this.fileIndex
      .listByExtension(extension)
      .map((entry) => toResolvedRecord(entry, entry.path))
      .filter(Boolean);
  }
}
