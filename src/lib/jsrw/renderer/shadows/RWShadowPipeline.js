import * as THREE from 'three';
import { calcScreenCoorsLikeRw, prepareRwSpriteTexture } from '../world/sky/RWSpriteUtils.js';
import { computeTrafficLightBrightness, resolveTrafficLightPhase } from '../corona/TrafficLights.js';

const TMP_POSITION = new THREE.Vector3();
const TMP_FRONT = new THREE.Vector3();
const TMP_SIDE = new THREE.Vector3();
const TMP_SAMPLE = new THREE.Vector3();
const TMP_WORLD_A = new THREE.Vector3();
const TMP_WORLD_B = new THREE.Vector3();
const TMP_WORLD_C = new THREE.Vector3();
const TMP_TRI_EDGE = new THREE.Vector2();
const TMP_TRI_TO_POINT = new THREE.Vector2();
const TMP_TRI_NORMAL = new THREE.Vector3();
const TMP_TRIANGLE_BOX = new THREE.Box3();
const TMP_COLOR = new THREE.Color();
const CORNER_OFFSETS = [
  { front: 1, side: -1, uv: [0, 0] },
  { front: 1, side: 1, uv: [1, 0] },
  { front: -1, side: 1, uv: [1, 1] },
  { front: -1, side: -1, uv: [0, 1] },
];
const EMPTY_BOX = new THREE.Box3();
const DEFAULT_FADE_PER_SECOND = 3;
const DEFAULT_SHADOW_Z_DISTANCE = 15;
const DEFAULT_SHADOW_DRAW_DISTANCE = 40;
const DEFAULT_MAX_REBUILDS_PER_FRAME = 6;
const MAX_ACTIVE_SHADOWS = 48;
const OFFSCREEN_FADE_MARGIN = 0;

function overlapRange(minA, maxA, minB, maxB) {
  return minA <= maxB && maxA >= minB;
}

function cross2d(a, b) {
  return (a.x * b.y) - (a.y * b.x);
}

function clipPolygonAgainstEdge(polygon, edgeStart, edgeEnd, orientationSign) {
  if (!Array.isArray(polygon) || polygon.length === 0) return [];
  const output = [];
  const edgeVector = TMP_TRI_EDGE.set(edgeEnd.x - edgeStart.x, edgeEnd.y - edgeStart.y);
  const epsilon = 1e-5;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentVector = TMP_TRI_TO_POINT.set(current.x - edgeStart.x, current.z - edgeStart.y);
    const previousVector = new THREE.Vector2(previous.x - edgeStart.x, previous.z - edgeStart.y);
    const currentDistance = cross2d(edgeVector, currentVector) * orientationSign;
    const previousDistance = cross2d(edgeVector, previousVector) * orientationSign;
    const currentInside = currentDistance >= -epsilon;
    const previousInside = previousDistance >= -epsilon;

    if (currentInside !== previousInside) {
      const denominator = previousDistance - currentDistance;
      const t = Math.abs(denominator) > epsilon ? (previousDistance / denominator) : 0;
      output.push({
        x: previous.x + ((current.x - previous.x) * t),
        z: previous.z + ((current.z - previous.z) * t),
        u: previous.u + ((current.u - previous.u) * t),
        v: previous.v + ((current.v - previous.v) * t),
      });
    }
    if (currentInside) output.push(current);
  }
  return output;
}

function clipShadowQuadToTriangle(quad, triangle2d) {
  let polygon = quad.map((vertex) => ({ ...vertex }));
  const signedArea = (
    (triangle2d[0].x * triangle2d[1].y) + (triangle2d[1].x * triangle2d[2].y) + (triangle2d[2].x * triangle2d[0].y)
    - (triangle2d[0].y * triangle2d[1].x) - (triangle2d[1].y * triangle2d[2].x) - (triangle2d[2].y * triangle2d[0].x)
  );
  const orientationSign = signedArea >= 0 ? 1 : -1;
  for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
    const edgeStart = triangle2d[edgeIndex];
    const edgeEnd = triangle2d[(edgeIndex + 1) % 3];
    polygon = clipPolygonAgainstEdge(polygon, edgeStart, edgeEnd, orientationSign);
    if (polygon.length < 3) return [];
  }
  return polygon;
}

