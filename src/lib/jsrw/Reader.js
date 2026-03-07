import ChunkType from './ChunkType.js';

const GeometryFlag = {
  rwTEXTURED: 0x00000004,
  rwPRELIT: 0x00000008,
  rwTEXTURED2: 0x00000080,
  rwNATIVE: 0x01000000,
};

class DFFReader {
  constructor() {
    this.data = null;
    this.position = 0;
  }

  parse(arraybuffer) {
    this.data = new DataView(arraybuffer);
    this.position = 0;

    while (this.position < arraybuffer.byteLength) {
      const clump = this.readChunk(ChunkType.CHUNK_CLUMP);
      if (clump) return clump;
    }

    return null;
  }

  readHeader(parent) {
    const header = {
      type: this.readUInt32(),
      length: 0,
      build: 0,
      version: 0,
    };

    header.name = this.getChunkName(header.type);
    header.length = this.readUInt32();
    header.build = this.readUInt32();

    if (header.build & 0xFFFF0000) {
      header.version = ((header.build >> 14) & 0x3FF00) | ((header.build >> 16) & 0x3F) | 0x30000;
    } else {
      header.version = header.build << 8;
    }

    if (parent !== undefined) header.parent = parent;
    return header;
  }

  getChunkName(type) {
    for (const name in ChunkType) {
      if (ChunkType[name] === type) return name;
    }
    return 'CHUNK_UNKNOWN';
  }

  checkBounds(size) {
    if (this.position + size > this.data.byteLength) {
      throw new Error(`DFFLoader: Buffer overflow at position ${this.position} (need ${size} bytes, have ${this.data.byteLength - this.position})`);
    }
  }

  readInt32() {
    this.checkBounds(4);
    const value = this.data.getInt32(this.position, true);
    this.position += 4;
    return value;
  }

  readUInt32() {
    this.checkBounds(4);
    const value = this.data.getUint32(this.position, true);
    this.position += 4;
    return value;
  }

  readUInt16() {
    this.checkBounds(2);
    const value = this.data.getUint16(this.position, true);
    this.position += 2;
    return value;
  }

  readUInt8() {
    this.checkBounds(1);
    const value = this.data.getUint8(this.position);
    this.position += 1;
    return value;
  }

  readFloat32() {
    this.checkBounds(4);
    const value = this.data.getFloat32(this.position, true);
    this.position += 4;
    return value;
  }

  readString(length) {
    let value = '';
    const end = this.position + length;

    while (this.position < end) {
      const current = this.data.getUint8(this.position++);
      if (current === 0) {
        this.position = end;
        break;
      }
      value += String.fromCharCode(current);
    }

    return value.trim();
  }

  readChunk(type, parent) {
    const position = this.position;
    const header = this.readHeader(parent);

    if (type !== header.type) {
      if (type !== ChunkType.CHUNK_CLUMP) {
        console.error(`DFFLoader: Chunk "${this.getChunkName(type)}" not found at position ${position}`);
      }
      this.position += header.length;
      return null;
    }

    const chunkStart = this.position;
    const chunk = this.readData(header);

    if (this.position < chunkStart + header.length) {
      console.warn(`DFFLoader: Chunk ${header.name} not read to end`);
      this.position = chunkStart + header.length;
    } else if (this.position > chunkStart + header.length) {
      throw new Error(`DFFLoader: Offset is outside the bounds of chunk ${header.name}`);
    }

    return chunk;
  }

