import { WorkerClient } from '../WorkerClient.js';
import { WORKER_CHANNEL } from '../protocol.js';

function createAssetWorker() {
  if (typeof Worker !== 'function') return null;
  return new Worker(new URL('./AssetWorker.js', import.meta.url), { type: 'module' });
}

let sharedAssetWorkerClient = null;

export class AssetWorkerClient extends WorkerClient {
  constructor(options = {}) {
    super({
      channel: WORKER_CHANNEL.ASSET,
      workerFactory: options.workerFactory || createAssetWorker,
    });
  }

  async normalizeEntries(entries = []) {
    const result = await this.request('normalizeEntries', { entries });
    return result?.entries || [];
  }

  async expandZipArchive(archiveFile) {
    const result = await this.request('expandZipArchive', { archiveFile });
    return result?.entries || [];
  }

  async snapshotPlainData(value) {
    const result = await this.request('snapshotPlainData', { value });
    return result?.value ?? null;
  }

  async buildWorldSnapshot({ entries = [], gameVersion = 'VCS', options = {} } = {}) {
    const result = await this.request('buildWorldSnapshot', {
      entries,
      gameVersion,
      options,
    });
    return result?.snapshot || null;
  }
}

export function getSharedAssetWorkerClient() {
  if (!sharedAssetWorkerClient) {
    sharedAssetWorkerClient = new AssetWorkerClient();
  }
  return sharedAssetWorkerClient;
}

export default AssetWorkerClient;
