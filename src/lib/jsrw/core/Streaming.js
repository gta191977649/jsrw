import { BrowserFileSystem } from '../platform/BrowserFileSystem.js';
import { WorldLoader } from '../gta/streaming/WorldLoader.js';

export class Streaming {
  constructor(options = {}) {
    this.gameVersion = String(options.gameVersion || 'VCS').toUpperCase();
    this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
    this.onFileEvent = typeof options.onFileEvent === 'function' ? options.onFileEvent : null;
  }

  async loadWorld(fileIndex, options = {}) {
    const worldLoader = new WorldLoader({
      fileSystem: new BrowserFileSystem(fileIndex),
      gameVersion: options.gameVersion || this.gameVersion,
      onLog: options.onLog || this.onLog,
      onFileEvent: options.onFileEvent || this.onFileEvent,
    });
    return worldLoader.load(options);
  }
}

export default Streaming;
