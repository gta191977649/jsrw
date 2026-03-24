import { stripExtension } from './ResourceLocator.js';

export class TxdRegistry {
  constructor() {
    this.records = new Map();
  }

  get(name) {
    return this.records.get(stripExtension(name));
  }

  set(name, value) {
    this.records.set(stripExtension(name), value);
    return value;
  }

  has(name) {
    return this.records.has(stripExtension(name));
  }
}
