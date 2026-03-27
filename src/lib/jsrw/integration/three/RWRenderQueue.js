import * as THREE from 'three';
import { getRWMaterialDescriptor } from '../../adapters/three/ThreeMaterialAdapter.js';

const BUCKET_LAYERS = {
  opaque: 1,
  cutout: 2,
  transparent: 3,
  additive: 4,
  overlay: 5,
};
const PREPARE_REUSE_POSITION_EPSILON_SQ = 0.25;
const PREPARE_REUSE_QUATERNION_DOT = 0.99985;

const RENDER_CLASS_ORDER = {
  building: 0,
  entity: 1,
  underwater: 2,
};

function getBucketPriority(bucket) {
  if (bucket === 'overlay') return 4;
  if (bucket === 'additive') return 3;
  if (bucket === 'transparent') return 2;
  if (bucket === 'cutout') return 1;
  return 0;
}

function getBucketBaseOrder(bucket) {
  if (bucket === 'cutout') return 1000;
  if (bucket === 'transparent') return 2000;
  if (bucket === 'additive') return 3000;
  if (bucket === 'overlay') return 9000;
  return 0;
}

function getRenderClassOrder(renderClass) {
  return RENDER_CLASS_ORDER[renderClass] ?? RENDER_CLASS_ORDER.entity;
}

function setMeshBucketLayer(object, bucket) {
  const layer = BUCKET_LAYERS[bucket] ?? 0;
  if (object.userData?.rwQueueLayer === layer) return;
  object.layers.set(layer);
  object.userData = {
    ...(object.userData || {}),
    rwQueueLayer: layer,
  };
}

function getMeshBucket(mesh) {
  if (mesh.userData?.rwIsSelectionOverlay) return 'overlay';
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let bucket = 'opaque';
  let priority = getBucketPriority(bucket);
  for (const material of materials) {
    if (!material) continue;
    const nextBucket = getRWMaterialDescriptor(material)?.renderBucket || 'opaque';
    const nextPriority = getBucketPriority(nextBucket);
    if (nextPriority > priority) {
      bucket = nextBucket;
      priority = nextPriority;
    }
  }
  return bucket;
}

function getMeshRenderClass(mesh) {
  const renderClass = String(
    mesh.userData?.rwQueueRenderClass
    || (mesh.userData?.water ? 'underwater' : '')
    || (mesh.userData?.objectDetail || mesh.userData?.rwPipelineTarget?.category === 'building' ? 'building' : 'entity'),
  ).toLowerCase();
  if (renderClass === 'underwater') return 'underwater';
  if (renderClass === 'building') return 'building';
  return 'entity';
}

function isVisibleInWorld(mesh, stopAt) {
  let cursor = mesh;
  while (cursor) {
    if (cursor.visible === false) return false;
    if (cursor === stopAt) break;
    cursor = cursor.parent;
  }
  return true;
}

function isPersistentOverlayEntry(entry) {
  const mesh = entry?.mesh;
  if (!mesh) return false;
  if (mesh.userData?.rwIsSelectionOverlay) return true;
  let cursor = mesh.parent;
  while (cursor) {
    if (cursor.userData?.rwInstanceSelectionProxy) return true;
    cursor = cursor.parent;
  }
  return false;
}

