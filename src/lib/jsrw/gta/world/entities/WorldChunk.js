import { createPlacementEntity } from './PlacementEntity.js';

export function createWorldChunk(key, x, y) {
  return {
    key,
    x,
    y,
    placementIndices: [],
    placementCount: 0,
  };
}

export function buildWorldChunkGraph(placements = [], chunkSize = 256) {
  const chunks = new Map();

  for (let index = 0; index < placements.length; index += 1) {
    const entity = createPlacementEntity(placements[index], index);
    const cx = Math.floor(entity.position.x / chunkSize);
    const cy = Math.floor(entity.position.y / chunkSize);
    const key = `${cx},${cy}`;
    let chunk = chunks.get(key);
    if (!chunk) {
      chunk = createWorldChunk(key, cx, cy);
      chunks.set(key, chunk);
    }
    chunk.placementIndices.push(entity.index);
    chunk.placementCount += 1;
  }

  return Array.from(chunks.values()).sort((a, b) => a.key.localeCompare(b.key));
}
