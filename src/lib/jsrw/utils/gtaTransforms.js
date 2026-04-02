import * as THREE from 'three';

const GTA_TO_THREE_QUATERNION = new THREE.Quaternion()
  .setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.PI, 'XYZ'));
const THREE_TO_GTA_QUATERNION = GTA_TO_THREE_QUATERNION.clone().invert();

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
  const gtaQuaternion = new THREE.Quaternion(nx, ny, nz, nw);
  return GTA_TO_THREE_QUATERNION.clone()
    .multiply(gtaQuaternion)
    .multiply(THREE_TO_GTA_QUATERNION)
    .normalize();
}

export function gtaPositionToThree(x, y, z) {
  return new THREE.Vector3(x, y, z).applyQuaternion(GTA_TO_THREE_QUATERNION);
}
