import * as THREE from 'three';

const WATERPRO_LEVEL_COUNT = 48;
const WATERPRO_BLOCK_SIZE = 64 * 64;
const WATERPRO_FINE_BLOCK_SIZE = 128 * 128;

export function getWaterConfig(gameVersion = 'VCS') {
  const version = String(gameVersion || '').toUpperCase();
  switch (version) {
    case 'III':
      return {
        gameVersion: 'III',
        source: 'waterpro',
        textureName: 'water_old',
        bounds: {
          start: { x: -2048, y: -2048 },
          end: { x: 2048, y: 2048 },
        },
      };
    case 'VC':
      return {
        gameVersion: 'VC',
        source: 'waterpro',
        textureName: 'waterclear256',
        bounds: {
          start: { x: -2448, y: -2048 },
          end: { x: 1648, y: 2048 },
        },
      };
    case 'SA':
      return {
        gameVersion: 'SA',
        source: 'waterdat',
        textureName: 'waterclear256',
        bounds: null,
      };
    case 'LCS':
      return {
        gameVersion: 'LCS',
        source: 'waterpro',
        textureName: 'waterclear256',
        bounds: {
          start: { x: -2048, y: -2048 },
          end: { x: 2048, y: 2048 },
        },
      };
    case 'VCS':
    default:
      return {
        gameVersion: 'VCS',
        source: 'waterpro',
        textureName: 'waterclear256',
        bounds: {
          start: { x: -2448, y: -2048 },
          end: { x: 1648, y: 2048 },
        },
      };
  }
}

export function parseWaterproDat(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new Error('waterpro.dat parser expects an ArrayBuffer');
  }

  const expectedMinSize = 4
    + (WATERPRO_LEVEL_COUNT * 4)
    + (WATERPRO_LEVEL_COUNT * 16)
    + WATERPRO_BLOCK_SIZE
    + WATERPRO_FINE_BLOCK_SIZE;
  if (arrayBuffer.byteLength < expectedMinSize) {
    throw new Error(`waterpro.dat too small: ${arrayBuffer.byteLength} bytes`);
  }

  const view = new DataView(arrayBuffer);
  let offset = 0;

  const readInt32 = () => {
    const value = view.getInt32(offset, true);
    offset += 4;
    return value;
  };
  const readFloat32 = () => {
    const value = view.getFloat32(offset, true);
    offset += 4;
    return value;
  };

  const levelCount = readInt32();
  const waterZs = new Float32Array(WATERPRO_LEVEL_COUNT);
  for (let i = 0; i < WATERPRO_LEVEL_COUNT; i += 1) waterZs[i] = readFloat32();

  const waterRects = new Array(WATERPRO_LEVEL_COUNT);
  for (let i = 0; i < WATERPRO_LEVEL_COUNT; i += 1) {
    waterRects[i] = {
      left: readFloat32(),
      bottom: readFloat32(),
      right: readFloat32(),
      top: readFloat32(),
    };
  }

  const blockList = new Uint8Array(arrayBuffer, offset, WATERPRO_BLOCK_SIZE).slice();
  offset += WATERPRO_BLOCK_SIZE;
  const fineBlockList = new Uint8Array(arrayBuffer, offset, WATERPRO_FINE_BLOCK_SIZE).slice();

  return {
    levelCount,
    waterZs,
    waterRects,
    blockList,
    fineBlockList,
  };
}

export function getWaterLevelIndex(cell) {
  const value = Number(cell) & 0xFF;
  if ((value & 0x80) !== 0) return -1;
  return value & 0x7F;
}

