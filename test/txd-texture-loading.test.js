import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { TXDLoader } from '../src/lib/jsrw/TXDLoader.js';
import { TxdParser } from '../src/lib/jsrw/formats/txd/TxdParser.js';
import { normalizeTextureDictionary } from '../src/lib/jsrw/adapters/three/ThreeMaterialAdapter.js';
import { buildRWMaterialDescriptor } from '../src/lib/jsrw/adapters/three/ThreeMaterialAdapter.js';
import { RW_ALPHA_REF_DEFAULT } from '../src/lib/jsrw/core/material/RwMaterialDescriptor.js';
import {
  ThreeTextureFactory,
  decodeCompressedTexturePreview,
} from '../src/lib/jsrw/adapters/three/ThreeTextureFactory.js';

const KNACKERS_TXD_PATH = '/Users/nurupo/Desktop/ps2/vcs_map_ps2/Models/knackers.txd';

function makeCompressedLevel(byteLength, width, height) {
  return {
    data: new Uint8Array(byteLength),
    width,
    height,
  };
}

function makeEntry({
  name = 'sample',
  compressionName = 'DXT3',
  compression = 3,
  d3dFormat = 0x33545844,
  rasterFormat = 0x0500,
  hasAlpha = true,
  mipmaps = [makeCompressedLevel(16, 4, 4)],
} = {}) {
  return {
    name,
    alphaName: '',
    width: mipmaps[0].width,
    height: mipmaps[0].height,
    depth: 32,
    numLevels: mipmaps.length,
    rasterType: 4,
    platformId: 9,
    textureFormatFlags: { raw: 0, filterMode: 0, uAddressing: 0, vAddressing: 0, pad: 0 },
    hasAlpha,
    legacyHasAlphaValue: 0,
    compression,
    compressionName,
    isCompressed: true,
    d3dFormat,
    platformProperties: {
      alpha: hasAlpha,
      cubeTexture: false,
      autoMipmaps: false,
      compressed: true,
    },
    platformPropertyValue: hasAlpha ? 9 : 8,
    rasterFormat,
    palette: null,
    mipmaps,
    rgba: null,
  };
}

test('TxdParser preserves native DXT metadata and mip payloads for knackers.txd', { skip: !fs.existsSync(KNACKERS_TXD_PATH) }, () => {
  const parsed = new TxdParser().parse(fs.readFileSync(KNACKERS_TXD_PATH));
  assert.equal(parsed.size, 6899);

  const beach = parsed.get('beach_2038');
  assert.ok(beach);
  assert.equal(beach.platformId, 9);
  assert.equal(beach.compressionName, 'DXT3');
  assert.equal(beach.numLevels, 1);
  assert.equal(beach.isCompressed, true);
  assert.equal(beach.mipmaps.length, 1);
  assert.equal(beach.mipmaps[0].width, 64);
  assert.equal(beach.mipmaps[0].height, 64);
  assert.equal(beach.mipmaps[0].data.length, 4096);
});

test('ThreeTextureFactory maps DXT formats to native compressed textures', () => {
  const factory = new ThreeTextureFactory({
    preferCompressedTextures: true,
    supportsCompressedTextures: true,
    allowCompressedFallbackDecode: true,
  });

  const dxt1Opaque = factory.createTexture(makeEntry({
    compressionName: 'DXT1',
    compression: 1,
    d3dFormat: 0x31545844,
    hasAlpha: false,
    mipmaps: [makeCompressedLevel(8, 4, 4)],
  }));
  assert.equal(dxt1Opaque.isCompressedTexture, true);
  assert.equal(dxt1Opaque.format, THREE.RGB_S3TC_DXT1_Format);

  const dxt1Alpha = factory.createTexture(makeEntry({
    compressionName: 'DXT1',
    compression: 1,
    d3dFormat: 0x31545844,
    hasAlpha: true,
    mipmaps: [makeCompressedLevel(8, 4, 4)],
  }));
  assert.equal(dxt1Alpha.format, THREE.RGBA_S3TC_DXT1_Format);

  const dxt3 = factory.createTexture(makeEntry());
  assert.equal(dxt3.format, THREE.RGBA_S3TC_DXT3_Format);

  const dxt5 = factory.createTexture(makeEntry({
    compressionName: 'DXT5',
    compression: 5,
    d3dFormat: 0x35545844,
  }));
  assert.equal(dxt5.format, THREE.RGBA_S3TC_DXT5_Format);
});

