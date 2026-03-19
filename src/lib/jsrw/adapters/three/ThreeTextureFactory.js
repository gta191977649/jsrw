import * as THREE from 'three';

export class ThreeTextureFactory {
  createTexture(entry) {
    const texture = new THREE.DataTexture(entry.rgba, entry.width, entry.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.name = entry.name;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  createDictionary(entries) {
    const textures = new Map();
    for (const [key, entry] of entries.entries()) {
      textures.set(key, {
        texture: this.createTexture(entry),
        hasAlpha: entry.hasAlpha,
        compression: entry.compression,
        compressionName: entry.compressionName,
        d3dFormat: entry.d3dFormat,
        rasterFormat: entry.rasterFormat,
        platformId: entry.platformId,
        width: entry.width,
        height: entry.height,
      });
    }
    return textures;
  }
}

export default ThreeTextureFactory;
