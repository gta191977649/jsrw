import * as THREE from 'three';
import { getRWMaterialDescriptor } from './RWRender';

const BUCKET_LAYERS = {
  opaque: 1,
  cutout: 2,
  transparent: 3,
  additive: 4,
  overlay: 5,
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

function isVisibleInWorld(mesh, stopAt) {
  let cursor = mesh;
  while (cursor) {
    if (cursor.visible === false) return false;
    if (cursor === stopAt) break;
    cursor = cursor.parent;
  }
  return true;
}

export class RWRenderQueue {
  constructor(root) {
    this.root = root;
    this.entries = [];
    this.tempWorldPos = new THREE.Vector3();
    this.frameBuckets = {
      opaque: [],
      cutout: [],
      transparent: [],
      additive: [],
      overlay: [],
    };
    this.cameraMaskStack = [];
    this.dirty = true;
  }

  markDirty() {
    this.dirty = true;
  }

  rebuild(root = this.root) {
    this.root = root;
    this.entries = [];
    if (!root) {
      this.dirty = false;
      return;
    }

    root.traverse((node) => {
      if (!node.isMesh) return;
      this.entries.push({
        mesh: node,
        bucket: 'opaque',
        distanceSq: Number.POSITIVE_INFINITY,
      });
    });

    this.dirty = false;
  }

  prepareFrame(camera) {
    if (this.dirty) this.rebuild();

    const transparent = [];
    const additive = [];
    const overlay = [];
    this.frameBuckets.opaque = [];
    this.frameBuckets.cutout = [];
    this.frameBuckets.transparent = [];
    this.frameBuckets.additive = [];
    this.frameBuckets.overlay = [];

    for (const entry of this.entries) {
      const { mesh } = entry;
      if (!isVisibleInWorld(mesh, this.root)) continue;

      entry.bucket = getMeshBucket(mesh);
      if (this.frameBuckets[entry.bucket]) this.frameBuckets[entry.bucket].push(entry);
      const layer = BUCKET_LAYERS[entry.bucket] ?? 0;
      mesh.layers.set(layer);
      if (entry.bucket === 'transparent' || entry.bucket === 'additive' || entry.bucket === 'overlay') {
        mesh.getWorldPosition(this.tempWorldPos);
        entry.distanceSq = camera.position.distanceToSquared(this.tempWorldPos);
        if (entry.bucket === 'transparent') transparent.push(entry);
        else if (entry.bucket === 'additive') additive.push(entry);
        else overlay.push(entry);
      } else {
        entry.distanceSq = Number.POSITIVE_INFINITY;
        mesh.renderOrder = getBucketBaseOrder(entry.bucket);
      }
    }

    const farToNear = (a, b) => b.distanceSq - a.distanceSq;
    transparent.sort(farToNear);
    additive.sort(farToNear);
    overlay.sort(farToNear);

    transparent.forEach((entry, index) => {
      entry.mesh.renderOrder = getBucketBaseOrder('transparent') + index;
    });
    additive.forEach((entry, index) => {
      entry.mesh.renderOrder = getBucketBaseOrder('additive') + index;
    });
    overlay.forEach((entry, index) => {
      entry.mesh.renderOrder = getBucketBaseOrder('overlay') + index;
    });
  }

  pushCameraBucketMask(camera, allowedBuckets) {
    if (!camera) return;
    this.cameraMaskStack.push(camera.layers.mask);
    camera.layers.disableAll();
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

