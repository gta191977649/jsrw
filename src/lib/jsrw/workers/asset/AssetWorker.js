import { buildFileIndex, normalizeFileEntries } from '../../utils/fileIndex.js';
import { expandZipArchive } from '../../utils/mapArchive.js';
import { BrowserFileSystem } from '../../platform/BrowserFileSystem.js';
import { WorldLoader } from '../../gta/streaming/WorldLoader.js';
import { toPlainData } from '../../gta/streaming/WorldSnapshot.js';
import {
  WORKER_CHANNEL,
  createWorkerResponseMessage,
  serializeWorkerError,
} from '../protocol.js';

const CHANNEL = WORKER_CHANNEL.ASSET;

async function handleRequest(type, payload = null) {
  switch (type) {
    case 'normalizeEntries':
      return {
        entries: normalizeFileEntries(payload?.entries || []),
      };
    case 'expandZipArchive':
      return {
        entries: normalizeFileEntries(await expandZipArchive(payload?.archiveFile || null)),
      };
    case 'snapshotPlainData':
      return {
        value: toPlainData(payload?.value ?? null),
      };
    case 'buildWorldSnapshot': {
      const entries = normalizeFileEntries(payload?.entries || []);
      const fileIndex = buildFileIndex(entries);
      const worldLoader = new WorldLoader({
        fileSystem: new BrowserFileSystem(fileIndex),
        gameVersion: payload?.gameVersion || 'VCS',
      });
      return {
        snapshot: await worldLoader.buildSnapshot(payload?.options || {}),
      };
    }
    default:
      throw new Error(`Unsupported asset worker request: ${type}`);
  }
}

self.addEventListener('message', async (event) => {
  const message = event?.data || null;
  if (!message || message.channel !== CHANNEL || message.kind !== 'request') return;
  try {
    const payload = await handleRequest(message.type, message.payload);
    self.postMessage(createWorkerResponseMessage(CHANNEL, message.type, message.id, payload));
  } catch (error) {
    self.postMessage(createWorkerResponseMessage(
      CHANNEL,
      message.type,
      message.id,
      null,
      serializeWorkerError(error),
    ));
  }
});
