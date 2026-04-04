import ChunkType from '../../ChunkType.js';

const TextureFormat = {
  FORMAT_1555: 0x0100,
  FORMAT_565: 0x0200,
  FORMAT_4444: 0x0300,
  FORMAT_LUM8: 0x0400,
  FORMAT_8888: 0x0500,
  FORMAT_888: 0x0600,
  FORMAT_555: 0x0A00,
  FORMAT_EXT_AUTO_MIPMAP: 0x1000,
  FORMAT_EXT_PAL8: 0x2000,
  FORMAT_EXT_PAL4: 0x4000,
  FORMAT_EXT_MIPMAP: 0x8000,
};

const D3DFORMAT = {
  D3DFMT_A8R8G8B8: 21,
  D3DFMT_X8R8G8B8: 22,
  D3DFMT_R5G6B5: 23,
  D3DFMT_A1R5G5B5: 25,
  D3DFMT_A4R4G4B4: 26,
  D3DFMT_DXT1: 0x31545844,
  D3DFMT_DXT3: 0x33545844,
  D3DFMT_DXT5: 0x35545844,
};

const DXT_COMPRESSION_NAMES = new Set(['DXT1', 'DXT3', 'DXT5']);

function getCompressionName(compression, d3dFormat) {
  const fmt = Number(d3dFormat);
  if (fmt === D3DFORMAT.D3DFMT_DXT1) return 'DXT1';
  if (fmt === D3DFORMAT.D3DFMT_DXT3) return 'DXT3';
  if (fmt === D3DFORMAT.D3DFMT_DXT5) return 'DXT5';
  if (
    fmt === D3DFORMAT.D3DFMT_A8R8G8B8 ||
    fmt === D3DFORMAT.D3DFMT_X8R8G8B8 ||
    fmt === D3DFORMAT.D3DFMT_R5G6B5 ||
    fmt === D3DFORMAT.D3DFMT_A1R5G5B5 ||
    fmt === D3DFORMAT.D3DFMT_A4R4G4B4
  ) {
    return 'RAW';
  }
  const c = Number(compression);
  if (c === 1 || c === 8) return 'DXT1';
  if (c === 3) return 'DXT3';
  if (c === 5 || c === 9) return 'DXT5';
  if (c > 0) return `COMP_${c}`;
  return 'RAW';
}

function getRasterFormatType(rasterFormat) {
  return Number(rasterFormat) & 0x0F00;
}

function parseTextureFormatFlags(value) {
  const flags = Number(value) >>> 0;
  return {
    raw: flags,
    filterMode: flags & 0xFF,
    uAddressing: (flags >> 8) & 0x0F,
    vAddressing: (flags >> 12) & 0x0F,
    pad: (flags >> 16) & 0xFFFF,
  };
}

function isDxtCompressionName(compressionName) {
  return DXT_COMPRESSION_NAMES.has(String(compressionName || '').toUpperCase());
}

function getMipDimension(size, level) {
  return Math.max(1, Number(size) >> level);
}

function rgb565ToRgba(color) {
  const r = ((color >> 11) & 0x1F) * 255 / 31;
  const g = ((color >> 5) & 0x3F) * 255 / 63;
  const b = (color & 0x1F) * 255 / 31;
  return [Math.round(r), Math.round(g), Math.round(b), 255];
}

function interpolateColor(c0, c1, factor) {
  return [
    Math.round(c0[0] + (c1[0] - c0[0]) * factor),
    Math.round(c0[1] + (c1[1] - c0[1]) * factor),
    Math.round(c0[2] + (c1[2] - c0[2]) * factor),
    255,
  ];
}

