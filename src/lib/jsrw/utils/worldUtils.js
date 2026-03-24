import * as THREE from 'three';
import { getRWMaterialDescriptor } from '../adapters/three/ThreeMaterialAdapter.js';

export const WORLD_CHUNK_SIZE = 256;

export function applyWireframe(root, enabled) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (material) material.wireframe = enabled;
    }
  });
}

export function applyDoubleSided(root) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) continue;
      material.side = THREE.DoubleSide;
      material.needsUpdate = true;
    }
  });
}

export function applyGlobalBackfaceCulling(root, disableBackfaceCulling) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) continue;
      if (material.userData?.rwBaseSide === undefined) {
        material.userData = {
          ...(material.userData || {}),
          rwBaseSide: material.side,
        };
      }
      const descriptor = getRWMaterialDescriptor(material);
      const forceDoubleSided = disableBackfaceCulling || descriptor?.rwFlags?.disableBackfaceCulling === true;
      if (forceDoubleSided) {
        material.side = THREE.DoubleSide;
      } else {
        const descriptorSide = descriptor?.side;
        material.side = descriptorSide ?? material.userData?.rwBaseSide ?? THREE.FrontSide;
      }
      material.needsUpdate = true;
    }
  });
}

export function applyWaterVisibility(root, enabled) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    if (!node.userData?.water) return;
    node.visible = Boolean(enabled);
  });
}

export function disposeWorld(root) {
  const disposable = [];
  root.traverse((node) => {
    if (node.isMesh) {
      if (node.geometry) disposable.push(node.geometry);
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) {
        if (mat) disposable.push(mat);
      }
    }
  });

  for (const item of disposable) {
    if (typeof item.dispose === 'function') item.dispose();
  }

  root.clear();
}

function normalizeAssetKeyPart(value = '') {
  const normalized = String(value || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .split('/')
    .pop()
    ?.toLowerCase() || '';
  const extensionIndex = normalized.lastIndexOf('.');
  return extensionIndex >= 0 ? normalized.slice(0, extensionIndex) : normalized;
}

export function makeAssetKey(modelName, txdName) {
  return `${normalizeAssetKeyPart(modelName)}|${normalizeAssetKeyPart(txdName || '')}`;
}

export function getChunkKeyFromPosition(position) {
  const cx = Math.floor(position.x / WORLD_CHUNK_SIZE);
  const cz = Math.floor(position.z / WORLD_CHUNK_SIZE);
  return `${cx},${cz}`;
}

export function getChunkCenterFromKey(chunkKey) {
  const [cxText, czText] = chunkKey.split(',');
  const cx = Number.parseInt(cxText, 10) || 0;
  const cz = Number.parseInt(czText, 10) || 0;
  return new THREE.Vector3(
    (cx + 0.5) * WORLD_CHUNK_SIZE,
    0,
    (cz + 0.5) * WORLD_CHUNK_SIZE,
  );
}
