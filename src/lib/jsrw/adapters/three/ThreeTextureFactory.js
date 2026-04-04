import * as THREE from 'three';
import {
  decodeTextureEntryMipLevel,
  decodeTextureEntryMipmaps,
} from '../../formats/txd/TxdParser.js';

const DEFAULT_TEXTURE_OPTIONS = Object.freeze({
  preferCompressedTextures: false,
  supportsCompressedTextures: false,
  allowCompressedFallbackDecode: true,
});

function mapPixelFormat(rasterFormat, d3dFormat) {
  const raster = Number(rasterFormat) & 0x0F00;
  if (raster === 0x0100) return 'RASTER_1555';
  if (raster === 0x0200) return 'RASTER_565';
  if (raster === 0x0300) return 'RASTER_4444';
  if (raster === 0x0400) return 'RASTER_LUM8';
  if (raster === 0x0500) return 'RASTER_8888';
  if (raster === 0x0600) return 'RASTER_888';
  if (raster === 0x0A00) return 'RASTER_555';
  const fmt = Number(d3dFormat);
  if (fmt === 21) return 'A8R8G8B8';
  if (fmt === 22) return 'X8R8G8B8';
  if (fmt === 23) return 'R5G6B5';
  if (fmt === 25) return 'A1R5G5B5';
  if (fmt === 26) return 'A4R4G4B4';
  if (!Number.isFinite(fmt) || fmt === 0) return 'UNKNOWN';
  return `0x${fmt.toString(16).toUpperCase()}`;
}

function normalizeOptions(options = {}) {
  return {
    ...DEFAULT_TEXTURE_OPTIONS,
    ...(options || {}),
  };
}

function isCompressedEntry(entry) {
  return entry?.isCompressed === true
    || entry?.compressionName === 'DXT1'
    || entry?.compressionName === 'DXT3'
    || entry?.compressionName === 'DXT5';
}

function getCompressedTextureFormat(entry) {
  const compressionName = String(entry?.compressionName || '').toUpperCase();
  if (compressionName === 'DXT1') {
    return entry?.hasAlpha === true
      ? THREE.RGBA_S3TC_DXT1_Format
      : THREE.RGB_S3TC_DXT1_Format;
  }
  if (compressionName === 'DXT3') return THREE.RGBA_S3TC_DXT3_Format;
  if (compressionName === 'DXT5') return THREE.RGBA_S3TC_DXT5_Format;
  return null;
}

function cloneMipmaps(mipmaps = []) {
  return mipmaps.map((mipmap) => ({
    data: mipmap.data,
    width: mipmap.width,
    height: mipmap.height,
  }));
}

function applyCommonTextureState(texture, entry, {
  isCompressed = false,
  hasManualMipmaps = false,
} = {}) {
  texture.name = entry.name;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = hasManualMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.hasAlpha = entry.hasAlpha === true;
  texture.userData = {
    ...(texture.userData || {}),
    rwCompressionMethod: entry.compressionName || 'RAW',
    rwPixelFormat: entry.pixelFormat || mapPixelFormat(entry.rasterFormat, entry.d3dFormat),
    rwD3dFormat: Number(entry.d3dFormat) || 0,
    rwRasterFormat: Number(entry.rasterFormat) || 0,
    rwPlatformId: Number(entry.platformId) || 0,
    rwHasAlpha: entry.hasAlpha === true,
    rwTextureStorage: isCompressed ? 'compressed' : 'decoded',
    rwTextureMipCount: Number(entry.numLevels) || (Array.isArray(entry.mipmaps) ? entry.mipmaps.length : 0),
  };
  texture.needsUpdate = true;
  return texture;
}

export function decodeCompressedTexturePreview(texture) {
  if (!texture?.isCompressedTexture) return null;
  const mipmaps = Array.isArray(texture.mipmaps) ? texture.mipmaps : [];
  if (mipmaps.length === 0) return null;

  const previewEntry = {
    compressionName: texture.userData?.rwCompressionMethod || 'RAW',
    d3dFormat: texture.userData?.rwD3dFormat || 0,
    rasterFormat: texture.userData?.rwRasterFormat || 0,
    mipmaps: [
      {
        width: mipmaps[0].width,
        height: mipmaps[0].height,
        data: mipmaps[0].data,
      },
    ],
  };
  return decodeTextureEntryMipLevel(previewEntry, 0);
}

export class ThreeTextureFactory {
  constructor(options = {}) {
    this.options = normalizeOptions(options);
  }

  setOptions(options = {}) {
    this.options = normalizeOptions(options);
    return this;
  }

  canUseCompressedTexture(entry) {
    if (!isCompressedEntry(entry)) return false;
    if (this.options.preferCompressedTextures !== true) return false;
    if (this.options.supportsCompressedTextures !== true) return false;
    return getCompressedTextureFormat(entry) !== null;
  }

  createCompressedTexture(entry) {
    const format = getCompressedTextureFormat(entry);
    if (format === null) return null;
    const mipmaps = cloneMipmaps(entry.mipmaps || []);
    const texture = new THREE.CompressedTexture(
      mipmaps,
      entry.width,
      entry.height,
      format,
    );
    return applyCommonTextureState(texture, entry, {
      isCompressed: true,
      hasManualMipmaps: mipmaps.length > 1,
    });
  }

  createDecodedTexture(entry) {
    const decodedMipmaps = decodeTextureEntryMipmaps(entry);
    const baseMip = decodedMipmaps[0];
    if (!baseMip) {
      throw new Error(`ThreeTextureFactory: Failed to decode texture ${entry?.name || '<unnamed>'}`);
    }
    const texture = new THREE.DataTexture(
      baseMip.data,
      baseMip.width,
      baseMip.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    if (decodedMipmaps.length > 1) {
      texture.mipmaps = decodedMipmaps;
    }
    return applyCommonTextureState(texture, entry, {
      isCompressed: false,
      hasManualMipmaps: decodedMipmaps.length > 1,
    });
  }

  createTexture(entry) {
    if (this.canUseCompressedTexture(entry)) {
      return this.createCompressedTexture(entry);
    }
    if (isCompressedEntry(entry) && this.options.allowCompressedFallbackDecode === false) {
      throw new Error(`ThreeTextureFactory: Compressed texture fallback disabled for ${entry?.name || '<unnamed>'}`);
    }
    return this.createDecodedTexture(entry);
  }

  createDictionary(entries) {
    const textures = new Map();
    for (const [key, entry] of entries.entries()) {
      const texture = this.createTexture(entry);
      textures.set(key, {
        texture,
        hasAlpha: entry.hasAlpha,
        compression: entry.compression,
        compressionName: entry.compressionName,
        d3dFormat: entry.d3dFormat,
        rasterFormat: entry.rasterFormat,
        platformId: entry.platformId,
        width: entry.width,
        height: entry.height,
        numLevels: entry.numLevels,
        isCompressed: entry.isCompressed === true,
      });
    }
    return textures;
  }
}

export default ThreeTextureFactory;
