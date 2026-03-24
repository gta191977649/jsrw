import { stripExtension } from './ResourceLocator.js';

export class DffRegistry {
  constructor() {
    this.records = new Map();
  }

  get(name, txdName = '') {
    return this.records.get(this.makeKey(name, txdName));
  }

  set(name, txdName, value) {
    this.records.set(this.makeKey(name, txdName), value);
    return value;
  }

  has(name, txdName = '') {
    return this.records.has(this.makeKey(name, txdName));
  }

  makeKey(name, txdName = '') {
    return `${stripExtension(name)}::${stripExtension(txdName)}`;
  }
}
