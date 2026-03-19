import { normalizePath as normalizeRawPath } from '../loaders/SectionLoader';

export function normalizePath(input = '') {
  return normalizeRawPath(String(input || ''));
}

export function normalizeName(input = '') {
  return normalizePath(input).split('/').pop() || '';
}

export function normalizeAssetName(input = '', extension = '') {
  const baseName = stripExtension(normalizeName(input));
  const ext = String(extension || '').trim().replace(/^\./, '').toLowerCase();
  return ext ? `${baseName}.${ext}` : baseName;
}

export function stripExtension(input = '') {
  const value = normalizeName(input);
  const index = value.lastIndexOf('.');
  return index >= 0 ? value.slice(0, index) : value;
}

export function hasExtension(input = '', extension = '') {
  const normalizedExtension = String(extension || '').trim().replace(/^\./, '').toLowerCase();
  if (!normalizedExtension) return false;
  return normalizeName(input).endsWith(`.${normalizedExtension}`);
}

export function joinPath(...parts) {
  return normalizePath(
    parts
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join('/'),
  );
}
