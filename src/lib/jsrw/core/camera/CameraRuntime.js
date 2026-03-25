function toFiniteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizePlane2D(x, y) {
  const length = Math.hypot(x, y) || 1;
  return [x / length, y / length];
}

function copyVector3Like(source, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(source?.x, fallback.x),
    y: toFiniteNumber(source?.y, fallback.y),
    z: toFiniteNumber(source?.z, fallback.z),
  };
}

function transformWorldPointToCameraSpace(snapshot, point) {
  const dx = toFiniteNumber(point?.x) - snapshot.position.x;
  const dy = toFiniteNumber(point?.y) - snapshot.position.y;
  const dz = toFiniteNumber(point?.z) - snapshot.position.z;
  return {
    x: (dx * snapshot.right.x) + (dy * snapshot.right.y) + (dz * snapshot.right.z),
    y: (dx * snapshot.forward.x) + (dy * snapshot.forward.y) + (dz * snapshot.forward.z),
    z: (dx * snapshot.up.x) + (dy * snapshot.up.y) + (dz * snapshot.up.z),
  };
}

export function createCameraRuntimeSnapshot(camera) {
  const matrix = camera?.matrixWorld?.elements;
  const aspect = Math.max(1e-6, Number(camera?.aspect) || 1);
  const fovRadians = ((Number(camera?.fov) || 60) * Math.PI) / 180;
  const tanHalfFovY = Math.tan(fovRadians * 0.5);
  const tanHalfFovX = tanHalfFovY * aspect;
  const leftPlane = normalizePlane2D(1, -tanHalfFovX);
  const rightPlane = normalizePlane2D(-1, -tanHalfFovX);
  const topPlane = normalizePlane2D(1, -tanHalfFovY);
  const bottomPlane = normalizePlane2D(-1, -tanHalfFovY);

  return {
    position: copyVector3Like(camera?.position),
    right: matrix
      ? { x: matrix[0], y: matrix[1], z: matrix[2] }
      : { x: 1, y: 0, z: 0 },
    up: matrix
      ? { x: matrix[4], y: matrix[5], z: matrix[6] }
      : { x: 0, y: 1, z: 0 },
    forward: matrix
      ? { x: -matrix[8], y: -matrix[9], z: -matrix[10] }
      : { x: 0, y: 0, z: -1 },
    near: Math.max(0.001, Number(camera?.near) || 0.1),
    far: Math.max(1, Number(camera?.far) || 60000),
    tanHalfFovX,
    tanHalfFovY,
    horizontalPlaneNormals: {
      left: { x: leftPlane[0], y: leftPlane[1] },
      right: { x: rightPlane[0], y: rightPlane[1] },
    },
    verticalPlaneNormals: {
      top: { x: topPlane[0], y: topPlane[1] },
      bottom: { x: bottomPlane[0], y: bottomPlane[1] },
    },
  };
}

export function isSphereVisibleInCameraRuntime(snapshot, center, radius = 0) {
  if (!snapshot || !center) return false;
  const point = transformWorldPointToCameraSpace(snapshot, center);
  const safeRadius = Math.max(0, Number(radius) || 0);
  if (point.y + safeRadius < snapshot.near) return false;
  if (point.y - safeRadius > snapshot.far) return false;
  const left = snapshot.horizontalPlaneNormals.left;
  if ((point.x * left.x) + (point.y * left.y) > safeRadius) return false;
  const right = snapshot.horizontalPlaneNormals.right;
  if ((point.x * right.x) + (point.y * right.y) > safeRadius) return false;
  const top = snapshot.verticalPlaneNormals.top;
  if ((point.z * top.x) + (point.y * top.y) > safeRadius) return false;
  const bottom = snapshot.verticalPlaneNormals.bottom;
  if ((point.z * bottom.x) + (point.y * bottom.y) > safeRadius) return false;
  return true;
}

export function isPointVisibleInCameraRuntime(snapshot, point) {
  return isSphereVisibleInCameraRuntime(snapshot, point, 0);
}

export function isBoxVisibleInCameraRuntime(snapshot, box) {
  if (!snapshot || !box?.min || !box?.max) return false;
  const center = {
    x: (toFiniteNumber(box.min.x) + toFiniteNumber(box.max.x)) * 0.5,
    y: (toFiniteNumber(box.min.y) + toFiniteNumber(box.max.y)) * 0.5,
    z: (toFiniteNumber(box.min.z) + toFiniteNumber(box.max.z)) * 0.5,
  };
  if (isPointVisibleInCameraRuntime(snapshot, center)) return true;

  const corners = [
    { x: box.min.x, y: box.min.y, z: box.min.z },
    { x: box.max.x, y: box.min.y, z: box.min.z },
    { x: box.min.x, y: box.max.y, z: box.min.z },
    { x: box.max.x, y: box.max.y, z: box.min.z },
    { x: box.min.x, y: box.min.y, z: box.max.z },
    { x: box.max.x, y: box.min.y, z: box.max.z },
    { x: box.min.x, y: box.max.y, z: box.max.z },
    { x: box.max.x, y: box.max.y, z: box.max.z },
  ];
  const outsideCounts = [0, 0, 0, 0, 0, 0];
  const left = snapshot.horizontalPlaneNormals.left;
  const right = snapshot.horizontalPlaneNormals.right;

  for (const corner of corners) {
    const point = transformWorldPointToCameraSpace(snapshot, corner);
    if (point.y < snapshot.near) outsideCounts[0] += 1;
    if (point.y > snapshot.far) outsideCounts[1] += 1;
    if ((point.x * left.x) + (point.y * left.y) > 0) outsideCounts[2] += 1;
    if ((point.x * right.x) + (point.y * right.y) > 0) outsideCounts[3] += 1;
    const top = snapshot.verticalPlaneNormals.top;
    if ((point.z * top.x) + (point.y * top.y) > 0) outsideCounts[4] += 1;
    const bottom = snapshot.verticalPlaneNormals.bottom;
    if ((point.z * bottom.x) + (point.y * bottom.y) > 0) outsideCounts[5] += 1;
  }

  return outsideCounts.every((count) => count < corners.length);
}

export function projectPointToCameraViewport(snapshot, point) {
  if (!snapshot || !point) return null;
  const cameraPoint = transformWorldPointToCameraSpace(snapshot, point);
  if (!Number.isFinite(cameraPoint.y) || cameraPoint.y <= 1e-6) return null;
  const ndcX = cameraPoint.x / (cameraPoint.y * snapshot.tanHalfFovX);
  const ndcY = cameraPoint.z / (cameraPoint.y * snapshot.tanHalfFovY);
  if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return null;
  return {
    ndcX,
    ndcY,
    depth: cameraPoint.y,
    x: (ndcX * 0.5) + 0.5,
    y: (ndcY * -0.5) + 0.5,
  };
}

export function getCameraForwardPlanarWeight(snapshot, point) {
  if (!snapshot || !point) return 0;
  const dx = toFiniteNumber(point.x) - snapshot.position.x;
  const dz = toFiniteNumber(point.z) - snapshot.position.z;
  return (dx * snapshot.forward.x) + (dz * snapshot.forward.z);
}

export default createCameraRuntimeSnapshot;
