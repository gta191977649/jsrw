import { appendManifestEntry, createGTADatManifest } from './GTADatManifest.js';
import { createDefaultGTADatHandlerRegistry } from './GTADatHandlerRegistry.js';
import { normalizePath } from '../modelinfo/ResourceLocator.js';

const COMMENT_RE = /(#|;|\/\/).*$/g;

function cleanLine(line) {
  return String(line || '').replace(COMMENT_RE, '').trim();
}

/** `CDIMAGE=models/map.img` style lines split to one token; expand so they are not dropped. */
function expandKeyValueDatLine(line) {
  const s = String(line || '').trim();
  const m = s.match(/^(\S+?)\s*=\s*(.+)$/);
  if (!m) return s;
  return `${m[1]} ${m[2].trim()}`;
}

export class GTADatLoader {
  constructor(options = {}) {
    this.handlers = options.handlers || createDefaultGTADatHandlerRegistry();
  }

  parse(content, options = {}) {
    const manifest = createGTADatManifest(options.sourcePath || '');
    const lines = String(content || '').split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
      const line = expandKeyValueDatLine(cleanLine(rawLine));
      if (!line) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;

      const entry = {
        keyword: parts[0].toUpperCase(),
        path: normalizePath(parts.slice(1).join(' ')),
        rawLine,
        lineNumber: index + 1,
      };

      appendManifestEntry(manifest, entry);
      const handled = this.handlers.handle(entry, manifest);
      if (!handled) manifest.unknownEntries.push(entry);
    }

    return manifest;
  }
}