function solvePlaneHeight(normal, pointOnPlane, x, z) {
  if (Math.abs(normal.y) < 1e-5) return pointOnPlane.y;
  return pointOnPlane.y - ((normal.x * (x - pointOnPlane.x)) + (normal.z * (z - pointOnPlane.z))) / normal.y;
}

function clamp01(value) {
  return THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
}

function toVector3(value, fallback = [0, 0, 0]) {
  if (value?.isVector3) return value.clone();
  if (Array.isArray(value)) {
    return new THREE.Vector3(
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
    );
  }
  return new THREE.Vector3(
    Number(value?.x) || fallback[0] || 0,
    Number(value?.y) || fallback[1] || 0,
    Number(value?.z) || fallback[2] || 0,
  );
}

function normalizeEmitterColor(color) {
  const r = Number(color?.r);
  const g = Number(color?.g);
  const b = Number(color?.b);
  return {
    r: THREE.MathUtils.clamp(Number.isFinite(r) ? (r > 1 ? (r / 255) : r) : 1, 0, 1),
    g: THREE.MathUtils.clamp(Number.isFinite(g) ? (g > 1 ? (g / 255) : g) : 1, 0, 1),
    b: THREE.MathUtils.clamp(Number.isFinite(b) ? (b > 1 ? (b / 255) : b) : 1, 0, 1),
  };
}

function approach(current, target, delta) {
  if (current < target) return Math.min(current + delta, target);
  if (current > target) return Math.max(current - delta, target);
  return current;
}

function isNightHour(hour) {
  const normalizedHour = ((Math.floor(Number(hour) || 0) % 24) + 24) % 24;
  return normalizedHour > 18 || normalizedHour < 7;
}

function cameraMatchesTrafficLightFacingRule(camera, emitter) {
  if (emitter?.trafficLightIgnoreFacing === true) return true;
  const facingRule = String(emitter?.trafficLightFacingRule || 'always').toLowerCase();
  if (facingRule === 'always') return true;
  const forward = toVector3(emitter?.trafficLightForward, [0, 1, 0]).normalize();
  if (!camera?.getWorldDirection) return true;
  TMP_SIDE.copy(forward);
  TMP_FRONT.set(0, 0, 0);
  camera.getWorldDirection(TMP_FRONT);
  const dot = TMP_FRONT.dot(TMP_SIDE);
  switch (facingRule) {
    case 'lt-zero':
      return dot < 0;
    case 'lte-zero':
      return dot <= 0;
    case 'gt-zero':
      return dot > 0;
    case 'gte-zero':
      return dot >= 0;
    default:
      return true;
  }
}

function shouldShadowEmitterBeActive(entry, runtimeContext) {
  if (runtimeContext?.forceRender2dfx && entry?.emitter?.sourceType === '2dfx') {
    return { active: true, flicker: false };
  }
  if (
    (entry?.emitter?.sourceType === 'trafficLight' || entry?.emitter?.sourceType === 'trafficLightShadow')
    && runtimeContext?.trafficLights?.enabled === false
  ) {
    return { active: false, flicker: false };
  }

  const mode = String(entry?.emitter?.visibilityMode || 'always').toLowerCase();
  const hour = Number(runtimeContext?.timecycleCurrent?.hour) || 0;
  const timeMs = Number(runtimeContext?.timeMs) || 0;
  switch (mode) {
    case 'always':
      return { active: true, flicker: false };
    case 'night':
      return { active: isNightHour(hour), flicker: false };
    case 'flicker': {
      const active = ((timeMs ^ entry.index) & 0x60) !== 0 || (((timeMs >> 11) ^ entry.index) & 3) !== 0;
      return { active, flicker: !active };
    }
    case 'flicker-night': {
      if (!isNightHour(hour)) return { active: false, flicker: false };
      const active = ((timeMs ^ entry.index) & 0x60) !== 0 || (((timeMs >> 11) ^ entry.index) & 3) !== 0;
      return { active, flicker: !active };
    }
    case 'traffic-light':
      if (
        resolveTrafficLightPhase(
          timeMs,
          entry?.emitter?.trafficLightType,
          runtimeContext?.trafficLights,
        ) !== String(entry?.emitter?.trafficLightPhase || '').toLowerCase()
      ) {
        return { active: false, flicker: false };
      }
      if (
        runtimeContext?.trafficLights?.ignoreFacing === true
        || cameraMatchesTrafficLightFacingRule(runtimeContext?.camera, entry?.emitter)
      ) {
        return { active: true, flicker: false };
      }
      return { active: false, flicker: false };
    default:
      return { active: true, flicker: false };
  }
}

function createShadowGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([], 2));
  return geometry;
}

export class RWShadowPipeline {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.root = null;
    this.textureDictionary = null;
    this.entries = [];
    this.shadowRoot = new THREE.Group();
    this.shadowRoot.name = 'rw_shadows';
    this.shadowRoot.userData = {
      ...(this.shadowRoot.userData || {}),
      rwShadowAux: true,
      rwCoronaAux: true,
    };
    this.debugStats = {
      entryCount: 0,
      visibleCount: 0,
      projectedCount: 0,
      rebuiltCount: 0,
      missingTextureCount: 0,
      zeroIntensityCount: 0,
      outOfRangeCount: 0,
      rebuildFailedCount: 0,
      fallbackCornerCount: 0,
    };
    this.loggedFailureKeys = new Set();
    this.cachedSceneMeshes = null;
    this.sceneMeshesDirty = true;
    this.setRoot(options.root || null);
    this.setTextureDictionary(options.textureDictionary || null);
    this.setEmitters(options.emitters || []);
  }

  setRoot(root) {
    if (this.root === root) return this.root;
    if (this.shadowRoot.parent) this.shadowRoot.parent.remove(this.shadowRoot);
    this.root = root || null;
    this.sceneMeshesDirty = true;
    this.cachedSceneMeshes = null;
    if (this.root) this.root.add(this.shadowRoot);
    return this.root;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      for (const entry of this.entries) {
        if (entry.shadowMesh) entry.shadowMesh.visible = false;
      }
    }
  }

  setTextureDictionary(textureDictionary) {
    this.textureDictionary = textureDictionary || null;
    for (const entry of this.entries) {
      if (!entry.shadowMesh?.material) continue;
      entry.shadowMesh.material.map = this.resolveTexture(entry.emitter.shadow?.textureKey);
      entry.shadowMesh.material.needsUpdate = true;
    }
  }

  resolveTexture(textureKey) {
    if (!this.textureDictionary?.get) return null;
    const normalizedKey = String(textureKey || '').trim().toLowerCase();
    const textureKeys = normalizedKey ? [normalizedKey, 'shad_exp'] : ['shad_exp'];
    for (const key of textureKeys) {
      const textureEntry = this.textureDictionary.get(key);
      const texture = textureEntry?.texture || textureEntry || null;
      const prepared = prepareRwSpriteTexture(texture);
      if (prepared) return prepared;
    }
    return null;
  }

  setEmitters(emitters = []) {
    this.disposeEntries();
    this.loggedFailureKeys.clear();
    this.entries = (emitters || [])
      .filter((emitter) => Number(emitter?.shadow?.size) > 0)
      .map((emitter, index) => this.createEntry(emitter, index))
      .filter(Boolean);
    this.debugStats.entryCount = this.entries.length;
  }

  getSceneMeshes() {
    if (!this.root) return [];
    if (!this.sceneMeshesDirty && Array.isArray(this.cachedSceneMeshes)) return this.cachedSceneMeshes;
    this.root.updateMatrixWorld(true);
    const meshes = [];
    this.root.traverse((object) => {
      if (!object?.isMesh || !object.geometry) return;
      let current = object;
      while (current) {
        if (current.userData?.rwShadowAux || current.userData?.rwCoronaAux) return;
        current = current.parent;
      }
      const geometry = object.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const positionAttribute = geometry.getAttribute?.('position');
      if (!geometry.boundingBox || !positionAttribute || positionAttribute.count < 3) return;
      meshes.push({
        object,
        geometry,
        positionAttribute,
        indexAttribute: geometry.getIndex?.() || null,
        worldBox: geometry.boundingBox.clone().applyMatrix4(object.matrixWorld),
      });
    });
    this.cachedSceneMeshes = meshes;
    this.sceneMeshesDirty = false;
    return meshes;
  }

  createEntry(emitter, index) {
    if (!emitter) return null;
    const shadowMaterial = new THREE.MeshBasicMaterial({
      map: this.resolveTexture(emitter.shadow?.textureKey),
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      blending: THREE.CustomBlending,
      toneMapped: false,
    });
    shadowMaterial.blendSrc = THREE.OneFactor;
    shadowMaterial.blendDst = THREE.OneFactor;
    shadowMaterial.blendEquation = THREE.AddEquation;
    shadowMaterial.blendSrcAlpha = THREE.OneFactor;
    shadowMaterial.blendDstAlpha = THREE.OneFactor;
    shadowMaterial.blendEquationAlpha = THREE.AddEquation;

    const shadowMesh = new THREE.Mesh(createShadowGeometry(), shadowMaterial);
    shadowMesh.visible = false;
    shadowMesh.frustumCulled = false;
    shadowMesh.renderOrder = 10;
    shadowMesh.layers.set(4);
    shadowMesh.userData = {
      ...(shadowMesh.userData || {}),
      rwShadowAux: true,
      rwCoronaAux: true,
      rwShadowEmitterId: emitter.id ?? index,
    };
    this.shadowRoot.add(shadowMesh);

    return {
      emitter,
      index,
      fadeAlpha: 0,
      shadowMesh,
      projected: false,
      lastProjectionKey: '',
      lastFallbackCornerCount: 0,
      lastFailureReason: '',
    };
  }

  logFailure(entry, reason, details = null) {
    const emitterId = String(entry?.emitter?.id || entry?.index || 'unknown');
    const key = `${emitterId}:${reason}`;
    entry.lastFailureReason = reason;
    if (this.loggedFailureKeys.has(key)) return;
    this.loggedFailureKeys.add(key);
    const payload = {
      emitterId,
      modelName: entry?.emitter?.modelName || '',
      position: entry?.emitter?.position || null,
      shadow: entry?.emitter?.shadow || null,
      ...(details || {}),
    };
    console.warn(`[RWShadowPipeline] rebuild failed: ${reason}`, payload);
  }

  collectCandidateMeshes(bounds) {
    const sceneMeshes = this.getSceneMeshes();
    return sceneMeshes.filter((entry) => entry.worldBox.intersectsBox(bounds));
  }

  getProjectionKey(entry, shadowDebug = null) {
    const position = toVector3(entry.emitter.position);
    const shadow = entry.emitter.shadow || {};
    const sizeScale = Math.max(0.01, Number(shadowDebug?.sizeScale) || 1);
    const zDistanceScale = Math.max(0.01, Number(shadowDebug?.zDistanceScale) || 1);
    const front = toVector3(shadow.front, [Number(shadow.size) || 0, 0, 0]).multiplyScalar(sizeScale);
    const side = toVector3(shadow.side, [0, 0, -(Number(shadow.size) || 0)]).multiplyScalar(sizeScale);
    return [
      position.x.toFixed(2),
      position.y.toFixed(2),
      position.z.toFixed(2),
      front.x.toFixed(2),
      front.y.toFixed(2),
      front.z.toFixed(2),
      side.x.toFixed(2),
      side.y.toFixed(2),
      side.z.toFixed(2),
      (Number(shadow.zDistance || DEFAULT_SHADOW_Z_DISTANCE) * zDistanceScale).toFixed(2),
      Number(shadowDebug?.heightBias || 0.03).toFixed(3),
    ].join('|');
  }

  rebuildProjectedGeometry(entry, shadowDebug = null) {
    const shadow = entry.emitter.shadow || {};
    const sizeScale = Math.max(0.01, Number(shadowDebug?.sizeScale) || 1);
    const zDistanceScale = Math.max(0.01, Number(shadowDebug?.zDistanceScale) || 1);
    const heightBias = Number(shadowDebug?.heightBias);
    const vertexBias = Number.isFinite(heightBias) ? heightBias : 0.03;
    const maxDistance = (Number(shadow.zDistance) || DEFAULT_SHADOW_Z_DISTANCE) * zDistanceScale;
    const center = toVector3(entry.emitter.position);
    TMP_FRONT.copy(toVector3(shadow.front, [Number(shadow.size) || 0, 0, 0])).multiplyScalar(sizeScale);
    TMP_SIDE.copy(toVector3(shadow.side, [0, 0, -(Number(shadow.size) || 0)])).multiplyScalar(sizeScale);
    const quad = CORNER_OFFSETS.map((offset) => {
      TMP_SAMPLE.copy(center)
        .addScaledVector(TMP_FRONT, offset.front)
        .addScaledVector(TMP_SIDE, offset.side);
      return {
        x: TMP_SAMPLE.x,
        z: TMP_SAMPLE.z,
        u: offset.uv[0],
        v: offset.uv[1],
      };
    });
    const minX = Math.min(...quad.map((point) => point.x));
    const maxX = Math.max(...quad.map((point) => point.x));
    const minZ = Math.min(...quad.map((point) => point.z));
    const maxZ = Math.max(...quad.map((point) => point.z));
    const maxY = center.y;
    const minY = center.y - maxDistance;
    const searchBounds = EMPTY_BOX.clone().set(
      new THREE.Vector3(minX, minY, minZ),
      new THREE.Vector3(maxX, maxY, maxZ),
    );
    const candidateMeshes = this.collectCandidateMeshes(searchBounds);
    if (candidateMeshes.length === 0) {
      this.logFailure(entry, 'no-candidate-meshes', {
        center: { x: center.x, y: center.y, z: center.z },
        maxDistance,
      });
      return false;
    }

    const positions = [];
    const uvs = [];
    const pushVertex = (point, uv) => {
      positions.push(point.x, point.y + vertexBias, point.z);
      uvs.push(uv[0], uv[1]);
    };

    let fallbackCornerCount = 0;
    for (const meshEntry of candidateMeshes) {
      const { object: mesh, positionAttribute, indexAttribute } = meshEntry;
      const triangleCount = indexAttribute ? indexAttribute.count / 3 : positionAttribute.count / 3;
      for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
        const ia = indexAttribute ? indexAttribute.getX((triangleIndex * 3) + 0) : ((triangleIndex * 3) + 0);
        const ib = indexAttribute ? indexAttribute.getX((triangleIndex * 3) + 1) : ((triangleIndex * 3) + 1);
        const ic = indexAttribute ? indexAttribute.getX((triangleIndex * 3) + 2) : ((triangleIndex * 3) + 2);
        TMP_WORLD_A.fromBufferAttribute(positionAttribute, ia).applyMatrix4(mesh.matrixWorld);
        TMP_WORLD_B.fromBufferAttribute(positionAttribute, ib).applyMatrix4(mesh.matrixWorld);
        TMP_WORLD_C.fromBufferAttribute(positionAttribute, ic).applyMatrix4(mesh.matrixWorld);

        const triangleMinX = Math.min(TMP_WORLD_A.x, TMP_WORLD_B.x, TMP_WORLD_C.x);
        const triangleMaxX = Math.max(TMP_WORLD_A.x, TMP_WORLD_B.x, TMP_WORLD_C.x);
        const triangleMinZ = Math.min(TMP_WORLD_A.z, TMP_WORLD_B.z, TMP_WORLD_C.z);
        const triangleMaxZ = Math.max(TMP_WORLD_A.z, TMP_WORLD_B.z, TMP_WORLD_C.z);
        const triangleMinY = Math.min(TMP_WORLD_A.y, TMP_WORLD_B.y, TMP_WORLD_C.y);
        const triangleMaxY = Math.max(TMP_WORLD_A.y, TMP_WORLD_B.y, TMP_WORLD_C.y);
        if (
          !overlapRange(minX, maxX, triangleMinX, triangleMaxX)
          || !overlapRange(minZ, maxZ, triangleMinZ, triangleMaxZ)
          || !overlapRange(minY, maxY, triangleMinY, triangleMaxY)
        ) {
          continue;
        }

        TMP_TRI_NORMAL.copy(TMP_WORLD_B).sub(TMP_WORLD_A).cross(TMP_WORLD_C.clone().sub(TMP_WORLD_A)).normalize();
        if (Math.abs(TMP_TRI_NORMAL.y) <= 0.1) continue;

        const clippedPolygon = clipShadowQuadToTriangle(quad, [
          { x: TMP_WORLD_A.x, y: TMP_WORLD_A.z },
          { x: TMP_WORLD_B.x, y: TMP_WORLD_B.z },
          { x: TMP_WORLD_C.x, y: TMP_WORLD_C.z },
        ]);
        if (clippedPolygon.length < 3) continue;

        const centerPolygonPoint = clippedPolygon.reduce((acc, point) => {
          acc.x += point.x;
          acc.z += point.z;
          acc.u += point.u;
          acc.v += point.v;
          return acc;
        }, { x: 0, z: 0, u: 0, v: 0 });
        centerPolygonPoint.x /= clippedPolygon.length;
        centerPolygonPoint.z /= clippedPolygon.length;
        centerPolygonPoint.u /= clippedPolygon.length;
        centerPolygonPoint.v /= clippedPolygon.length;
        const projectedCenter = new THREE.Vector3(
          centerPolygonPoint.x,
          solvePlaneHeight(TMP_TRI_NORMAL, TMP_WORLD_A, centerPolygonPoint.x, centerPolygonPoint.z),
          centerPolygonPoint.z,
        );

        for (let index = 0; index < clippedPolygon.length; index += 1) {
          const current = clippedPolygon[index];
          const next = clippedPolygon[(index + 1) % clippedPolygon.length];
          const currentPoint = new THREE.Vector3(
            current.x,
            solvePlaneHeight(TMP_TRI_NORMAL, TMP_WORLD_A, current.x, current.z),
            current.z,
          );
          const nextPoint = new THREE.Vector3(
            next.x,
            solvePlaneHeight(TMP_TRI_NORMAL, TMP_WORLD_A, next.x, next.z),
            next.z,
          );
          pushVertex(projectedCenter, [centerPolygonPoint.u, centerPolygonPoint.v]);
          pushVertex(currentPoint, [current.u, current.v]);
          pushVertex(nextPoint, [next.u, next.v]);
        }
      }
    }

    if (positions.length < 9) {
      this.logFailure(entry, 'no-overlapping-triangles', {
        candidateMeshes: candidateMeshes.length,
        center: { x: center.x, y: center.y, z: center.z },
        maxDistance,
      });
      return false;
    }

    const geometry = entry.shadowMesh.geometry;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    if (!geometry.boundingSphere) {
      this.logFailure(entry, 'missing-bounding-sphere', {
        fallbackCornerCount,
      });
      return false;
    }
    entry.projected = true;
    entry.lastProjectionKey = this.getProjectionKey(entry, shadowDebug);
    entry.lastFallbackCornerCount = fallbackCornerCount;
    return true;
  }

  update(camera, runtimeContext = {}) {
    const shadowDebug = runtimeContext?.shadows || {};
    const timecycleValues = runtimeContext?.timecycleCurrent?.values || {};
    const spriteBrightnessValue = Number(timecycleValues.spriteBrightness);
    const spriteBrightness = Math.max(0, Number.isFinite(spriteBrightnessValue) ? spriteBrightnessValue : 1);
    const lightOnGroundBrightness = Math.max(0, Number(timecycleValues.lightOnGround) || 0);
    const trafficLightBrightness = computeTrafficLightBrightness(runtimeContext);
    const fadeDelta = Math.max(0, Number(runtimeContext?.dt) || 0) * DEFAULT_FADE_PER_SECOND;
    let visibleCount = 0;
    let projectedCount = 0;
    let rebuiltCount = 0;
    let missingTextureCount = 0;
    let zeroIntensityCount = 0;
    let outOfRangeCount = 0;
    let rebuildFailedCount = 0;
    let fallbackCornerCount = 0;
    let rebuildBudget = DEFAULT_MAX_REBUILDS_PER_FRAME;
    const candidateEntries = [];

    for (const entry of this.entries) {
      const emitter = entry.emitter;
      const shadowSettings = emitter.shadow || {};
      const shadowTexture = entry.shadowMesh.material?.map || null;
      const shadowIntensity = Math.max(0, Number(shadowSettings.intensity) || 0);
      const distance = camera.position.distanceTo(TMP_POSITION.copy(toVector3(emitter.position)));
      const visibility = shouldShadowEmitterBeActive(entry, {
        ...runtimeContext,
        camera,
      });
      const drawDistance = Math.max(
        0,
        (Number(shadowSettings.drawDistance) || DEFAULT_SHADOW_DRAW_DISTANCE)
          * Math.max(0, Number(shadowDebug.drawDistanceScale) || 1),
      );
      const needsScreenTest = this.enabled && (visibility.active || entry.fadeAlpha > 0.001);
      const screen = needsScreenTest
        ? calcScreenCoorsLikeRw(
          camera,
          toVector3(emitter.position),
          runtimeContext?.viewportWidth || 1,
          runtimeContext?.viewportHeight || 1,
          true,
        )
        : null;
      const screenVisible = Boolean(
        screen
        && screen.x >= -OFFSCREEN_FADE_MARGIN
        && screen.x <= ((runtimeContext?.viewportWidth || 1) + OFFSCREEN_FADE_MARGIN)
        && screen.y >= -OFFSCREEN_FADE_MARGIN
        && screen.y <= ((runtimeContext?.viewportHeight || 1) + OFFSCREEN_FADE_MARGIN),
      );
      if (!shadowTexture) missingTextureCount += 1;
      if (shadowIntensity <= 0) zeroIntensityCount += 1;
      if (drawDistance > 0 && distance > drawDistance) outOfRangeCount += 1;
      const trafficLightShadowVisible = emitter.sourceType !== 'trafficLightShadow' || trafficLightBrightness > 0.05;
      const wantsShow = (
        this.enabled
        && visibility.active
        && shadowIntensity > 0
        && shadowTexture
        && (Number(shadowSettings.size) || 0) > 0
        && (drawDistance <= 0 || distance <= drawDistance)
        && screenVisible
        && trafficLightShadowVisible
      );

      if (wantsShow || entry.fadeAlpha > 0.001 || entry.projected) {
        candidateEntries.push({
          entry,
          emitter,
          shadowSettings,
          shadowIntensity,
          distance,
          wantsShow,
        });
      } else {
        entry.shadowMesh.visible = false;
      }
    }

    candidateEntries.sort((a, b) => a.distance - b.distance);
    let activeShadowBudget = Math.max(0, Math.floor(Number(shadowDebug.maxActiveShadows) || MAX_ACTIVE_SHADOWS));
    const selectedEntries = new Set();
    for (const item of candidateEntries) {
      if (item.entry.fadeAlpha > 0.001) {
        selectedEntries.add(item.entry);
        continue;
      }
      if (item.wantsShow && activeShadowBudget > 0) {
        selectedEntries.add(item.entry);
        activeShadowBudget -= 1;
      }
    }

    for (const item of candidateEntries) {
      const { entry, emitter, shadowSettings, shadowIntensity, distance, wantsShow } = item;
      const targetAlpha = wantsShow && selectedEntries.has(entry) ? 1 : 0;

      entry.fadeAlpha = approach(entry.fadeAlpha, targetAlpha, fadeDelta);
      if (entry.fadeAlpha <= 0.001) {
        entry.shadowMesh.visible = false;
        continue;
      }

      const projectionKey = this.getProjectionKey(entry, shadowDebug);
      if (shadowDebug.rebuildEveryFrame === true || !entry.projected || entry.lastProjectionKey !== projectionKey) {
        if (shadowDebug.rebuildEveryFrame !== true && rebuildBudget <= 0) {
          entry.shadowMesh.visible = entry.projected;
          continue;
        }
        const previousProjected = entry.projected;
        if (!this.rebuildProjectedGeometry(entry, shadowDebug)) {
          rebuildFailedCount += 1;
          entry.projected = previousProjected;
          entry.shadowMesh.visible = false;
          continue;
        }
        if (shadowDebug.rebuildEveryFrame !== true) rebuildBudget -= 1;
        rebuiltCount += 1;
        fallbackCornerCount += entry.lastFallbackCornerCount || 0;
      }

      if (!entry.projected) {
        entry.shadowMesh.visible = false;
        continue;
      }

      const color = normalizeEmitterColor(emitter.color);
      const debugIntensityScale = Math.max(0, Number(shadowDebug.intensityScale) || 1);
      const fixedIntensityWeight = shadowIntensity / 255;
      const timecycleBrightness = shadowSettings.colorScale === 'trafficLightGround'
        ? ((lightOnGroundBrightness / 8) * trafficLightBrightness)
        : spriteBrightness;
      const resolvedBrightness = Math.max(0, timecycleBrightness * fixedIntensityWeight * debugIntensityScale);
      const alphaScale = clamp01(entry.fadeAlpha * ((Number(shadowSettings.alpha) || 128) / 255) * debugIntensityScale);
      entry.shadowMesh.visible = true;
      visibleCount += 1;
      projectedCount += 1;
      entry.shadowMesh.position.set(0, 0, 0);
      entry.shadowMesh.scale.set(1, 1, 1);
      entry.shadowMesh.material.wireframe = shadowDebug.wireframe === true;
      TMP_COLOR.setRGB(
        color.r * resolvedBrightness,
        color.g * resolvedBrightness,
        color.b * resolvedBrightness,
        THREE.SRGBColorSpace,
      );
      entry.shadowMesh.material.color.copy(TMP_COLOR);
      entry.shadowMesh.material.opacity = alphaScale;
    }

    for (const entry of this.entries) {
      if (selectedEntries.has(entry)) continue;
      if (entry.fadeAlpha <= 0.001) entry.shadowMesh.visible = false;
    }

    this.debugStats.visibleCount = visibleCount;
    this.debugStats.projectedCount = projectedCount;
    this.debugStats.rebuiltCount = rebuiltCount;
    this.debugStats.missingTextureCount = missingTextureCount;
    this.debugStats.zeroIntensityCount = zeroIntensityCount;
    this.debugStats.outOfRangeCount = outOfRangeCount;
    this.debugStats.rebuildFailedCount = rebuildFailedCount;
    this.debugStats.fallbackCornerCount = fallbackCornerCount;
  }

  render() {}

  disposeEntries() {
    for (const entry of this.entries) {
      if (entry.shadowMesh?.parent) entry.shadowMesh.parent.remove(entry.shadowMesh);
      if (entry.shadowMesh?.material) entry.shadowMesh.material.dispose();
      entry.shadowMesh = null;
    }
    this.entries = [];
  }

  dispose() {
    this.disposeEntries();
    if (this.shadowRoot.parent) this.shadowRoot.parent.remove(this.shadowRoot);
  }
}

export default RWShadowPipeline;