function decodeDXT1(data, width, height) {
  const output = new Uint8Array(width * height * 4);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  let srcOffset = 0;
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      const c0 = data[srcOffset] | (data[srcOffset + 1] << 8);
      const c1 = data[srcOffset + 2] | (data[srcOffset + 3] << 8);
      srcOffset += 4;
      const colors = [rgb565ToRgba(c0), rgb565ToRgba(c1)];
      if (c0 > c1) {
        colors[2] = interpolateColor(colors[0], colors[1], 1 / 3);
        colors[3] = interpolateColor(colors[0], colors[1], 2 / 3);
      } else {
        colors[2] = interpolateColor(colors[0], colors[1], 0.5);
        colors[3] = [0, 0, 0, 0];
      }
      const indices = data[srcOffset] | (data[srcOffset + 1] << 8) | (data[srcOffset + 2] << 16) | (data[srcOffset + 3] << 24);
      srcOffset += 4;
      for (let py = 0; py < 4; py += 1) {
        for (let px = 0; px < 4; px += 1) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const idx = (indices >> ((py * 4 + px) * 2)) & 0x3;
          const color = colors[idx];
          const dstOffset = (y * width + x) * 4;
          output[dstOffset + 0] = color[0];
          output[dstOffset + 1] = color[1];
          output[dstOffset + 2] = color[2];
          output[dstOffset + 3] = color[3];
        }
      }
    }
  }
  return output;
}

function decodeDXT3(data, width, height) {
  const output = new Uint8Array(width * height * 4);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  let srcOffset = 0;
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      const alphaData = [];
      for (let i = 0; i < 8; i += 1) alphaData.push(data[srcOffset + i]);
      srcOffset += 8;
      const c0 = data[srcOffset] | (data[srcOffset + 1] << 8);
      const c1 = data[srcOffset + 2] | (data[srcOffset + 3] << 8);
      srcOffset += 4;
      const colors = [
        rgb565ToRgba(c0),
        rgb565ToRgba(c1),
        interpolateColor(rgb565ToRgba(c0), rgb565ToRgba(c1), 1 / 3),
        interpolateColor(rgb565ToRgba(c0), rgb565ToRgba(c1), 2 / 3),
      ];
      const indices = data[srcOffset] | (data[srcOffset + 1] << 8) | (data[srcOffset + 2] << 16) | (data[srcOffset + 3] << 24);
      srcOffset += 4;
      for (let py = 0; py < 4; py += 1) {
        for (let px = 0; px < 4; px += 1) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const idx = (indices >> ((py * 4 + px) * 2)) & 0x3;
          const color = colors[idx];
          const alphaIdx = py * 4 + px;
          const alphaByte = alphaData[Math.floor(alphaIdx / 2)];
          const alpha = ((alphaIdx % 2 === 0) ? (alphaByte & 0xF) : (alphaByte >> 4)) * 17;
          const dstOffset = (y * width + x) * 4;
          output[dstOffset + 0] = color[0];
          output[dstOffset + 1] = color[1];
          output[dstOffset + 2] = color[2];
          output[dstOffset + 3] = alpha;
        }
      }
    }
  }
  return output;
}

