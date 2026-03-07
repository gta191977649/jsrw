import * as THREE from 'three';

const GTA_TO_THREE_QUATERNION = new THREE.Quaternion()
  .setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.PI, 'XYZ'));
const GTA_TO_THREE_BASIS = new THREE.Matrix4().makeRotationFromQuaternion(GTA_TO_THREE_QUATERNION);
const THREE_TO_GTA_BASIS = GTA_TO_THREE_BASIS.clone().invert();

export const WORLD_UP = new THREE.Vector3(0, 1, 0);

export function gtaPlacementQuaternionToThree(x, y, z, w, order = 'XYZW') {
  const qx = order === 'WXYZ' ? y : x;
  const qy = order === 'WXYZ' ? z : y;
  const qz = order === 'WXYZ' ? w : z;
  const qw = order === 'WXYZ' ? x : w;
  const lenSq = (qx * qx) + (qy * qy) + (qz * qz) + (qw * qw);
  if (lenSq === 0) return new THREE.Quaternion();

  const invLen = 1 / Math.sqrt(lenSq);
  const nx = qx * invLen;
  const ny = qy * invLen;
  const nz = qz * invLen;
  const nw = qw * invLen;

  const x2 = nx * nx;
  const y2 = ny * ny;
  const z2 = nz * nz;
  const xy = nx * ny;
  const xz = nx * nz;
  const yz = ny * nz;
  const wx = nw * nx;
  const wy = nw * ny;
  const wz = nw * nz;

  // Match mapviewer TransformItem() exactly (OpenGL column-major source matrix).
  const gtaRotation = new THREE.Matrix4().set(
    1 - 2 * (y2 + z2), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (x2 + z2), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (x2 + y2), 0,
    0, 0, 0, 1,
  );
  const threeRotation = GTA_TO_THREE_BASIS.clone().multiply(gtaRotation).multiply(THREE_TO_GTA_BASIS);
  return new THREE.Quaternion().setFromRotationMatrix(threeRotation).normalize();
}

export function gtaPositionToThree(x, y, z) {
  return new THREE.Vector3(x, y, z).applyQuaternion(GTA_TO_THREE_QUATERNION);
}