test('ThreeTextureFactory falls back to decoded DataTexture and preserves manual mipmaps', () => {
  const factory = new ThreeTextureFactory({
    preferCompressedTextures: true,
    supportsCompressedTextures: false,
    allowCompressedFallbackDecode: true,
  });
  const texture = factory.createTexture(makeEntry({
    mipmaps: [
      makeCompressedLevel(16, 4, 4),
      makeCompressedLevel(16, 2, 2),
    ],
  }));

  assert.equal(texture.isDataTexture, true);
  assert.equal(texture.generateMipmaps, false);
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(texture.mipmaps.length, 2);
  assert.equal(texture.mipmaps[0].width, 4);
  assert.equal(texture.mipmaps[1].width, 2);
});

test('normalizeTextureDictionary preserves compression and pixel-format metadata', () => {
  const rawEntries = new ThreeTextureFactory({
    preferCompressedTextures: true,
    supportsCompressedTextures: true,
    allowCompressedFallbackDecode: true,
  }).createDictionary(new Map([
    ['sample', makeEntry()],
  ]));

  const normalized = normalizeTextureDictionary(rawEntries, {
    metadataByName: new Map([
      ['sample', {
        compression: 3,
        d3dFormat: 0x33545844,
        rasterFormat: 0x0500,
        platformId: 9,
      }],
    ]),
  });

  const sample = normalized.get('sample');
  assert.ok(sample);
  assert.equal(sample.compressionMethod, 'DXT3');
  assert.equal(sample.pixelFormat, 'RASTER_8888');
  assert.equal(sample.texture.userData.rwCompressionMethod, 'DXT3');
  assert.equal(sample.texture.userData.rwPixelFormat, 'RASTER_8888');
});

test('decodeCompressedTexturePreview returns RGBA pixels for compressed textures', () => {
  const texture = new ThreeTextureFactory({
    preferCompressedTextures: true,
    supportsCompressedTextures: true,
    allowCompressedFallbackDecode: true,
  }).createTexture(makeEntry());

  const pixels = decodeCompressedTexturePreview(texture);
  assert.ok(pixels instanceof Uint8Array);
  assert.equal(pixels.length, 4 * 4 * 4);
});

test('buildRWMaterialDescriptor keeps explicit blend materials as blend', () => {
  const texture = new ThreeTextureFactory({
    preferCompressedTextures: true,
    supportsCompressedTextures: true,
    allowCompressedFallbackDecode: true,
  }).createTexture(makeEntry({
    name: 'beach_1660',
    mipmaps: [makeCompressedLevel(16, 4, 4)],
  }));
  texture.userData = {
    ...(texture.userData || {}),
    rwTextureAlphaMode: 'blend',
  };

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 1,
  });
  const descriptor = buildRWMaterialDescriptor(material, null);
  assert.equal(descriptor.alphaMode, 'blend');
  assert.equal(descriptor.transparent, true);
  assert.equal(descriptor.depthWrite, false);
});

test('buildRWMaterialDescriptor chooses revc-style cutout for compressed foliage-like alpha', () => {
  const loader = new TXDLoader(undefined, {
    preferCompressedTextures: true,
    supportsCompressedTextures: true,
    allowCompressedFallbackDecode: true,
  });
  const dict = loader.parse(fs.readFileSync(KNACKERS_TXD_PATH));
  const texture = dict.get('beach_1660').texture;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: false,
    opacity: 1,
  });
  const descriptor = buildRWMaterialDescriptor(material, null);
  assert.equal(descriptor.alphaMode, 'cutout');
  assert.equal(descriptor.transparent, false);
  assert.equal(descriptor.depthWrite, true);
  assert.equal(descriptor.renderBucket, 'cutout');
  assert.equal(descriptor.alphaRef, RW_ALPHA_REF_DEFAULT);
});
