import * as THREE from 'three';
import { RWShadowPipeline } from './RWShadowPipeline.js';

const SHADOW_UPDATE_POSITION_EPSILON_SQ = 4.0;
const SHADOW_UPDATE_ROTATION_DOT = 0.9975;
const SHADOW_TIME_BUCKET_MS = 120;

export class ShadowRuntime {
  constructor(options = {}) {
    this.backend = options.backend || null;
    this.pipeline = new RWShadowPipeline(options);
    this.lastUpdateVisibilityVersion = -1;
    this.lastUpdateCandidateCount = -1;
    this.lastUpdateTimeBucket = -1;
    this.lastUpdateCameraPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
    this.lastUpdateCameraQuat = new THREE.Quaternion(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
  }

  setBackend(backend) {
    this.backend = backend || null;
  }

  setRoot(root) {
    this.pipeline.setRoot(root);
    this.lastUpdateVisibilityVersion = -1;
    this.lastUpdateCandidateCount = -1;
  }

  setEnabled(enabled) {
    this.pipeline.setEnabled(enabled);
    this.lastUpdateVisibilityVersion = -1;
    this.lastUpdateCandidateCount = -1;
  }

  setEmitters(emitters) {
    this.pipeline.setEmitters(emitters);
    this.lastUpdateVisibilityVersion = -1;
    this.lastUpdateCandidateCount = -1;
  }

  setTextureDictionary(textureDictionary) {
    this.pipeline.setTextureDictionary(textureDictionary);
    this.lastUpdateVisibilityVersion = -1;
    this.lastUpdateCandidateCount = -1;
  }

  markSceneMeshesDirty() {
    this.pipeline.markSceneMeshesDirty();
    this.lastUpdateVisibilityVersion = -1;
    this.lastUpdateCandidateCount = -1;
  }

  update(camera, runtimeContext = {}) {
    const frameVisibilityVersion = Number(runtimeContext?.frameVisibility?.version) || 0;
    const candidateCount = Array.isArray(runtimeContext?.frameVisibility?.shadowCandidates)
      ? runtimeContext.frameVisibility.shadowCandidates.length
      : -1;
    const timeBucket = Math.floor((Number(runtimeContext?.timeMs) || 0) / SHADOW_TIME_BUCKET_MS);
    const knownCameraPos = Number.isFinite(this.lastUpdateCameraPos.x)
      && Number.isFinite(this.lastUpdateCameraPos.y)
      && Number.isFinite(this.lastUpdateCameraPos.z);
    const knownCameraQuat = Number.isFinite(this.lastUpdateCameraQuat.x)
      && Number.isFinite(this.lastUpdateCameraQuat.y)
      && Number.isFinite(this.lastUpdateCameraQuat.z)
      && Number.isFinite(this.lastUpdateCameraQuat.w);
    const cameraStable = knownCameraPos
      && knownCameraQuat
      && camera?.position?.distanceToSquared?.(this.lastUpdateCameraPos) <= SHADOW_UPDATE_POSITION_EPSILON_SQ
      && Math.abs(camera?.quaternion?.dot?.(this.lastUpdateCameraQuat) ?? 0) >= SHADOW_UPDATE_ROTATION_DOT;
    const canReuse = (
      frameVisibilityVersion === this.lastUpdateVisibilityVersion
      || (candidateCount >= 0 && candidateCount === this.lastUpdateCandidateCount)
    )
      && timeBucket === this.lastUpdateTimeBucket
      && cameraStable
      && !runtimeContext?.shadows?.rebuildEveryFrame
      && !this.pipeline.hasTransientEntries();
    if (canReuse) return;
    this.pipeline.update(camera, runtimeContext);
    this.lastUpdateVisibilityVersion = frameVisibilityVersion;
    this.lastUpdateCandidateCount = candidateCount;
    this.lastUpdateTimeBucket = timeBucket;
    if (camera?.position) this.lastUpdateCameraPos.copy(camera.position);
    if (camera?.quaternion) this.lastUpdateCameraQuat.copy(camera.quaternion);
  }

  render(renderer, camera) {
    this.pipeline.render(renderer, camera);
  }

  hasActiveEntries() {
    return this.pipeline.hasActiveEntries();
  }

  dispose() {
    this.pipeline.dispose();
  }

  get raw() {
    return this.pipeline;
  }
}

export default ShadowRuntime;