function decodeDXT5(data, width, height) {
  const output = new Uint8Array(width * height * 4);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  let srcOffset = 0;
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      const a0 = data[srcOffset];
      const a1 = data[srcOffset + 1];
      srcOffset += 2;
      let alphaBits = 0n;
      for (let i = 0; i < 6; i += 1) alphaBits |= BigInt(data[srcOffset + i]) << BigInt(i * 8);
      srcOffset += 6;
      const alphas = [a0, a1];
      if (a0 > a1) {
        for (let i = 1; i <= 6; i += 1) alphas.push(Math.floor(((7 - i) * a0 + i * a1) / 7));
      } else {
        for (let i = 1; i <= 4; i += 1) alphas.push(Math.floor(((5 - i) * a0 + i * a1) / 5));
        alphas.push(0, 255);
      }
      const c0 = data[srcOffset] | (data[srcOffset + 1] << 8);
      const c1 = data[srcOffset + 2] | (data[srcOffset + 3] << 8);
      srcOffset += 4;
      const colors = [
        rgb565ToRgba(c0),
        rgb565ToRgba(c1),
        interpolateColor(rgb565ToRgba(c0), rgb565ToRgba(c1), 1 / 3),
        interpolateColor(rgb565ToRgba(c0), rgb565ToRgba(c1), 2 / 3),
      ];
      const colorBits = data[srcOffset] | (data[srcOffset + 1] << 8) | (data[srcOffset + 2] << 16) | (data[srcOffset + 3] << 24);
      srcOffset += 4;
      for (let py = 0; py < 4; py += 1) {
        for (let px = 0; px < 4; px += 1) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const color = colors[(colorBits >> ((py * 4 + px) * 2)) & 0x3];
          const alphaIndex = Number((alphaBits >> BigInt((py * 4 + px) * 3)) & 0x7n);
          const dstOffset = (y * width + x) * 4;
          output[dstOffset + 0] = color[0];
          output[dstOffset + 1] = color[1];
          output[dstOffset + 2] = color[2];
          output[dstOffset + 3] = alphas[alphaIndex];
        }
      }
    }
  }
  return output;
}

function decodePal8(data, palette, width, height) {
  const output = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const index = data[i];
    output[i * 4 + 0] = palette[index * 4 + 0];
    output[i * 4 + 1] = palette[index * 4 + 1];
    output[i * 4 + 2] = palette[index * 4 + 2];
    output[i * 4 + 3] = palette[index * 4 + 3];
  }
  return output;
}

function decodePal4(data, palette, width, height) {
  const output = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const byteIndex = Math.floor(i / 2);
    const paletteIndex = i % 2 === 0 ? (data[byteIndex] & 0xF) : (data[byteIndex] >> 4);
    output[i * 4 + 0] = palette[paletteIndex * 4 + 0];
    output[i * 4 + 1] = palette[paletteIndex * 4 + 1];
    output[i * 4 + 2] = palette[paletteIndex * 4 + 2];
    output[i * 4 + 3] = palette[paletteIndex * 4 + 3];
  }
  return output;
}

function decodeUncompressed(data, width, height, d3dFormat, rasterFormat) {
  const output = new Uint8Array(width * height * 4);
  const formatType = rasterFormat & 0x0F00;
  const hasExplicitX8Pixels = formatType === TextureFormat.FORMAT_888 && data.length === width * height * 4;
  for (let i = 0; i < width * height; i += 1) {
    let r;
    let g;
    let b;
    let a;
    if (d3dFormat === D3DFORMAT.D3DFMT_A8R8G8B8 || formatType === TextureFormat.FORMAT_8888) {
      b = data[i * 4 + 0];
      g = data[i * 4 + 1];
      r = data[i * 4 + 2];
      a = data[i * 4 + 3];
    } else if (d3dFormat === D3DFORMAT.D3DFMT_X8R8G8B8 || hasExplicitX8Pixels) {
      b = data[i * 4 + 0];
      g = data[i * 4 + 1];
      r = data[i * 4 + 2];
      a = 255;
    } else if (formatType === TextureFormat.FORMAT_888) {
      b = data[i * 3 + 0];
      g = data[i * 3 + 1];
      r = data[i * 3 + 2];
      a = 255;
    } else if (d3dFormat === D3DFORMAT.D3DFMT_R5G6B5 || formatType === TextureFormat.FORMAT_565) {
      const pixel = data[i * 2] | (data[i * 2 + 1] << 8);
      r = ((pixel >> 11) & 0x1F) * 255 / 31;
      g = ((pixel >> 5) & 0x3F) * 255 / 63;
      b = (pixel & 0x1F) * 255 / 31;
      a = 255;
    } else if (d3dFormat === D3DFORMAT.D3DFMT_A1R5G5B5 || formatType === TextureFormat.FORMAT_1555) {
      const pixel = data[i * 2] | (data[i * 2 + 1] << 8);
      a = (pixel >> 15) ? 255 : 0;
      r = ((pixel >> 10) & 0x1F) * 255 / 31;
      g = ((pixel >> 5) & 0x1F) * 255 / 31;
      b = (pixel & 0x1F) * 255 / 31;
    } else if (d3dFormat === D3DFORMAT.D3DFMT_A4R4G4B4 || formatType === TextureFormat.FORMAT_4444) {
      const pixel = data[i * 2] | (data[i * 2 + 1] << 8);
      a = ((pixel >> 12) & 0xF) * 17;
      r = ((pixel >> 8) & 0xF) * 17;
      g = ((pixel >> 4) & 0xF) * 17;
      b = (pixel & 0xF) * 17;
    } else {
      b = data[i * 4 + 0] || 0;
      g = data[i * 4 + 1] || 0;
      r = data[i * 4 + 2] || 0;
      a = data[i * 4 + 3] || 255;
    }
    output[i * 4 + 0] = r;
    output[i * 4 + 1] = g;
    output[i * 4 + 2] = b;
    output[i * 4 + 3] = a;
  }
  return output;
}

