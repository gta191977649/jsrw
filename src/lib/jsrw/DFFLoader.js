import * as THREE from 'three';
import { DffParser } from './formats/dff/DffParser.js';
import { ThreeDffFactory } from './adapters/three/ThreeDffFactory.js';

class DFFLoader extends THREE.Loader {
  constructor(manager) {
    super(manager);
    this.textureDictionary = null;
    this.parser = new DffParser();
  }

  setTextureDictionary(textures) {
    this.textureDictionary = textures;
    return this;
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
    const clump = this.parser.parse(input);
    const factory = new ThreeDffFactory({
      textureDictionary: this.textureDictionary,
      path: this.path,
    });
    return factory.create(clump);
  }
}

export { DFFLoader };
export default DFFLoader;
