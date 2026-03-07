import { normalizePath } from './gtaParsers';

const IMG_SECTOR_SIZE = 2048;
const DIR_ENTRY_SIZE = 32;
const TEXT_DECODER = new TextDecoder('ascii');

function readDirName(bytes) {
  let end = bytes.length;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0) {
      end = i;
      break;
    }
  }
  return normalizePath(TEXT_DECODER.decode(bytes.subarray(0, end)));
}

function parseDirEntries(dirBuffer) {
  const dataView = new DataView(dirBuffer);
  const signature = TEXT_DECODER.decode(new Uint8Array(dirBuffer, 0, Math.min(4, dirBuffer.byteLength)));

  let offset = 0;
  let numEntries = 0;

  // mapviewer logic:
  // - if starts with VER2, entry count is at +4 and records start at +8
  // - else treat as plain .dir with fixed 32-byte records
  if (signature === 'VER2' && dirBuffer.byteLength >= 8) {
    numEntries = dataView.getUint32(4, true);
    offset = 8;
  } else {
    numEntries = Math.floor(dirBuffer.byteLength / DIR_ENTRY_SIZE);
    offset = 0;
  }

  const entries = [];
  for (let i = 0; i < numEntries; i += 1) {
    const entryOffset = offset + (i * DIR_ENTRY_SIZE);
    if (entryOffset + DIR_ENTRY_SIZE > dirBuffer.byteLength) break;

    const startSector = dataView.getUint32(entryOffset, true);
    const sizeSectors = dataView.getUint32(entryOffset + 4, true);
    if (sizeSectors <= 0) continue;

    const nameBytes = new Uint8Array(dirBuffer, entryOffset + 8, 24);
    const name = readDirName(nameBytes);
    if (!name) continue;

    entries.push({
      name,
      start: startSector * IMG_SECTOR_SIZE,
      size: sizeSectors * IMG_SECTOR_SIZE,
    });
  }

  return entries;
}

export class IMGParser {
  constructor() {
    this.assets = new Map();
    this.assetSources = new Map();
  }

  async appendArchive(imgFile, dirFile, sourcePath = '') {
    if (!imgFile || !dirFile) {
      return { total: 0, added: 0, overridden: 0 };
    }

    const [imgBuffer, dirBuffer] = await Promise.all([imgFile.arrayBuffer(), dirFile.arrayBuffer()]);
    const entries = parseDirEntries(dirBuffer);
    const imgBytes = new Uint8Array(imgBuffer);

    let added = 0;
    let overridden = 0;
    const normalizedSource = normalizePath(sourcePath || (imgFile.webkitRelativePath || imgFile.name || ''));

    for (const entry of entries) {
      const start = entry.start;
      const end = Math.min(imgBytes.byteLength, start + entry.size);
      if (start >= end) continue;

      const exists = this.assets.has(entry.name);
      const slice = imgBytes.slice(start, end);
      this.assets.set(entry.name, slice);
      this.assetSources.set(entry.name, normalizedSource);

      if (exists) overridden += 1;
      else added += 1;
    }

    return { total: entries.length, added, overridden };
  }

  getAssetBytes(name) {
    return this.assets.get(normalizePath(name));
  }

  getAssetSource(name) {
    return this.assetSources.get(normalizePath(name));
  }
}

export async function buildImgAssetMap(imgFile, dirFile) {
  const parser = new IMGParser();
  await parser.appendArchive(imgFile, dirFile);
  return parser.assets;
}