function buildWaterGridGeometry(data, waterLevels, bounds, cellCount, toThreePosition, uvScale, writePosition) {
  const start = bounds.start;
  const end = bounds.end;
  const cellSizeX = (end.x - start.x) / cellCount;
  const cellSizeY = (end.y - start.y) / cellCount;

  let cellTotal = 0;
  for (let x = 0; x < cellCount; x += 1) {
    for (let y = 0; y < cellCount; y += 1) {
      const levelIndex = getWaterLevelIndex(data[(x * cellCount) + y]);
      if (levelIndex < 0 || levelIndex >= waterLevels.length) continue;
      const waterZ = waterLevels[levelIndex];
      if (!Number.isFinite(waterZ)) continue;
      cellTotal += 1;
    }
  }

  const positions = new Float32Array(cellTotal * 18);
  const uvs = new Float32Array(cellTotal * 12);

  let positionOffset = 0;
  let uvOffset = 0;
  for (let x = 0; x < cellCount; x += 1) {
    for (let y = 0; y < cellCount; y += 1) {
      const levelIndex = getWaterLevelIndex(data[(x * cellCount) + y]);
      if (levelIndex < 0 || levelIndex >= waterLevels.length) continue;

      const waterZ = waterLevels[levelIndex];
      if (!Number.isFinite(waterZ)) continue;

      const x0 = start.x + (x * cellSizeX);
      const x1 = x0 + cellSizeX;
      const y0 = start.y + (y * cellSizeY);
      const y1 = y0 + cellSizeY;

      if (typeof writePosition === 'function') {
        writePosition(positions, positionOffset + 0, x0, y0, waterZ);
        writePosition(positions, positionOffset + 3, x1, y0, waterZ);
        writePosition(positions, positionOffset + 6, x1, y1, waterZ);
        writePosition(positions, positionOffset + 9, x0, y0, waterZ);
        writePosition(positions, positionOffset + 12, x1, y1, waterZ);
        writePosition(positions, positionOffset + 15, x0, y1, waterZ);
      } else {
        const p0 = toThreePosition(x0, y0, waterZ);
        const p1 = toThreePosition(x1, y0, waterZ);
        const p2 = toThreePosition(x1, y1, waterZ);
        const p3 = toThreePosition(x0, y1, waterZ);
        positions[positionOffset + 0] = p0.x;
        positions[positionOffset + 1] = p0.y;
        positions[positionOffset + 2] = p0.z;
        positions[positionOffset + 3] = p1.x;
        positions[positionOffset + 4] = p1.y;
        positions[positionOffset + 5] = p1.z;
        positions[positionOffset + 6] = p2.x;
        positions[positionOffset + 7] = p2.y;
        positions[positionOffset + 8] = p2.z;
        positions[positionOffset + 9] = p0.x;
        positions[positionOffset + 10] = p0.y;
        positions[positionOffset + 11] = p0.z;
        positions[positionOffset + 12] = p2.x;
        positions[positionOffset + 13] = p2.y;
        positions[positionOffset + 14] = p2.z;
        positions[positionOffset + 15] = p3.x;
        positions[positionOffset + 16] = p3.y;
        positions[positionOffset + 17] = p3.z;
      }
      positionOffset += 18;

      uvs[uvOffset + 0] = x0 * uvScale;
      uvs[uvOffset + 1] = y0 * uvScale;
      uvs[uvOffset + 2] = x1 * uvScale;
      uvs[uvOffset + 3] = y0 * uvScale;
      uvs[uvOffset + 4] = x1 * uvScale;
      uvs[uvOffset + 5] = y1 * uvScale;
      uvs[uvOffset + 6] = x0 * uvScale;
      uvs[uvOffset + 7] = y0 * uvScale;
      uvs[uvOffset + 8] = x1 * uvScale;
      uvs[uvOffset + 9] = y1 * uvScale;
      uvs[uvOffset + 10] = x0 * uvScale;
      uvs[uvOffset + 11] = y1 * uvScale;
      uvOffset += 12;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

export function buildWaterFineGeometry(parsed, options = {}) {
  const waterConfig = options.waterConfig || getWaterConfig(options.gameVersion);
  const bounds = options.bounds || waterConfig.bounds;
  if (!bounds) {
    throw new Error('waterpro bounds are missing for this game version');
  }
  const toThreePosition = typeof options.toThreePosition === 'function'
    ? options.toThreePosition
    : ((x, y, z) => new THREE.Vector3(x, z, -y));
  const writePosition = typeof options.writePosition === 'function' ? options.writePosition : null;
  const uvScale = Number.isFinite(options.uvScale) ? options.uvScale : (1 / 32);
  return buildWaterGridGeometry(parsed.fineBlockList, parsed.waterZs, bounds, 128, toThreePosition, uvScale, writePosition);
}

export function buildWaterBlockGeometry(parsed, options = {}) {
  const waterConfig = options.waterConfig || getWaterConfig(options.gameVersion);
  const bounds = options.bounds || waterConfig.bounds;
  if (!bounds) {
    throw new Error('waterpro bounds are missing for this game version');
  }
  const toThreePosition = typeof options.toThreePosition === 'function'
    ? options.toThreePosition
    : ((x, y, z) => new THREE.Vector3(x, z, -y));
  const writePosition = typeof options.writePosition === 'function' ? options.writePosition : null;
  const uvScale = Number.isFinite(options.uvScale) ? options.uvScale : (1 / 32);
  return buildWaterGridGeometry(parsed.blockList, parsed.waterZs, bounds, 64, toThreePosition, uvScale, writePosition);
}

export const buildWaterproGeometry = buildWaterFineGeometry;