export class RWRenderQueue {
  constructor(root) {
    this.root = root;
    this.entries = [];
    this.persistentOverlayEntries = [];
    this.entryByMesh = new WeakMap();
    this.tempProjScreenMatrix = new THREE.Matrix4();
    this.tempFrustum = new THREE.Frustum();
    this.tempSphere = new THREE.Sphere();
    this.lastPreparedCameraPosition = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
    this.lastPreparedCameraQuaternion = new THREE.Quaternion(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    this.lastPreparedQueueVersion = -1;
    this.frameBuckets = {
      opaque: [],
      cutout: [],
      transparent: [],
      additive: [],
      overlay: [],
    };
    this.activeOpaqueEntries = [];
    this.activeTransparentEntries = [];
    this.cameraMaskStack = [];
    this.dirty = true;
    this.debugStats = {
      opaqueCount: 0,
      cutoutCount: 0,
      transparentCount: 0,
      additiveCount: 0,
      overlayCount: 0,
      alphaBuildingCount: 0,
      alphaEntityCount: 0,
      alphaUnderwaterCount: 0,
      prepareCpuMs: 0,
      prepareReuseHitMs: 0,
      prepareBucketBindMs: 0,
      prepareTransparentOrderApplyMs: 0,
    };
  }

  setRoot(root) {
    this.root = root;
    this.markDirty();
  }

  markDirty() {
    this.dirty = true;
  }

  rebuild(root = this.root) {
    this.root = root;
    this.entries = [];
    this.persistentOverlayEntries = [];
    this.entryByMesh = new WeakMap();
    this.activeOpaqueEntries = [];
    this.activeTransparentEntries = [];
    this.lastPreparedQueueVersion = -1;
    if (!root) {
      this.dirty = false;
      return;
    }

    root.traverse((node) => {
      if (!node.isMesh) return;
      const bucket = getMeshBucket(node);
      const renderClass = getMeshRenderClass(node);
      const entry = {
        mesh: node,
        bucket,
        renderClass,
        baseOrder: getBucketBaseOrder(bucket),
        renderClassOrder: getRenderClassOrder(renderClass),
        sortBias: 0,
        distanceSq: Number.POSITIVE_INFINITY,
        isTransparentBucket: bucket === 'transparent' || bucket === 'additive' || bucket === 'overlay',
      };
      this.entries.push(entry);
      this.entryByMesh.set(node, entry);
      setMeshBucketLayer(node, bucket);
      if (node.renderOrder !== entry.baseOrder) node.renderOrder = entry.baseOrder;
      node.userData = {
        ...(node.userData || {}),
        rwQueueEntry: entry,
      };
      if (isPersistentOverlayEntry(entry)) this.persistentOverlayEntries.push(entry);
    });

    this.dirty = false;
  }

  getEntriesForFrame(frameVisibility) {
    if (frameVisibility?.computed !== true) return this.entries;
    const directEntries = Array.isArray(frameVisibility?.visibleQueueEntries) ? frameVisibility.visibleQueueEntries : [];
    if (directEntries.length > 0) {
      if (this.persistentOverlayEntries.length === 0) return directEntries;
      const visibleEntries = directEntries.slice();
      const seen = new Set(visibleEntries);
      for (const entry of this.persistentOverlayEntries) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        visibleEntries.push(entry);
      }
      return visibleEntries;
    }
    const meshes = Array.isArray(frameVisibility?.visibleQueueMeshes) ? frameVisibility.visibleQueueMeshes : [];
    const visibleEntries = [];
    const seen = new Set();
    for (const mesh of meshes) {
      const entry = this.entryByMesh.get(mesh);
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      visibleEntries.push(entry);
    }
    for (const entry of this.persistentOverlayEntries) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      visibleEntries.push(entry);
    }
    return visibleEntries;
  }

  canReusePreparedFrame(camera, frameVisibility) {
    if (this.dirty || frameVisibility?.computed !== true || !camera) return false;
    const queueVersion = Number.isFinite(Number(frameVisibility?.queueVersion))
      ? Number(frameVisibility.queueVersion)
      : Number(frameVisibility?.version);
    if (!Number.isFinite(queueVersion) || queueVersion !== this.lastPreparedQueueVersion) {
      return false;
    }
    if (!Number.isFinite(this.lastPreparedCameraPosition.x) || !Number.isFinite(this.lastPreparedCameraQuaternion.w)) {
      return false;
    }
    if (camera.position.distanceToSquared(this.lastPreparedCameraPosition) > PREPARE_REUSE_POSITION_EPSILON_SQ) {
      return false;
    }
    if (Math.abs(camera.quaternion.dot(this.lastPreparedCameraQuaternion)) < PREPARE_REUSE_QUATERNION_DOT) {
      return false;
    }
    return true;
  }

  prepareFrame(camera, frameVisibility = null, options = {}) {
    const profileEnabled = options.profileEnabled === true;
    const prepareStartMs = profileEnabled ? performance.now() : 0;
    if (this.dirty) this.rebuild();
    if (this.canReusePreparedFrame(camera, frameVisibility)) {
      this.debugStats.prepareReuseHitMs = profileEnabled ? (performance.now() - prepareStartMs) : 0;
      this.debugStats.prepareBucketBindMs = 0;
      this.debugStats.prepareTransparentOrderApplyMs = 0;
      this.debugStats.prepareCpuMs = profileEnabled ? (performance.now() - prepareStartMs) : 0;
      return;
    }
    if (camera?.projectionMatrix && camera?.matrixWorldInverse) {
      this.tempProjScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.tempFrustum.setFromProjectionMatrix(this.tempProjScreenMatrix);
    }

    this.frameBuckets.opaque = [];
    this.frameBuckets.cutout = [];
    this.frameBuckets.transparent = [];
    this.frameBuckets.additive = [];
    this.frameBuckets.overlay = [];
    this.activeOpaqueEntries = [];
    this.activeTransparentEntries = [];
    this.debugStats.opaqueCount = 0;
    this.debugStats.cutoutCount = 0;
    this.debugStats.transparentCount = 0;
    this.debugStats.additiveCount = 0;
    this.debugStats.overlayCount = 0;
    this.debugStats.alphaBuildingCount = 0;
    this.debugStats.alphaEntityCount = 0;
    this.debugStats.alphaUnderwaterCount = 0;
    this.debugStats.prepareReuseHitMs = 0;
    const useFrameVisibility = frameVisibility?.computed === true;
    const hasPreparedFrameBuckets = useFrameVisibility && (
      (Array.isArray(frameVisibility?.visibleQueueEntries) && frameVisibility.visibleQueueEntries.length > 0)
      || (
        Array.isArray(frameVisibility?.queueBuckets?.opaque) && frameVisibility.queueBuckets.opaque.length > 0
      )
      || (
        Array.isArray(frameVisibility?.queueBuckets?.cutout) && frameVisibility.queueBuckets.cutout.length > 0
      )
      || (
        Array.isArray(frameVisibility?.queueBuckets?.transparent) && frameVisibility.queueBuckets.transparent.length > 0
      )
      || (
        Array.isArray(frameVisibility?.queueBuckets?.additive) && frameVisibility.queueBuckets.additive.length > 0
      )
      || (
        Array.isArray(frameVisibility?.queueBuckets?.overlay) && frameVisibility.queueBuckets.overlay.length > 0
      )
    );
    let transparent = [];
    let additive = [];
    let overlay = [];

    const bucketBindStartMs = profileEnabled ? performance.now() : 0;
    if (hasPreparedFrameBuckets && frameVisibility?.queueBuckets) {
      this.frameBuckets.opaque = Array.isArray(frameVisibility.queueBuckets.opaque) ? frameVisibility.queueBuckets.opaque : [];
      this.frameBuckets.cutout = Array.isArray(frameVisibility.queueBuckets.cutout) ? frameVisibility.queueBuckets.cutout : [];
      this.frameBuckets.transparent = Array.isArray(frameVisibility.queueBuckets.transparent) ? frameVisibility.queueBuckets.transparent : [];
      this.frameBuckets.additive = Array.isArray(frameVisibility.queueBuckets.additive) ? frameVisibility.queueBuckets.additive : [];
      this.frameBuckets.overlay = Array.isArray(frameVisibility.queueBuckets.overlay) ? frameVisibility.queueBuckets.overlay : [];
      this.activeOpaqueEntries = this.frameBuckets.opaque.length || this.frameBuckets.cutout.length
        ? [...this.frameBuckets.opaque, ...this.frameBuckets.cutout]
        : [];
      transparent = this.frameBuckets.transparent;
      additive = this.frameBuckets.additive;
      overlay = this.frameBuckets.overlay;
      this.activeTransparentEntries = transparent.length || additive.length || overlay.length
        ? [...transparent, ...additive, ...overlay]
        : [];
      this.debugStats.opaqueCount = this.frameBuckets.opaque.length;
      this.debugStats.cutoutCount = this.frameBuckets.cutout.length;
      this.debugStats.transparentCount = transparent.length;
      this.debugStats.additiveCount = additive.length;
      this.debugStats.overlayCount = overlay.length;
      for (const entry of this.activeTransparentEntries) {
        if (entry.renderClass === 'building') this.debugStats.alphaBuildingCount += 1;
        else if (entry.renderClass === 'underwater') this.debugStats.alphaUnderwaterCount += 1;
        else this.debugStats.alphaEntityCount += 1;
      }
    } else {
      const sourceEntries = this.getEntriesForFrame(frameVisibility);
      for (const entry of sourceEntries) {
        const { mesh } = entry;
        if (!isVisibleInWorld(mesh, this.root)) continue;
        if (camera && mesh.frustumCulled !== false && mesh.geometry) {
          if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
          if (mesh.geometry.boundingSphere) {
            this.tempSphere.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
            if (!this.tempFrustum.intersectsSphere(this.tempSphere)) continue;
          }
        }

        if (this.frameBuckets[entry.bucket]) this.frameBuckets[entry.bucket].push(entry);
        if (entry.bucket === 'opaque') this.debugStats.opaqueCount += 1;
        else if (entry.bucket === 'cutout') this.debugStats.cutoutCount += 1;
        else if (entry.bucket === 'transparent') this.debugStats.transparentCount += 1;
        else if (entry.bucket === 'additive') this.debugStats.additiveCount += 1;
        else if (entry.bucket === 'overlay') this.debugStats.overlayCount += 1;
        if (entry.isTransparentBucket) {
          if (entry.renderClass === 'building') this.debugStats.alphaBuildingCount += 1;
          else if (entry.renderClass === 'underwater') this.debugStats.alphaUnderwaterCount += 1;
          else this.debugStats.alphaEntityCount += 1;
          this.activeTransparentEntries.push(entry);
          if (entry.bucket === 'transparent') transparent.push(entry);
          else if (entry.bucket === 'additive') additive.push(entry);
          else overlay.push(entry);
        } else {
          this.activeOpaqueEntries.push(entry);
        }
      }
    }
    this.debugStats.prepareBucketBindMs = profileEnabled ? (performance.now() - bucketBindStartMs) : 0;

    const transparentOrderStartMs = profileEnabled ? performance.now() : 0;
    for (const entry of this.activeOpaqueEntries) {
      entry.distanceSq = Number.POSITIVE_INFINITY;
      if (entry.mesh.renderOrder !== entry.baseOrder) entry.mesh.renderOrder = entry.baseOrder;
    }
    if (!hasPreparedFrameBuckets) {
      for (const entry of this.activeTransparentEntries) {
        const worldMatrix = entry.mesh.matrixWorld.elements;
        const dx = camera.position.x - worldMatrix[12];
        const dy = camera.position.y - worldMatrix[13];
        const dz = camera.position.z - worldMatrix[14];
        entry.distanceSq = (dx * dx) + (dy * dy) + (dz * dz) + entry.sortBias;
      }

      const farToNear = (a, b) => {
        if (a.renderClassOrder !== b.renderClassOrder) return a.renderClassOrder - b.renderClassOrder;
        return b.distanceSq - a.distanceSq;
      };
      transparent.sort(farToNear);
      additive.sort(farToNear);
      overlay.sort(farToNear);
    }

    transparent.forEach((entry, index) => {
      const nextOrder = entry.baseOrder + (entry.renderClassOrder * 10000) + index;
      if (entry.mesh.renderOrder !== nextOrder) entry.mesh.renderOrder = nextOrder;
    });
    additive.forEach((entry, index) => {
      const nextOrder = entry.baseOrder + (entry.renderClassOrder * 10000) + index;
      if (entry.mesh.renderOrder !== nextOrder) entry.mesh.renderOrder = nextOrder;
    });
    overlay.forEach((entry, index) => {
      const nextOrder = entry.baseOrder + (entry.renderClassOrder * 10000) + index;
      if (entry.mesh.renderOrder !== nextOrder) entry.mesh.renderOrder = nextOrder;
    });
    if (frameVisibility?.computed === true) {
      this.lastPreparedQueueVersion = Number.isFinite(Number(frameVisibility.queueVersion))
        ? Number(frameVisibility.queueVersion)
        : (Number(frameVisibility.version) || 0);
      this.lastPreparedCameraPosition.copy(camera.position);
      this.lastPreparedCameraQuaternion.copy(camera.quaternion);
    }
    this.debugStats.prepareTransparentOrderApplyMs = profileEnabled ? (performance.now() - transparentOrderStartMs) : 0;
    this.debugStats.prepareCpuMs = profileEnabled ? (performance.now() - prepareStartMs) : 0;
  }

  renderOpaque(renderer, camera, options = {}) {
    if (!renderer || !camera || this.activeOpaqueEntries.length === 0) return;
    const allowedBuckets = new Set(Array.isArray(options.allowedBuckets) ? options.allowedBuckets : ['opaque', 'cutout']);
    const sourceScene = options.scene || this.root?.parent || null;
    if (!sourceScene?.isScene) return;
    this.pushCameraBucketMask(camera, allowedBuckets);
    try {
      renderer.render(sourceScene, camera);
    } finally {
      this.popCameraBucketMask(camera);
    }
  }

  renderTransparent(renderer, camera, options = {}) {
    if (!renderer || !camera || this.activeTransparentEntries.length === 0) return;
    const allowedBuckets = new Set(Array.isArray(options.allowedBuckets) ? options.allowedBuckets : ['transparent', 'additive', 'overlay']);
    const sourceScene = options.scene || this.root?.parent || null;
    if (!sourceScene?.isScene) return;
    this.pushCameraBucketMask(camera, allowedBuckets);
    try {
      renderer.render(sourceScene, camera);
    } finally {
      this.popCameraBucketMask(camera);
    }
  }

  pushCameraBucketMask(camera, allowedBuckets, options = {}) {
    if (!camera) return;
    this.cameraMaskStack.push(camera.layers.mask);
    camera.layers.disableAll();
    if (options.preserveDefaultLayer === true) camera.layers.enable(0);
    for (const bucket of allowedBuckets) {
      const layer = BUCKET_LAYERS[bucket];
      if (Number.isInteger(layer)) camera.layers.enable(layer);
    }
  }

  popCameraBucketMask(camera) {
    if (!camera) return;
    const mask = this.cameraMaskStack.pop();
    if (mask === undefined) return;
    camera.layers.mask = mask;
  }
}
