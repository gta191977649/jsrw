import { CDImageDatHandler } from './handlers/CDImageDatHandler';
import { ColFileDatHandler } from './handlers/ColFileDatHandler';
import { IdeDatHandler } from './handlers/IdeDatHandler';
import { ImagePathDatHandler } from './handlers/ImagePathDatHandler';
import { ImgDatHandler } from './handlers/ImgDatHandler';
import { ImgListDatHandler } from './handlers/ImgListDatHandler';
import { IplDatHandler } from './handlers/IplDatHandler';
import { MapZoneDatHandler } from './handlers/MapZoneDatHandler';

export class GTADatHandlerRegistry {
  constructor(handlers = []) {
    this.handlers = new Map();
    handlers.forEach((handler) => this.register(handler));
  }

  register(handler) {
    if (!handler?.keyword || typeof handler.handle !== 'function') {
      throw new Error('Invalid gta.dat handler registration');
    }
    this.handlers.set(String(handler.keyword).toUpperCase(), handler);
    return this;
  }

  handle(entry, manifest) {
    const handler = this.handlers.get(entry.keyword);
    if (!handler) return false;
    handler.handle(entry, manifest);
    return true;
  }
}

export function createDefaultGTADatHandlerRegistry() {
  return new GTADatHandlerRegistry([
    new CDImageDatHandler(),
    new ImgDatHandler(),
    new ImgListDatHandler(),
    new ImagePathDatHandler(),
    new IdeDatHandler(),
    new IplDatHandler(),
    new ColFileDatHandler(),
    new MapZoneDatHandler(),
  ]);
}
