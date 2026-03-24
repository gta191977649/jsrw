import { unzipSync } from 'fflate';

function inferMimeType(path) {
  const normalizedPath = String(path || '').toLowerCase();
  if (normalizedPath.endsWith('.txt')) return 'text/plain';
  if (normalizedPath.endsWith('.dat')) return 'text/plain';
  if (normalizedPath.endsWith('.ide')) return 'text/plain';
  if (normalizedPath.endsWith('.ipl')) return 'text/plain';
  if (normalizedPath.endsWith('.zon')) return 'text/plain';
  if (normalizedPath.endsWith('.img')) return 'application/octet-stream';
  if (normalizedPath.endsWith('.dir')) return 'application/octet-stream';
  if (normalizedPath.endsWith('.col')) return 'application/octet-stream';
  if (normalizedPath.endsWith('.dff')) return 'application/octet-stream';
  if (normalizedPath.endsWith('.txd')) return 'application/octet-stream';
  return '';
}

function sanitizeArchivePath(path) {
  return String(path || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/+/g, '')
    .replace(/^\.\//, '');
}

export async function expandZipArchive(sourceFile) {
  if (!sourceFile || typeof sourceFile.arrayBuffer !== 'function') {
    throw new Error('Zip import requires a readable File object');
  }

  const archive = unzipSync(new Uint8Array(await sourceFile.arrayBuffer()));
  const entries = [];
  const lastModified = Number(sourceFile.lastModified) || Date.now();

  for (const [rawPath, bytes] of Object.entries(archive)) {
    const path = sanitizeArchivePath(rawPath);
    if (!path || path.endsWith('/')) continue;
    const segments = path.split('/');
    const basename = segments[segments.length - 1] || path;
    entries.push({
      path,
      file: new File([bytes], basename, {
        lastModified,
        type: inferMimeType(path),
      }),
    });
  }

  if (entries.length === 0) {
    throw new Error(`Zip archive is empty: ${sourceFile.name || 'archive.zip'}`);
  }

  return entries;
}
