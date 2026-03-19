import { normalizeName, normalizePath } from '../resources/ResourceLocator';

function toResolvedRecord(file, requestedPath) {
  if (!file) return null;

  return {
    file,
    requestedPath: normalizePath(requestedPath || file.webkitRelativePath || file.name || ''),
    resolvedPath: normalizePath(file.webkitRelativePath || file.name || requestedPath || ''),
    basename: normalizeName(file.webkitRelativePath || file.name || requestedPath || ''),
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
}