  readData(chunkHeader) {
    let data = null;

    switch (chunkHeader.type) {
      case ChunkType.CHUNK_CLUMP: {
        const header = this.readHeader();
        const numAtomics = this.readUInt32();
        if (header.length === 0xC) {
          this.readUInt32();
          this.readUInt32();
        }
        data = {
          RWFrameList: this.readChunk(ChunkType.CHUNK_FRAMELIST),
          RWGeometryList: this.readChunk(ChunkType.CHUNK_GEOMETRYLIST),
          RWAtomicList: [],
        };
        for (let i = 0; i < numAtomics; i += 1) {
          data.RWAtomicList[i] = this.readChunk(ChunkType.CHUNK_ATOMIC);
        }
        this.readExtension(data);
        break;
      }

      case ChunkType.CHUNK_FRAMELIST: {
        this.readHeader();
        const numFrames = this.readUInt32();
        data = new Array(numFrames);
        for (let i = 0; i < numFrames; i += 1) {
          data[i] = {
            RWFrame: {
              rotationMatrix: [
                this.readFloat32(), this.readFloat32(), this.readFloat32(),
                this.readFloat32(), this.readFloat32(), this.readFloat32(),
                this.readFloat32(), this.readFloat32(), this.readFloat32(),
              ],
              position: [this.readFloat32(), this.readFloat32(), this.readFloat32()],
              parentIndex: this.readInt32(),
              flags: this.readUInt32(),
            },
          };
        }
        for (let i = 0; i < numFrames; i += 1) this.readExtension(data[i]);
        break;
      }

      case ChunkType.CHUNK_GEOMETRYLIST: {
        this.readHeader();
        const numGeometries = this.readUInt32();
        data = new Array(numGeometries);
        for (let i = 0; i < numGeometries; i += 1) {
          data[i] = this.readChunk(ChunkType.CHUNK_GEOMETRY);
        }
        break;
      }

      case ChunkType.CHUNK_GEOMETRY: {
        const header = this.readHeader();
        data = {
          format: this.readUInt32(),
          numTriangles: this.readUInt32(),
          numVertices: this.readUInt32(),
          numMorphTargets: this.readUInt32(),
        };

        let numUVs = (data.format >> 16) & 0xFF;
        if (numUVs === 0 && (data.format & GeometryFlag.rwTEXTURED)) numUVs = 1;

        console.log(`DFFLoader: Geometry - format: 0x${data.format.toString(16)}, verts: ${data.numVertices}, tris: ${data.numTriangles}, morphs: ${data.numMorphTargets}, UVs: ${numUVs}`);
        console.log(`DFFLoader: Flags - native: ${!!(data.format & GeometryFlag.rwNATIVE)}, prelit: ${!!(data.format & GeometryFlag.rwPRELIT)}, textured: ${!!(data.format & GeometryFlag.rwTEXTURED)}, textured2: ${!!(data.format & GeometryFlag.rwTEXTURED2)}`);

        if (header.version < 0x34000) {
          data.ambient = this.readFloat32();
          data.specular = this.readFloat32();
          data.diffuse = this.readFloat32();
        }

        const isNative = (data.format & GeometryFlag.rwNATIVE) !== 0;
        if (!isNative) {
          if (data.format & GeometryFlag.rwPRELIT) {
            data.prelitcolor = new Array(data.numVertices);
            for (let i = 0; i < data.numVertices; i += 1) {
              data.prelitcolor[i] = {
                r: this.readUInt8(),
                g: this.readUInt8(),
                b: this.readUInt8(),
                a: this.readUInt8(),
              };
            }
            console.log(`DFFLoader: Read ${data.numVertices} vertex colors`);
          }

          if (data.format & (GeometryFlag.rwTEXTURED | GeometryFlag.rwTEXTURED2)) {
            data.texCoords = new Array(numUVs);
            for (let i = 0; i < numUVs; i += 1) {
              data.texCoords[i] = new Array(data.numVertices);
              for (let j = 0; j < data.numVertices; j += 1) {
                data.texCoords[i][j] = {
                  u: this.readFloat32(),
                  v: this.readFloat32(),
                };
              }
            }
            console.log(`DFFLoader: Read ${numUVs} UV sets`);
          }

          data.triangles = new Array(data.numTriangles);
          const materialIdSet = new Set();
          for (let i = 0; i < data.numTriangles; i += 1) {
            const v0 = this.readUInt16();
            const v1 = this.readUInt16();
            const v2 = this.readUInt16();
            const v3 = this.readUInt16();
            if (i < 5) {
              console.log(`Triangle ${i} raw: [${v0}, ${v1}, ${v2}, ${v3}]`);
            }
            data.triangles[i] = {
              vertex2: v0,
              vertex1: v1,
              materialId: v2,
              vertex3: v3,
            };
            materialIdSet.add(v2);
          }
          console.log('DFFLoader: Read ' + data.numTriangles + ' triangles, unique materialIds:', [...materialIdSet]);
        }

        data.morphTargets = new Array(data.numMorphTargets);
        for (let i = 0; i < data.numMorphTargets; i += 1) {
          data.morphTargets[i] = {
            boundingSphere: {
              x: this.readFloat32(),
              y: this.readFloat32(),
              z: this.readFloat32(),
              radius: this.readFloat32(),
            },
            hasVertices: 0,
            hasNormals: 0,
          };

          if (!isNative) {
            data.morphTargets[i].hasVertices = this.readUInt32();
            data.morphTargets[i].hasNormals = this.readUInt32();

            if (data.morphTargets[i].hasVertices) {
              data.morphTargets[i].vertices = new Array(data.numVertices);
              for (let j = 0; j < data.numVertices; j += 1) {
                data.morphTargets[i].vertices[j] = {
                  x: this.readFloat32(),
                  y: this.readFloat32(),
                  z: this.readFloat32(),
                };
              }
            }

            if (data.morphTargets[i].hasNormals) {
              data.morphTargets[i].normals = new Array(data.numVertices);
              for (let j = 0; j < data.numVertices; j += 1) {
                data.morphTargets[i].normals[j] = {
                  x: this.readFloat32(),
                  y: this.readFloat32(),
                  z: this.readFloat32(),
                };
              }
            }
          }
        }

        console.log(`DFFLoader: Read ${data.numMorphTargets} morph targets, position now: ${this.position}`);
        data.RWMaterialList = this.readChunk(ChunkType.CHUNK_MATERIALLIST);
        this.readExtension(data);
        break;
      }

      case ChunkType.CHUNK_MATERIALLIST: {
        this.readHeader();
        const numMaterials = this.readUInt32();
        data = new Array(numMaterials);
        for (let i = 0; i < numMaterials; i += 1) data[i] = { id: this.readUInt32() };
        for (let i = 0; i < numMaterials; i += 1) data[i].RWMaterial = this.readChunk(ChunkType.CHUNK_MATERIAL);
        break;
      }

      case ChunkType.CHUNK_MATERIAL: {
        const header = this.readHeader();
        data = {
          flags: this.readUInt32(),
          color: {
            r: this.readUInt8(),
            g: this.readUInt8(),
            b: this.readUInt8(),
            a: this.readUInt8(),
          },
        };
        this.readUInt32();
        data.isTextured = this.readUInt32();
        if (header.version > 0x30400) {
          data.ambient = this.readFloat32();
          data.specular = this.readFloat32();
          data.diffuse = this.readFloat32();
        }
        if (data.isTextured) data.RWTexture = this.readChunk(ChunkType.CHUNK_TEXTURE);
        this.readExtension(data);
        break;
      }

      case ChunkType.CHUNK_TEXTURE: {
        this.readHeader();
        data = { filterFlags: this.readUInt16() };
        this.readUInt16();
        data.name = this.readChunk(ChunkType.CHUNK_STRING);
        data.maskName = this.readChunk(ChunkType.CHUNK_STRING);
        this.readExtension(data);
        break;
      }

      case ChunkType.CHUNK_STRING:
        data = this.readString(chunkHeader.length);
        break;

      case ChunkType.CHUNK_ATOMIC: {
        this.readHeader();
        data = {
          frameIndex: this.readUInt32(),
          geometryIndex: this.readUInt32(),
          flags: this.readUInt32(),
        };
        this.readUInt32();
        this.readExtension(data);
        break;
      }

      case ChunkType.CHUNK_EXTENSION: {
        data = {};
        const chunkEnd = this.position + chunkHeader.length;

        while (this.position < chunkEnd) {
          const header = this.readHeader();
          const extStart = this.position;
          let extension = {};

          switch (header.type) {
            case ChunkType.CHUNK_HANIM:
              extension = {
                hAnimVersion: this.readUInt32(),
                nodeId: this.readUInt32(),
                numNodes: this.readUInt32(),
              };
              if (extension.numNodes) {
                extension.flags = this.readUInt32();
                extension.keyFrameSize = this.readUInt32();
                extension.nodes = new Array(extension.numNodes);
                for (let i = 0; i < extension.numNodes; i += 1) {
                  extension.nodes[i] = {
                    nodeId: this.readUInt32(),
                    nodeIndex: this.readUInt32(),
                    flags: this.readUInt32(),
                  };
                }
              }
              break;

            case ChunkType.CHUNK_FRAME:
              extension = this.readString(header.length);
              break;

            case ChunkType.CHUNK_BINMESH: {
              extension = {
                faceType: this.readUInt32(),
              };
              const numSplits = this.readUInt32();
              extension.numIndices = this.readUInt32();
              extension.splits = new Array(numSplits);
              const hasData = header.length > 12 + numSplits * 8;
              for (let i = 0; i < numSplits; i += 1) {
                const numIndices = this.readUInt32();
                extension.splits[i] = { numIndices, matIndex: this.readUInt32() };
                if (hasData) {
                  extension.splits[i].indices = new Array(numIndices);
                  for (let j = 0; j < numIndices; j += 1) {
                    extension.splits[i].indices[j] = this.readUInt32();
                  }
                }
              }
              break;
            }

            case ChunkType.CHUNK_SKIN: {
              extension = {
                numBones: this.readUInt8(),
                numUsedBones: this.readUInt8(),
                maxWeightsPerVertex: this.readUInt8(),
                padding: this.readUInt8(),
              };
              extension.bonesUsed = new Array(extension.numUsedBones);
              for (let i = 0; i < extension.numUsedBones; i += 1) {
                extension.bonesUsed[i] = this.readUInt8();
              }
              const numVertices = chunkHeader.parent.numVertices;
              extension.vertexBoneIndices = new Array(numVertices);
              for (let i = 0; i < numVertices; i += 1) {
                extension.vertexBoneIndices[i] = {
                  x: this.readUInt8(),
                  y: this.readUInt8(),
                  z: this.readUInt8(),
                  w: this.readUInt8(),
                };
              }
              extension.vertexBoneWeights = new Array(numVertices);
              for (let i = 0; i < numVertices; i += 1) {
                extension.vertexBoneWeights[i] = {
                  x: this.readFloat32(),
                  y: this.readFloat32(),
                  z: this.readFloat32(),
                  w: this.readFloat32(),
                };
              }
              extension.skinToBoneMatrix = new Array(extension.numBones);
              for (let i = 0; i < extension.numBones; i += 1) {
                if (extension.numUsedBones === 0) this.position += 4;
                extension.skinToBoneMatrix[i] = [];
                for (let j = 0; j < 16; j += 1) {
                  extension.skinToBoneMatrix[i][j] = this.readFloat32();
                }
              }
              if (extension.numUsedBones !== 0) this.position += 0x0C;
              break;
            }

            case ChunkType.CHUNK_MESHEXTENSION: {
              const magicNumber = this.readUInt32();
              if (magicNumber !== 0) {
                console.warn('DFFLoader: MESHEXTENSION not fully implemented');
                this.position = extStart + header.length;
              }
              break;
            }

            default:
              this.position += header.length;
              break;
          }

          if (this.position < extStart + header.length) {
            console.warn(`DFFLoader: Extension ${header.name} not read to end`);
            this.position = extStart + header.length;
          }

          if (data[header.name]) console.warn(`DFFLoader: Duplicate extension ${header.name}`);
          data[header.name] = extension;
        }
        break;
      }

      default:
        console.warn(`DFFLoader: Unknown chunk type ${chunkHeader.name}`);
        break;
    }

    return data;
  }

  readExtension(chunk) {
    chunk.RWExtension = this.readChunk(ChunkType.CHUNK_EXTENSION, chunk);
  }
}

export default DFFReader;
