import ChunkType from '../../ChunkType.js';

const TextureFormat = {
  FORMAT_1555: 0x0100,
  FORMAT_565: 0x0200,
  FORMAT_4444: 0x0300,
  FORMAT_LUM8: 0x0400,
  FORMAT_8888: 0x0500,
  FORMAT_888: 0x0600,
  FORMAT_555: 0x0A00,
  FORMAT_EXT_PAL8: 0x2000,
  FORMAT_EXT_PAL4: 0x4000,
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
    this.readUInt32();
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

    if (platformId === 9) {
      d3dFormat = this.readUInt32();
      width = this.readUInt16();
      height = this.readUInt16();
      depth = this.readUInt8();
      numLevels = this.readUInt8();
      rasterType = this.readUInt8();
      compression = this.readUInt8();
      hasAlpha = (
        d3dFormat === D3DFORMAT.D3DFMT_DXT3 ||
        d3dFormat === D3DFORMAT.D3DFMT_DXT5 ||
        d3dFormat === D3DFORMAT.D3DFMT_A8R8G8B8 ||
        d3dFormat === D3DFORMAT.D3DFMT_A4R4G4B4 ||
        d3dFormat === D3DFORMAT.D3DFMT_A1R5G5B5
      );
    } else if (platformId === 8) {
      hasAlpha = this.readUInt32() !== 0;
      width = this.readUInt16();
      height = this.readUInt16();
      depth = this.readUInt8();
      numLevels = this.readUInt8();
      rasterType = this.readUInt8();
      compression = this.readUInt8();
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

    const dataSize = this.readUInt32();
    const rawData = new Uint8Array(this.arraybuffer, this.byteOffset + this.position, dataSize);
    this.position += dataSize;
    const compressionName = getCompressionName(compression, d3dFormat);

    let rgba;
    if (compressionName === 'DXT1') rgba = this.decodeDXT1(rawData, width, height);
    else if (compressionName === 'DXT3') rgba = this.decodeDXT3(rawData, width, height);
    else if (compressionName === 'DXT5') rgba = this.decodeDXT5(rawData, width, height);
    else if (isPal8) rgba = this.decodePal8(rawData, palette, width, height);
    else if (isPal4) rgba = this.decodePal4(rawData, palette, width, height);
    else rgba = this.decodeUncompressed(rawData, width, height, d3dFormat, rasterFormat);

    for (let level = 1; level < numLevels; level += 1) {
      const mipSize = this.readUInt32();
      this.position += mipSize;
    }

    const extHeader = this.readHeader();
    this.position += extHeader.length;

    return {
      name,
      alphaName,
      width,
      height,
      depth,
      rasterType,
      platformId,
      hasAlpha,
      compression,
      compressionName,
      d3dFormat,
      rasterFormat,
      rgba,
    };
  }

  decodeDXT1(data, width, height) {
    const output = new Uint8Array(width * height * 4);
    const blocksX = Math.ceil(width / 4);
    const blocksY = Math.ceil(height / 4);
    let srcOffset = 0;
    for (let by = 0; by < blocksY; by += 1) {
      for (let bx = 0; bx < blocksX; bx += 1) {
        const c0 = data[srcOffset] | (data[srcOffset + 1] << 8);
        const c1 = data[srcOffset + 2] | (data[srcOffset + 3] << 8);
        srcOffset += 4;
        const colors = [this.rgb565ToRgba(c0), this.rgb565ToRgba(c1)];
        if (c0 > c1) {
          colors[2] = this.interpolateColor(colors[0], colors[1], 1 / 3);
          colors[3] = this.interpolateColor(colors[0], colors[1], 2 / 3);
        } else {
          colors[2] = this.interpolateColor(colors[0], colors[1], 0.5);
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

  decodeDXT3(data, width, height) {
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
          this.rgb565ToRgba(c0),
          this.rgb565ToRgba(c1),
          this.interpolateColor(this.rgb565ToRgba(c0), this.rgb565ToRgba(c1), 1 / 3),
          this.interpolateColor(this.rgb565ToRgba(c0), this.rgb565ToRgba(c1), 2 / 3),
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

  decodeDXT5(data, width, height) {
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
          this.rgb565ToRgba(c0),
          this.rgb565ToRgba(c1),
          this.interpolateColor(this.rgb565ToRgba(c0), this.rgb565ToRgba(c1), 1 / 3),
          this.interpolateColor(this.rgb565ToRgba(c0), this.rgb565ToRgba(c1), 2 / 3),
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

  decodePal8(data, palette, width, height) {
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

  decodePal4(data, palette, width, height) {
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

  decodeUncompressed(data, width, height, d3dFormat, rasterFormat) {
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

  rgb565ToRgba(color) {
    const r = ((color >> 11) & 0x1F) * 255 / 31;
    const g = ((color >> 5) & 0x3F) * 255 / 63;
    const b = (color & 0x1F) * 255 / 31;
    return [Math.round(r), Math.round(g), Math.round(b), 255];
  }

  interpolateColor(c0, c1, factor) {
    return [
      Math.round(c0[0] + (c1[0] - c0[0]) * factor),
      Math.round(c0[1] + (c1[1] - c0[1]) * factor),
      Math.round(c0[2] + (c1[2] - c0[2]) * factor),
      255,
    ];
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
