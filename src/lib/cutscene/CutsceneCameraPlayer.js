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

function findKeySpan(keys = [], timeSeconds = 0) {
  if (!Array.isArray(keys) || keys.length === 0) return null;
  if (keys.length === 1 || timeSeconds <= keys[0].time) {
    return { left: keys[0], right: keys[0], alpha: 0 };
  }
  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index];
    if (timeSeconds > right.time) continue;
    const left = keys[index - 1];
    const delta = right.time - left.time;
    const alpha = delta > 1e-6 ? (timeSeconds - left.time) / delta : 0;
    return { left, right, alpha: THREE.MathUtils.clamp(alpha, 0, 1) };
  }
  const last = keys[keys.length - 1];
  return { left: last, right: last, alpha: 0 };
}

function sampleScalarTrack(keys = [], timeSeconds = 0) {
  const span = findKeySpan(keys, timeSeconds);
  if (!span) return 0;
  return THREE.MathUtils.lerp(
    Number(span.left?.value) || 0,
    Number(span.right?.value) || 0,
    span.alpha,
  );
}

function sampleVec3Track(keys = [], timeSeconds = 0, target = new THREE.Vector3()) {
  const span = findKeySpan(keys, timeSeconds);
  if (!span) return target.set(0, 0, 0);
  const left = span.left?.value?.isVector3 ? span.left.value : target.set(0, 0, 0);
  const right = span.right?.value?.isVector3 ? span.right.value : left;
  return target.copy(left).lerp(right, span.alpha);
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
    const rollRadians = THREE.MathUtils.degToRad(sampleScalarTrack(this.definition.tracks?.roll, timeSeconds));
    const worldSource = gtaPositionToThree(source.x, source.y, source.z);
    const worldTarget = gtaPositionToThree(target.x, target.y, target.z);

    camera.position.copy(worldSource);
    buildCameraBasis(worldSource, worldTarget, rollRadians, camera.quaternion);
    if (Number.isFinite(fov) && Math.abs(camera.fov - fov) > 1e-6) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);

    return {
      source: source.clone(),
      target: target.clone(),
      worldSource: worldSource.clone(),
      worldTarget: worldTarget.clone(),
      fov,
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