export function decodeTextureEntryMipLevel(entry, level = 0) {
  const mipLevel = Array.isArray(entry?.mipmaps) ? entry.mipmaps[level] : null;
  if (!mipLevel?.data || !Number.isFinite(mipLevel.width) || !Number.isFinite(mipLevel.height)) return null;

  const compressionName = getCompressionName(entry?.compression ?? 0, entry?.d3dFormat ?? 0);
  if (compressionName === 'DXT1') return decodeDXT1(mipLevel.data, mipLevel.width, mipLevel.height);
  if (compressionName === 'DXT3') return decodeDXT3(mipLevel.data, mipLevel.width, mipLevel.height);
  if (compressionName === 'DXT5') return decodeDXT5(mipLevel.data, mipLevel.width, mipLevel.height);

  const rasterFormat = Number(entry?.rasterFormat) || 0;
  const isPal8 = (rasterFormat & TextureFormat.FORMAT_EXT_PAL8) !== 0;
  const isPal4 = (rasterFormat & TextureFormat.FORMAT_EXT_PAL4) !== 0;
  if (isPal8) return decodePal8(mipLevel.data, entry?.palette || null, mipLevel.width, mipLevel.height);
  if (isPal4) return decodePal4(mipLevel.data, entry?.palette || null, mipLevel.width, mipLevel.height);
  return decodeUncompressed(
    mipLevel.data,
    mipLevel.width,
    mipLevel.height,
    Number(entry?.d3dFormat) || 0,
    rasterFormat,
  );
}

export function decodeTextureEntryMipmaps(entry) {
  if (!Array.isArray(entry?.mipmaps) || entry.mipmaps.length === 0) return [];
  return entry.mipmaps
    .map((mipLevel, levelIndex) => {
      const rgba = decodeTextureEntryMipLevel(entry, levelIndex);
      if (!rgba) return null;
      return {
        width: mipLevel.width,
        height: mipLevel.height,
        data: rgba,
      };
    })
    .filter(Boolean);
}

export class TxdParser {
  parse(input) {
    const view = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.arraybuffer = view.buffer;
    this.byteOffset = view.byteOffset;
    this.byteLength = view.byteLength;
    this.data = new DataView(view.buffer, view.byteOffset, view.byteLength);
    this.position = 0;
    const textures = new Map();

    const header = this.readHeader();
    if (header.type !== ChunkType.CHUNK_TEXDICTIONARY) {
      throw new Error('TxdParser: Not a valid TXD file');
    }

    this.readHeader();
    const textureCount = this.readUInt16();
    this.readUInt16();

    for (let i = 0; i < textureCount; i += 1) {
      try {
        const texture = this.readTextureNative();
        if (!texture) continue;
        textures.set(texture.name.toLowerCase(), texture);
      } catch (error) {
        console.warn(`TxdParser: Failed to decode texture ${i}:`, error.message);
      }
    }

    return textures;
  }

