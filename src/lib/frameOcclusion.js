import * as THREE from 'three';

const BOX_CORNERS = [
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
];

const SCREEN_RECT_EPSILON = 0.015;
const DEPTH_EPSILON = 0.02;
const MIN_OCCLUDER_WIDTH = 0.14;
const MIN_OCCLUDER_HEIGHT = 0.14;
const MIN_OCCLUDER_AREA = 0.03;

export function createChunkOcclusionState() {
  return {
    occluders: [],
  };
}

export function resetChunkOcclusionState(state = createChunkOcclusionState()) {
  state.occluders.length = 0;
  return state;
}

function fillBoxCorners(box) {
  const { min, max } = box;
  BOX_CORNERS[0].set(min.x, min.y, min.z);
  BOX_CORNERS[1].set(max.x, min.y, min.z);
  BOX_CORNERS[2].set(min.x, max.y, min.z);
  BOX_CORNERS[3].set(max.x, max.y, min.z);
  BOX_CORNERS[4].set(min.x, min.y, max.z);
  BOX_CORNERS[5].set(max.x, min.y, max.z);
  BOX_CORNERS[6].set(min.x, max.y, max.z);
  BOX_CORNERS[7].set(max.x, max.y, max.z);
  return BOX_CORNERS;
}

function projectBoxToScreenRect(camera, box) {
  if (!camera?.projectionMatrix || !camera?.matrixWorldInverse || !box?.isBox3) return null;
  const corners = fillBoxCorners(box);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minDepth = Number.POSITIVE_INFINITY;
  let maxDepth = Number.NEGATIVE_INFINITY;
  let projectedCount = 0;

  for (const corner of corners) {
    const ndc = corner.clone().project(camera);
    if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)) continue;
    minX = Math.min(minX, (ndc.x * 0.5) + 0.5);
    minY = Math.min(minY, (ndc.y * -0.5) + 0.5);
    maxX = Math.max(maxX, (ndc.x * 0.5) + 0.5);
    maxY = Math.max(maxY, (ndc.y * -0.5) + 0.5);
    minDepth = Math.min(minDepth, ndc.z);
    maxDepth = Math.max(maxDepth, ndc.z);
    projectedCount += 1;
  }

  if (projectedCount === 0) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    minDepth,
    maxDepth,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

function canRegisterOccluder(rect) {
  if (!rect) return false;
  if (rect.minX < 0 || rect.minY < 0 || rect.maxX > 1 || rect.maxY > 1) return false;
  if (rect.minDepth < -1 || rect.maxDepth > 1) return false;
  if (rect.width < MIN_OCCLUDER_WIDTH || rect.height < MIN_OCCLUDER_HEIGHT) return false;
  if ((rect.width * rect.height) < MIN_OCCLUDER_AREA) return false;
  return true;
}

export function registerChunkOccluder(state, camera, chunk) {
  if (!state || !chunk?.boundingBox?.isBox3) return null;
  const rect = projectBoxToScreenRect(camera, chunk.boundingBox);
  if (!canRegisterOccluder(rect)) return null;
  state.occluders.push(rect);
  return rect;
}

export function isChunkOccluded(state, camera, chunk) {
  if (!state || state.occluders.length === 0 || !chunk?.boundingBox?.isBox3) return false;
  const rect = projectBoxToScreenRect(camera, chunk.boundingBox);
  if (!rect) return false;
  for (const occluder of state.occluders) {
    const insideRect = (
      rect.minX >= (occluder.minX - SCREEN_RECT_EPSILON)
      && rect.maxX <= (occluder.maxX + SCREEN_RECT_EPSILON)
      && rect.minY >= (occluder.minY - SCREEN_RECT_EPSILON)
      && rect.maxY <= (occluder.maxY + SCREEN_RECT_EPSILON)
    );
    if (!insideRect) continue;
    if (rect.minDepth <= (occluder.maxDepth + DEPTH_EPSILON)) continue;
    return true;
  }
  return false;
}
