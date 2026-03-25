import * as THREE from 'three';
import {
  createCameraRuntimeSnapshot,
  projectPointToCameraViewport,
} from '../../core/camera/CameraRuntime.js';

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

const BOX_OCCLUSION_TEST_CORNER_INDICES = [0, 3, 5, 6];
const BOX_CENTER = new THREE.Vector3();

const SCREEN_RECT_EPSILON = 0.015;
const DEPTH_EPSILON = 4.0;
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

function projectPointToViewport(camera, point) {
  if (!point?.isVector3) return null;
  const cameraRuntime = camera?.tanHalfFovX ? camera : createCameraRuntimeSnapshot(camera);
  return projectPointToCameraViewport(cameraRuntime, point);
}

function getChunkOcclusionBox(chunk) {
  if (chunk?.occlusionBox?.isBox3) return chunk.occlusionBox;
  if (chunk?.boundingBox?.isBox3) return chunk.boundingBox;
  return null;
}

function projectBoxOcclusionData(camera, box) {
  if (!box?.isBox3) return null;
  const corners = fillBoxCorners(box);
  const center = box.getCenter(BOX_CENTER);
  const centerProjection = projectPointToViewport(camera, center);
  if (!centerProjection) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minDepth = Number.POSITIVE_INFINITY;
  let maxDepth = Number.NEGATIVE_INFINITY;
  let projectedCount = 0;
  const testPoints = [];

  for (let index = 0; index < corners.length; index += 1) {
    const projection = projectPointToViewport(camera, corners[index]);
    if (BOX_OCCLUSION_TEST_CORNER_INDICES.includes(index)) {
      testPoints.push(projection);
    }
    if (!projection) continue;
    minX = Math.min(minX, projection.x);
    minY = Math.min(minY, projection.y);
    maxX = Math.max(maxX, projection.x);
    maxY = Math.max(maxY, projection.y);
    minDepth = Math.min(minDepth, projection.depth);
    maxDepth = Math.max(maxDepth, projection.depth);
    projectedCount += 1;
  }

  if (projectedCount === 0) return null;
  return {
    center: centerProjection,
    testPoints,
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

function canRegisterOccluder(data) {
  if (!data?.center) return false;
  if (data.center.x < 0 || data.center.y < 0 || data.center.x > 1 || data.center.y > 1) return false;
  if (data.minX < 0 || data.minY < 0 || data.maxX > 1 || data.maxY > 1) return false;
  if (!Number.isFinite(data.minDepth) || !Number.isFinite(data.maxDepth) || data.maxDepth <= 0) return false;
  if (data.width < MIN_OCCLUDER_WIDTH || data.height < MIN_OCCLUDER_HEIGHT) return false;
  if ((data.width * data.height) < MIN_OCCLUDER_AREA) return false;
  return true;
}

function isPointWithinRect(point, rect, epsilon = 0) {
  if (!point || !rect) return false;
  return (
    point.x >= (rect.minX - epsilon)
    && point.x <= (rect.maxX + epsilon)
    && point.y >= (rect.minY - epsilon)
    && point.y <= (rect.maxY + epsilon)
  );
}

export function registerChunkOccluder(state, camera, chunk) {
  const box = getChunkOcclusionBox(chunk);
  if (!state || !box) return null;
  const data = projectBoxOcclusionData(camera, box);
  if (!canRegisterOccluder(data)) return null;
  state.occluders.push(data);
  return data;
}

export function isChunkOccluded(state, camera, chunk) {
  const box = getChunkOcclusionBox(chunk);
  if (!state || state.occluders.length === 0 || !box) return false;
  const data = projectBoxOcclusionData(camera, box);
  if (!data?.center) return false;
  for (const occluder of state.occluders) {
    if (!isPointWithinRect(data.center, occluder, SCREEN_RECT_EPSILON)) continue;
    if (data.center.depth <= (occluder.maxDepth + DEPTH_EPSILON)) continue;
    let allTestPointsInside = true;
    let testedPointCount = 0;
    for (const point of data.testPoints) {
      if (!point) continue;
      testedPointCount += 1;
      if (!isPointWithinRect(point, occluder, 0)) {
        allTestPointsInside = false;
        break;
      }
    }
    if (testedPointCount === 0 || !allTestPointsInside) continue;
    return true;
  }
  return false;
}
