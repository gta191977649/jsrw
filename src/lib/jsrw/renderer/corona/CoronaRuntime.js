import * as THREE from 'three';
import { RWCoronaPipeline } from './RWCoronaPipeline.js';

const CORONA_UPDATE_POSITION_EPSILON_SQ = 4.0;
const CORONA_UPDATE_ROTATION_DOT = 0.9975;
const CORONA_TIME_BUCKET_MS = 120;

export class CoronaRuntime {
  constructor(options = {}) {
    this.backend = options.backend || null;
    this.pipeline = new RWCoronaPipeline(options);
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

  setDebugShowAll(enabled) {
    this.pipeline.setDebugShowAll(enabled);
    this.lastUpdateVisibilityVersion = -1;
    this.lastUpdateCandidateCount = -1;
  }

  setViewport(width, height) {
    this.pipeline.setViewport(width, height);
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

  markOccludersDirty() {
    this.pipeline.markOccludersDirty();
    this.lastUpdateVisibilityVersion = -1;
    this.lastUpdateCandidateCount = -1;
  }

  update(camera, runtimeContext = {}) {
    const frameVisibilityVersion = Number(runtimeContext?.frameVisibility?.version) || 0;
    const candidateCount = Array.isArray(runtimeContext?.frameVisibility?.coronaCandidates)
      ? runtimeContext.frameVisibility.coronaCandidates.length
      : -1;
    const timeBucket = Math.floor((Number(runtimeContext?.timeMs) || 0) / CORONA_TIME_BUCKET_MS);
    const knownCameraPos = Number.isFinite(this.lastUpdateCameraPos.x)
      && Number.isFinite(this.lastUpdateCameraPos.y)
      && Number.isFinite(this.lastUpdateCameraPos.z);
    const knownCameraQuat = Number.isFinite(this.lastUpdateCameraQuat.x)
      && Number.isFinite(this.lastUpdateCameraQuat.y)
      && Number.isFinite(this.lastUpdateCameraQuat.z)
      && Number.isFinite(this.lastUpdateCameraQuat.w);
    const cameraStable = knownCameraPos
      && knownCameraQuat
      && camera?.position?.distanceToSquared?.(this.lastUpdateCameraPos) <= CORONA_UPDATE_POSITION_EPSILON_SQ
      && Math.abs(camera?.quaternion?.dot?.(this.lastUpdateCameraQuat) ?? 0) >= CORONA_UPDATE_ROTATION_DOT;
    const canReuse = (
      frameVisibilityVersion === this.lastUpdateVisibilityVersion
      || (candidateCount >= 0 && candidateCount === this.lastUpdateCandidateCount)
    )
      && timeBucket === this.lastUpdateTimeBucket
      && cameraStable
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

  getDebugStats() {
    return this.pipeline.debugStats || null;
  }

  dispose() {
    this.pipeline.dispose();
  }

  get raw() {
    return this.pipeline;
  }
}

export default CoronaRuntime;
