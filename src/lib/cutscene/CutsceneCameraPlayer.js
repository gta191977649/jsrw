import * as THREE from 'three';
import { gtaPositionToThree } from '../jsrw/utils/gtaTransforms.js';

const TMP_SOURCE = new THREE.Vector3();
const TMP_TARGET = new THREE.Vector3();
const TMP_FORWARD = new THREE.Vector3();
const TMP_RIGHT = new THREE.Vector3();
const TMP_UP = new THREE.Vector3();
const TMP_FALLBACK_UP = new THREE.Vector3(0, 1, 0);
const TMP_ALT_UP = new THREE.Vector3(0, 0, 1);
const TMP_ROLL_QUAT = new THREE.Quaternion();
const TMP_BASIS = new THREE.Matrix4();
const TMP_BEZIER_A = new THREE.Vector3();
const TMP_BEZIER_B = new THREE.Vector3();
const TMP_BEZIER_C = new THREE.Vector3();
const MIN_SPLINE_DELTA_SECONDS = 0.075;

function rwHorizontalFovToThreeVertical(horizontalFovDegrees, aspect) {
  const safeAspect = Math.max(1e-6, Number(aspect) || 1);
  const horizontalRadians = THREE.MathUtils.degToRad(Number(horizontalFovDegrees) || 0);
  const verticalRadians = 2 * Math.atan(Math.tan(horizontalRadians * 0.5) / safeAspect);
  return THREE.MathUtils.radToDeg(verticalRadians);
}

function cubicBezierScalar(p0, p1, p2, p3, alpha) {
  const a = THREE.MathUtils.clamp(alpha, 0, 1);
  const b = 1 - a;
  return (b * b * b * p0)
    + (3 * a * b * b * p1)
    + (3 * a * a * b * p2)
    + (a * a * a * p3);
}

function cubicBezierVec3(p0, p1, p2, p3, alpha, target) {
  const a = THREE.MathUtils.clamp(alpha, 0, 1);
  const b = 1 - a;
  target.copy(p0).multiplyScalar(b * b * b);
  target.add(TMP_BEZIER_A.copy(p1).multiplyScalar(3 * a * b * b));
  target.add(TMP_BEZIER_B.copy(p2).multiplyScalar(3 * a * a * b));
  target.add(TMP_BEZIER_C.copy(p3).multiplyScalar(a * a * a));
  return target;
}

function findSplineSpan(keys = [], timeSeconds = 0) {
  if (!Array.isArray(keys) || keys.length === 0) return null;
  if (keys.length === 1) {
    return { left: keys[0], right: keys[0], alpha: 0 };
  }

  let rightIndex = 1;
  while (rightIndex < keys.length && timeSeconds >= (Number(keys[rightIndex]?.time) || 0)) {
    rightIndex += 1;
  }
  if (rightIndex >= keys.length) rightIndex = keys.length - 1;

  let leftIndex = Math.max(0, rightIndex - 1);
  while (rightIndex < keys.length) {
    const leftTime = Number(keys[leftIndex]?.time) || 0;
    const rightTime = Number(keys[rightIndex]?.time) || leftTime;
    if ((rightTime - leftTime) > MIN_SPLINE_DELTA_SECONDS) break;
    if (rightIndex >= (keys.length - 1)) break;
    rightIndex += 1;
    leftIndex = Math.max(0, rightIndex - 1);
  }

  const left = keys[leftIndex];
  const right = keys[rightIndex];
  const leftTime = Number(left?.time) || 0;
  const rightTime = Number(right?.time) || leftTime;
  const delta = rightTime - leftTime;
  const alpha = delta > 1e-6 ? (timeSeconds - leftTime) / delta : 0;
  return {
    left,
    right,
    alpha: THREE.MathUtils.clamp(alpha, 0, 1),
  };
}

function sampleScalarTrack(keys = [], timeSeconds = 0) {
  const span = findSplineSpan(keys, timeSeconds);
  if (!span) return 0;
  if (span.left === span.right) return Number(span.left?.value) || 0;
  return cubicBezierScalar(
    Number(span.left?.value) || 0,
    Number(span.left?.lane3) || Number(span.left?.value) || 0,
    Number(span.right?.lane2) || Number(span.right?.value) || 0,
    Number(span.right?.value) || 0,
    span.alpha,
  );
}

function sampleVec3Track(keys = [], timeSeconds = 0, target = new THREE.Vector3()) {
  const span = findSplineSpan(keys, timeSeconds);
  if (!span) return target.set(0, 0, 0);
  const left = span.left?.value?.isVector3 ? span.left.value : target.set(0, 0, 0);
  if (span.left === span.right) return target.copy(left);
  const leftControl = span.left?.lane3?.isVector3 ? span.left.lane3 : left;
  const rightControl = span.right?.lane2?.isVector3 ? span.right.lane2 : span.right?.value || left;
  const right = span.right?.value?.isVector3 ? span.right.value : left;
  return cubicBezierVec3(left, leftControl, rightControl, right, span.alpha, target);
}

