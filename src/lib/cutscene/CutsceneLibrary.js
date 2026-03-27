import { buildFileIndex } from '../jsrw/utils/fileIndex.js';
import { expandZipArchive } from '../jsrw/utils/mapArchive.js';

function stripExtension(path = '') {
  return String(path).replace(/\.[^.]+$/u, '');
}

function createEmptyState() {
  return {
    fileIndex: null,
    sourceLabel: '',
    entries: [],
    recordsByName: new Map(),
    audioRecords: [],
  };
}

export class CutsceneLibrary {
  constructor() {
    this.reset();
  }

  reset() {
    this.state = createEmptyState();
  }

  get count() {
    return this.state.recordsByName.size;
  }

  getSourceLabel() {
    return this.state.sourceLabel;
  }

  listCutsceneNames() {
    return Array.from(this.state.recordsByName.values())
      .map((record) => record.name)
      .sort((left, right) => left.localeCompare(right));
  }

  getCutsceneRecord(name) {
    const key = String(name || '').trim().toLowerCase();
    return this.state.recordsByName.get(key) || null;
  }

  async loadEntries(entries, options = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const fileIndex = buildFileIndex(list);
    const recordsByName = new Map();
    const camRecords = fileIndex.listByExtension('cam');
    const audioRecords = fileIndex.listByExtension('mp3');

    for (const camRecord of camRecords) {
      const rawName = stripExtension(camRecord.basename || camRecord.normalizedPath || '');
      const key = rawName.toLowerCase();
      if (!key) continue;
      const cutRecord = fileIndex.findByPathHint(`${rawName}.cut`) || fileIndex.findByBasename(`${rawName}.cut`);
      const ifpRecord = fileIndex.findByPathHint(`${rawName}.ifp`) || fileIndex.findByBasename(`${rawName}.ifp`);
      const mp3Record = fileIndex.findByPathHint(`${rawName}.mp3`)
        || fileIndex.findByBasename(`${rawName}.mp3`)
        || (audioRecords.length === 1 ? audioRecords[0] : null);
      recordsByName.set(key, {
        name: rawName,
        key,
        camRecord,
        cutRecord,
        ifpRecord,
        mp3Record,
      });
    }

    this.state = {
      fileIndex,
      sourceLabel: String(options.sourceLabel || ''),
      entries: list,
      recordsByName,
      audioRecords,
    };

    return {
      count: recordsByName.size,
      names: this.listCutsceneNames(),
      sourceLabel: this.state.sourceLabel,
    };
  }

  async loadZipFile(file) {
    const entries = await expandZipArchive(file);
    return this.loadEntries(entries, {
      sourceLabel: file?.name || 'cutscene.zip',
    });
  }

  async loadFolderFiles(files, options = {}) {
    return this.loadEntries(Array.from(files || []), options);
  }

  async readCutsceneFiles(name) {
    const record = this.getCutsceneRecord(name);
    if (!record?.camRecord?.file) {
      throw new Error(`Cutscene not found: ${name}`);
    }
    const [camBuffer, cutText, ifpBuffer] = await Promise.all([
      record.camRecord.file.arrayBuffer(),
      record.cutRecord?.file?.text?.() ?? Promise.resolve(''),
      record.ifpRecord?.file?.arrayBuffer?.() ?? Promise.resolve(null),
    ]);
    return {
      ...record,
      fileIndex: this.state.fileIndex,
      camBuffer,
      cutText,
      ifpBuffer,
      mp3File: record.mp3Record?.file || null,
    };
  }
}