  readHeader() {
    return {
      type: this.readUInt32(),
      length: this.readUInt32(),
      build: this.readUInt32(),
    };
  }

  readTextureNative() {
    const header = this.readHeader();
    if (header.type !== ChunkType.CHUNK_TEXTURENATIVE) {
      this.position += header.length;
      return null;
    }

    const chunkEnd = this.position + header.length;
    this.readHeader();

    const platformId = this.readUInt32();
    const textureFormatFlags = parseTextureFormatFlags(this.readUInt32());
    const name = this.readString(32);
    const alphaName = this.readString(32);
    const rasterFormat = this.readUInt32();

    let width;
    let height;
    let depth;
    let numLevels;
    let rasterType;
    let compression;
    let hasAlpha = false;
    let d3dFormat = 0;
    let platformPropertyValue = 0;
    let platformProperties = null;
    let legacyHasAlphaValue = 0;

    if (platformId === 9) {
      d3dFormat = this.readUInt32();
      width = this.readUInt16();
      height = this.readUInt16();
      depth = this.readUInt8();
      numLevels = this.readUInt8();
      rasterType = this.readUInt8();
      platformPropertyValue = this.readUInt8();
      platformProperties = this.parsePlatformProperties(platformId, platformPropertyValue);
      compression = this.getCompressionCode(platformId, d3dFormat, platformProperties);
      hasAlpha = this.getHasAlpha(platformId, rasterFormat, d3dFormat, platformProperties);
    } else if (platformId === 8) {
      legacyHasAlphaValue = this.readUInt32();
      width = this.readUInt16();
      height = this.readUInt16();
      depth = this.readUInt8();
      numLevels = this.readUInt8();
      rasterType = this.readUInt8();
      compression = this.readUInt8();
      hasAlpha = legacyHasAlphaValue !== 0;
    } else {
      console.warn(`TxdParser: Unsupported platform ID: ${platformId}`);
      this.position = chunkEnd;
      return null;
    }

    const isPal8 = (rasterFormat & TextureFormat.FORMAT_EXT_PAL8) !== 0;
    const isPal4 = (rasterFormat & TextureFormat.FORMAT_EXT_PAL4) !== 0;

    let palette = null;
    if (isPal8) {
      palette = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i += 1) {
        palette[i * 4 + 2] = this.readUInt8();
        palette[i * 4 + 1] = this.readUInt8();
        palette[i * 4 + 0] = this.readUInt8();
        palette[i * 4 + 3] = this.readUInt8();
      }
    } else if (isPal4) {
      palette = new Uint8Array(16 * 4);
      for (let i = 0; i < 16; i += 1) {
        palette[i * 4 + 2] = this.readUInt8();
        palette[i * 4 + 1] = this.readUInt8();
        palette[i * 4 + 0] = this.readUInt8();
        palette[i * 4 + 3] = this.readUInt8();
      }
    }

    const compressionName = getCompressionName(compression, d3dFormat);
    const effectiveNumLevels = Math.max(1, Number(numLevels) || 0);
    const mipmaps = [];
    for (let level = 0; level < effectiveNumLevels; level += 1) {
      const mipSize = this.readUInt32();
      const levelWidth = getMipDimension(width, level);
      const levelHeight = getMipDimension(height, level);
      const rawData = new Uint8Array(this.arraybuffer, this.byteOffset + this.position, mipSize);
      mipmaps.push({
        width: levelWidth,
        height: levelHeight,
        data: rawData,
      });
      this.position += mipSize;
    }

    const extHeader = this.readHeader();
    this.position += extHeader.length;