function buildCameraBasis(source, target, rollRadians, quaternionTarget) {
  TMP_FORWARD.copy(target).sub(source);
  if (TMP_FORWARD.lengthSq() <= 1e-8) {
    TMP_FORWARD.set(0, 0, -1);
  } else {
    TMP_FORWARD.normalize();
  }

  TMP_RIGHT.crossVectors(TMP_FORWARD, TMP_FALLBACK_UP);
  if (TMP_RIGHT.lengthSq() <= 1e-8) {
    TMP_RIGHT.crossVectors(TMP_FORWARD, TMP_ALT_UP);
  }
  TMP_RIGHT.normalize();
  TMP_UP.crossVectors(TMP_RIGHT, TMP_FORWARD).normalize();

  if (Math.abs(rollRadians) > 1e-8) {
    TMP_ROLL_QUAT.setFromAxisAngle(TMP_FORWARD, rollRadians);
    TMP_RIGHT.applyQuaternion(TMP_ROLL_QUAT);
    TMP_UP.applyQuaternion(TMP_ROLL_QUAT);
  }

  TMP_BASIS.makeBasis(TMP_RIGHT, TMP_UP, TMP_FORWARD.clone().negate());
  return quaternionTarget.setFromRotationMatrix(TMP_BASIS);
}

export class CutsceneCameraPlayer {
  constructor() {
    this.definition = null;
    this.loop = false;
    this.playing = false;
    this.timeMs = 0;
  }

  loadDefinition(definition) {
    this.definition = definition || null;
    this.timeMs = 0;
    this.playing = false;
  }

  clear() {
    this.definition = null;
    this.timeMs = 0;
    this.playing = false;
    this.loop = false;
  }

  getDurationMs() {
    return Math.max(0, Number(this.definition?.durationMs) || 0);
  }

  setLoop(loop) {
    this.loop = Boolean(loop);
  }

  play() {
    if (!this.definition) return;
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  stop() {
    this.playing = false;
    this.timeMs = 0;
  }

  seek(timeMs) {
    const durationMs = this.getDurationMs();
    this.timeMs = THREE.MathUtils.clamp(Number(timeMs) || 0, 0, durationMs);
  }

  sampleToCamera(camera, timeMs = this.timeMs) {
    if (!camera || !this.definition) return null;

    const timeSeconds = Math.max(0, Number(timeMs) || 0) / 1000;
    const offset = this.definition.offset || new THREE.Vector3();
    const source = sampleVec3Track(this.definition.tracks?.cameraPosition, timeSeconds, TMP_SOURCE)
      .add(offset);
    const target = sampleVec3Track(this.definition.tracks?.cameraTarget, timeSeconds, TMP_TARGET)
      .add(offset);
    const fov = sampleScalarTrack(this.definition.tracks?.fov, timeSeconds);
    const appliedVerticalFov = rwHorizontalFovToThreeVertical(fov, camera.aspect);
    const rollRadians = THREE.MathUtils.degToRad(sampleScalarTrack(this.definition.tracks?.roll, timeSeconds));
    const worldSource = gtaPositionToThree(source.x, source.y, source.z);
    const worldTarget = gtaPositionToThree(target.x, target.y, target.z);

    camera.position.copy(worldSource);
    buildCameraBasis(worldSource, worldTarget, rollRadians, camera.quaternion);
    if (Number.isFinite(appliedVerticalFov) && Math.abs(camera.fov - appliedVerticalFov) > 1e-6) {
      camera.fov = appliedVerticalFov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);

    return {
      source: source.clone(),
      target: target.clone(),
      worldSource: worldSource.clone(),
      worldTarget: worldTarget.clone(),
      fov,
      appliedVerticalFov,
      rollRadians,
      timeMs: Math.max(0, Number(timeMs) || 0),
      durationMs: this.getDurationMs(),
    };
  }

  update(dtSeconds, camera) {
    if (!this.definition) return null;
    const durationMs = this.getDurationMs();
    if (this.playing && durationMs > 0) {
      this.timeMs += Math.max(0, Number(dtSeconds) || 0) * 1000;
      if (this.timeMs >= durationMs) {
        if (this.loop) {
          this.timeMs = durationMs > 0 ? this.timeMs % durationMs : 0;
        } else {
          this.timeMs = durationMs;
          this.playing = false;
        }
      }
    }
    return this.sampleToCamera(camera, this.timeMs);
  }
}
