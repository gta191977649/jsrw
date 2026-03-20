import * as THREE from 'three';
import { getRWMaterialDescriptor } from '../../adapters/three/ThreeMaterialAdapter.js';

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

function setProxyDefaultLayer(object) {
  object.layers.disableAll();
  object.layers.enable(0);
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
    this.entryByMesh = new WeakMap();
    this.tempWorldPos = new THREE.Vector3();
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
    this.opaqueScene = new THREE.Scene();
    this.opaqueRoot = new THREE.Group();
    this.opaqueRoot.matrixAutoUpdate = false;
    this.opaqueRoot.matrixWorldAutoUpdate = false;
    this.opaqueScene.autoUpdate = false;
    this.opaqueScene.add(this.opaqueRoot);
    this.transparentScene = new THREE.Scene();
    this.transparentRoot = new THREE.Group();
    this.transparentRoot.matrixAutoUpdate = false;
    this.transparentRoot.matrixWorldAutoUpdate = false;
    this.transparentScene.autoUpdate = false;
    this.transparentScene.add(this.transparentRoot);
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
    this.opaqueRoot.clear();
    this.transparentRoot.clear();
    if (!root) {
      this.dirty = false;
      return;
    }

    root.traverse((node) => {
      if (!node.isMesh) return;
      const bucket = getMeshBucket(node);
      const entry = {
        mesh: node,
        bucket,
        distanceSq: Number.POSITIVE_INFINITY,
        proxy: null,
        proxyBucket: bucket,
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
    for (const mesh of meshes) {
      const entry = this.entryByMesh.get(mesh);
      if (!entry) continue;
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
    for (const entry of this.entries) {
      if (entry.proxy) entry.proxy.visible = false;
    }

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
      const layer = BUCKET_LAYERS[entry.bucket] ?? 0;
      mesh.layers.set(layer);
      if (entry.bucket === 'transparent' || entry.bucket === 'additive' || entry.bucket === 'overlay') {
        mesh.getWorldPosition(this.tempWorldPos);
        entry.distanceSq = camera.position.distanceToSquared(this.tempWorldPos);
        this.activeTransparentEntries.push(entry);
        if (entry.bucket === 'transparent') transparent.push(entry);
        else if (entry.bucket === 'additive') additive.push(entry);
        else overlay.push(entry);
      } else {
        entry.distanceSq = Number.POSITIVE_INFINITY;
        mesh.renderOrder = getBucketBaseOrder(entry.bucket);
        this.activeOpaqueEntries.push(entry);
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
    for (const entry of this.activeOpaqueEntries) {
      const proxy = this.ensureProxy(entry);
      proxy.visible = true;
      this.syncProxy(entry, proxy);
      entry.proxyBucket = entry.bucket;
    }

    for (const entry of [...transparent, ...additive, ...overlay]) {
      const proxy = this.ensureProxy(entry);
      proxy.visible = true;
      this.syncProxy(entry, proxy);
      entry.proxyBucket = entry.bucket;
    }
  }

  ensureProxy(entry) {
    if (entry?.proxy) return entry.proxy;
    const source = entry.mesh;
    const proxy = source?.isInstancedMesh
      ? new THREE.InstancedMesh(source.geometry, source.material, source.count)
      : new THREE.Mesh(source.geometry, source.material);
    proxy.name = `${entry.mesh.name || 'mesh'}__queue_proxy`;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    proxy.visible = false;
    proxy.frustumCulled = source.frustumCulled;
    setProxyDefaultLayer(proxy);
    proxy.userData = {
      ...(source.userData || {}),
      rwQueueProxy: true,
    };
    if (entry.bucket === 'opaque' || entry.bucket === 'cutout') {
      this.opaqueRoot.add(proxy);
    } else {
      this.transparentRoot.add(proxy);
    }
    entry.proxy = proxy;
    return proxy;
  }

  syncProxy(entry, proxy) {
    const source = entry.mesh;
    proxy.geometry = source.geometry;
    proxy.material = source.material;
    proxy.renderOrder = source.renderOrder;
    proxy.matrix.copy(source.matrixWorld);
    proxy.matrixWorld.copy(source.matrixWorld);
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    proxy.frustumCulled = source.frustumCulled;
    setProxyDefaultLayer(proxy);
    proxy.userData.rwQueueBucket = entry.bucket;
    if (source.isInstancedMesh && proxy.isInstancedMesh) {
      proxy.count = source.count;
      proxy.instanceMatrix = source.instanceMatrix;
      proxy.instanceColor = source.instanceColor || null;
      proxy.morphTexture = source.morphTexture || null;
      if (proxy.boundingBox !== source.boundingBox) proxy.boundingBox = source.boundingBox;
      if (proxy.boundingSphere !== source.boundingSphere) proxy.boundingSphere = source.boundingSphere;
    }
  }

  renderOpaque(renderer, camera, options = {}) {
    if (!renderer || !camera || this.activeOpaqueEntries.length === 0) return;
    const allowedBuckets = new Set(Array.isArray(options.allowedBuckets) ? options.allowedBuckets : ['opaque', 'cutout']);
    this.opaqueScene.fog = options.fog || null;
    const activeEntries = new Set(this.activeOpaqueEntries);
    for (const entry of this.entries) {
      if (!entry.proxy) continue;
      if (entry.bucket !== 'opaque' && entry.bucket !== 'cutout') continue;
      entry.proxy.visible = activeEntries.has(entry) && allowedBuckets.has(entry.proxyBucket);
    }
    renderer.render(this.opaqueScene, camera);
  }

  renderTransparent(renderer, camera, options = {}) {
    if (!renderer || !camera || this.activeTransparentEntries.length === 0) return;
    const allowedBuckets = new Set(Array.isArray(options.allowedBuckets) ? options.allowedBuckets : ['transparent', 'additive', 'overlay']);
    this.transparentScene.fog = options.fog || null;
    const activeEntries = new Set(this.activeTransparentEntries);
    for (const entry of this.entries) {
      if (!entry.proxy) continue;
      entry.proxy.visible = activeEntries.has(entry) && allowedBuckets.has(entry.proxyBucket);
    }
    renderer.render(this.transparentScene, camera);
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