    const isCompressed = isDxtCompressionName(compressionName);
    const entry = {
      name,
      alphaName,
      width,
      height,
      depth,
      numLevels: effectiveNumLevels,
      rasterType,
      platformId,
      textureFormatFlags,
      hasAlpha,
      legacyHasAlphaValue,
      compression,
      compressionName,
      isCompressed,
      d3dFormat,
      platformProperties,
      platformPropertyValue,
      rasterFormat,
      palette,
      mipmaps,
      rgba: null,
    };
    if (!isCompressed) {
      entry.rgba = decodeTextureEntryMipLevel(entry, 0);
    }

    return entry;
  }

  parsePlatformProperties(platformId, propertyValue) {
    const value = Number(propertyValue) & 0xFF;
    if (platformId === 9) {
      return {
        alpha: (value & 0x01) !== 0,
        cubeTexture: (value & 0x02) !== 0,
        autoMipmaps: (value & 0x04) !== 0,
        compressed: (value & 0x08) !== 0,
      };
    }
    return null;
  }

  getCompressionCode(platformId, d3dFormat, platformProperties) {
    const fmt = Number(d3dFormat);
    if (fmt === D3DFORMAT.D3DFMT_DXT1) return 1;
    if (fmt === D3DFORMAT.D3DFMT_DXT3) return 3;
    if (fmt === D3DFORMAT.D3DFMT_DXT5) return 5;
    return 0;
  }

  getHasAlpha(platformId, rasterFormat, d3dFormat, platformProperties) {
    if (platformId === 9) {
      return Boolean(platformProperties?.alpha);
    }

    const fmt = Number(d3dFormat);
    if (
      fmt === D3DFORMAT.D3DFMT_DXT3
      || fmt === D3DFORMAT.D3DFMT_DXT5
      || fmt === D3DFORMAT.D3DFMT_A8R8G8B8
      || fmt === D3DFORMAT.D3DFMT_A4R4G4B4
      || fmt === D3DFORMAT.D3DFMT_A1R5G5B5
    ) {
      return true;
    }
    if (
      fmt === D3DFORMAT.D3DFMT_X8R8G8B8
      || fmt === D3DFORMAT.D3DFMT_R5G6B5
      || fmt === D3DFORMAT.D3DFMT_DXT1
    ) {
      return false;
    }

    const formatType = getRasterFormatType(rasterFormat);
    return !(
      formatType === TextureFormat.FORMAT_565
      || formatType === TextureFormat.FORMAT_LUM8
      || formatType === TextureFormat.FORMAT_888
      || formatType === TextureFormat.FORMAT_555
    );
  }

  decodeDXT1(data, width, height) {
    return decodeDXT1(data, width, height);
  }

  decodeDXT3(data, width, height) {
    return decodeDXT3(data, width, height);
  }

  decodeDXT5(data, width, height) {
    return decodeDXT5(data, width, height);
  }

  decodePal8(data, palette, width, height) {
    return decodePal8(data, palette, width, height);
  }

  decodePal4(data, palette, width, height) {
    return decodePal4(data, palette, width, height);
  }

  decodeUncompressed(data, width, height, d3dFormat, rasterFormat) {
    return decodeUncompressed(data, width, height, d3dFormat, rasterFormat);
  }

  rgb565ToRgba(color) {
    return rgb565ToRgba(color);
  }

  interpolateColor(c0, c1, factor) {
    return interpolateColor(c0, c1, factor);
  }

  readUInt32() {
    const value = this.data.getUint32(this.position, true);
    this.position += 4;
    return value;
  }

  readUInt16() {
    const value = this.data.getUint16(this.position, true);
    this.position += 2;
    return value;
  }

  readUInt8() {
    const value = this.data.getUint8(this.position);
    this.position += 1;
    return value;
  }

  readString(length) {
    let result = '';
    for (let i = 0; i < length; i += 1) {
      const char = this.data.getUint8(this.position + i);
      if (char === 0) break;
      result += String.fromCharCode(char);
    }
    this.position += length;
    return result.trim();
  }
}

export default TxdParser;
