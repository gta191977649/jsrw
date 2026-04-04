import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { gtaPlacementQuaternionToThree } from '../src/lib/jsrw/utils/gtaTransforms.js';

const GTA_TO_THREE_QUATERNION = new THREE.Quaternion()
  .setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.PI, 'XYZ'));

function assertQuaternionClose(actual, expected, epsilon = 1e-6) {
  const dot = Math.abs(actual.dot(expected));
  assert.ok(1 - dot <= epsilon, `expected ${actual.toArray()} ~= ${expected.toArray()}`);
}

test('gtaPlacementQuaternionToThree matches librw/euryopa conjugated IPL rotation', () => {
  const halfAngle = Math.PI / 4;
  const gtaQuaternion = new THREE.Quaternion(0, 0, Math.sin(halfAngle), Math.cos(halfAngle));

  const actual = gtaPlacementQuaternionToThree(
    gtaQuaternion.x,
    gtaQuaternion.y,
    gtaQuaternion.z,
    gtaQuaternion.w,
  );

  const expected = GTA_TO_THREE_QUATERNION.clone()
    .multiply(gtaQuaternion.clone().conjugate())
    .multiply(GTA_TO_THREE_QUATERNION.clone().invert())
    .normalize();

  assertQuaternionClose(actual, expected);
});

test('gtaPlacementQuaternionToThree preserves WXYZ source ordering before applying librw conjugation', () => {
  const gtaQuaternion = new THREE.Quaternion(0.25, -0.5, 0.125, 0.75).normalize();

  const actual = gtaPlacementQuaternionToThree(
    gtaQuaternion.w,
    gtaQuaternion.x,
    gtaQuaternion.y,
    gtaQuaternion.z,
    'WXYZ',
  );

  const expected = GTA_TO_THREE_QUATERNION.clone()
    .multiply(gtaQuaternion.clone().conjugate())
    .multiply(GTA_TO_THREE_QUATERNION.clone().invert())
    .normalize();

  assertQuaternionClose(actual, expected);
});
