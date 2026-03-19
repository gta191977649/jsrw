import * as THREE from 'three';
import { TxdParser } from './formats/txd/TxdParser.js';
import { ThreeTextureFactory } from './adapters/three/ThreeTextureFactory.js';

class TXDLoader extends THREE.Loader {
  constructor(manager) {
    super(manager);
    this.textures = new Map();
    this.parser = new TxdParser();
    this.factory = new ThreeTextureFactory();
  }

  load(url, onLoad, onProgress, onError) {
    const loader = new THREE.FileLoader(this.manager);
    loader.setResponseType('arraybuffer');
    loader.setPath(this.path);
    loader.setRequestHeader(this.requestHeader);
    loader.setWithCredentials(this.withCredentials);

    loader.load(url, (buffer) => {
      try {
        onLoad(this.parse(buffer));
      } catch (error) {
        if (onError) onError(error);
        else console.error(error);
        this.manager.itemError(url);
      }
    }, onProgress, onError);
  }

  parse(input) {
    const parsed = this.parser.parse(input);
    this.textures = this.factory.createDictionary(parsed);
    return this.textures;
  }

  readTextureNative() {
    return this.parser.readTextureNative();
  }

  getTexture(name) {
    return this.textures.get(name.toLowerCase());
  }
}

export { TXDLoader };
export default TXDLoader;
