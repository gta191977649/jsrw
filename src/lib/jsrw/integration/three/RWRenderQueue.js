import * as THREE from 'three';
import { getRWMaterialDescriptor } from '../../adapters/three/ThreeMaterialAdapter.js';

const BUCKET_LAYERS = {
  opaque: 1,
  cutout: 2,
  transparent: 3,
  additive: 4,
  overlay: 5,
};

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
    this.entryByMesh = new WeakMap();
    this.tempProjScreenMatrix = new THREE.Matrix4();
    this.tempFrustum = new THREE.Frustum();
    this.tempSphere = new THREE.Sphere();
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
    this.entryByMesh = new WeakMap();
    this.activeOpaqueEntries = [];
    this.activeTransparentEntries = [];
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
      };
      this.entries.push(entry);
      this.entryByMesh.set(node, entry);
    });

    this.dirty = false;
  }

  getEntriesForFrame(frameVisibility) {
    if (frameVisibility?.computed !== true) return this.entries;
    const meshes = Array.isArray(frameVisibility?.visibleQueueMeshes) ? frameVisibility.visibleQueueMeshes : [];
    const visibleEntries = [];
    const seen = new Set();
    for (const mesh of meshes) {
      const entry = this.entryByMesh.get(mesh);
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      visibleEntries.push(entry);
    }
    for (const entry of this.entries) {
      if (!isPersistentOverlayEntry(entry) || seen.has(entry)) continue;
      seen.add(entry);
      visibleEntries.push(entry);
    }
    return visibleEntries;
  }

  prepareFrame(camera, frameVisibility = null) {
    if (this.dirty) this.rebuild();
    if (camera?.projectionMatrix && camera?.matrixWorldInverse) {
      this.tempProjScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.tempFrustum.setFromProjectionMatrix(this.tempProjScreenMatrix);
    }

    const transparent = [];
    const additive = [];
    const overlay = [];
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
    const sourceEntries = this.getEntriesForFrame(frameVisibility);
    const useFrameVisibility = frameVisibility?.computed === true;
    for (const entry of sourceEntries) {
      const { mesh } = entry;
      if (!isVisibleInWorld(mesh, this.root)) continue;
      if (!useFrameVisibility && camera && mesh.frustumCulled !== false && mesh.geometry) {
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
      if (entry.bucket === 'transparent' || entry.bucket === 'additive' || entry.bucket === 'overlay') {
        if (entry.renderClass === 'building') this.debugStats.alphaBuildingCount += 1;
        else if (entry.renderClass === 'underwater') this.debugStats.alphaUnderwaterCount += 1;
        else this.debugStats.alphaEntityCount += 1;
      }
      setMeshBucketLayer(mesh, entry.bucket);
      if (entry.bucket === 'transparent' || entry.bucket === 'additive' || entry.bucket === 'overlay') {
        const worldMatrix = mesh.matrixWorld.elements;
        const dx = camera.position.x - worldMatrix[12];
        const dy = camera.position.y - worldMatrix[13];
        const dz = camera.position.z - worldMatrix[14];
        entry.distanceSq = (dx * dx) + (dy * dy) + (dz * dz) + entry.sortBias;
        this.activeTransparentEntries.push(entry);
        if (entry.bucket === 'transparent') transparent.push(entry);
        else if (entry.bucket === 'additive') additive.push(entry);
        else overlay.push(entry);
      } else {
        entry.distanceSq = Number.POSITIVE_INFINITY;
        mesh.renderOrder = entry.baseOrder;
        this.activeOpaqueEntries.push(entry);
      }
    }

    const farToNear = (a, b) => {
      if (a.renderClassOrder !== b.renderClassOrder) return a.renderClassOrder - b.renderClassOrder;
      return b.distanceSq - a.distanceSq;
    };
    transparent.sort(farToNear);
    additive.sort(farToNear);
    overlay.sort(farToNear);

    transparent.forEach((entry, index) => {
      entry.mesh.renderOrder = entry.baseOrder + (entry.renderClassOrder * 10000) + index;
    });
    additive.forEach((entry, index) => {
      entry.mesh.renderOrder = entry.baseOrder + (entry.renderClassOrder * 10000) + index;
    });
    overlay.forEach((entry, index) => {
      entry.mesh.renderOrder = entry.baseOrder + (entry.renderClassOrder * 10000) + index;
    });
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
