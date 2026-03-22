import * as THREE from 'three';

const OVERLAY_MATERIAL = new THREE.MeshBasicMaterial({
  color: new THREE.Color(1, 0.1, 0.1),
  transparent: true,
  opacity: 0.45,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
  fog: false,
  toneMapped: false,
});

export function getSelectableRootFromObject(object3D) {
  let cursor = object3D || null;
  while (cursor) {
    if (cursor.userData?.selectableRoot) return cursor;
    cursor = cursor.parent;
  }
  return null;
}

export function applyObjectSelectionHighlight(root) {
  if (!root) return;
  root.traverse((node) => {
    if (!node.isMesh) return;
    if (node.userData?.rwIsSelectionOverlay) return;
    if (node.userData?.rwSelectionOverlay) return;

    const overlay = new THREE.Mesh(node.geometry, OVERLAY_MATERIAL);
    overlay.name = `${node.name || 'mesh'}__selection_overlay`;
    overlay.userData = {
      ...(overlay.userData || {}),
      rwIsSelectionOverlay: true,
    };
    overlay.frustumCulled = node.frustumCulled;
    overlay.renderOrder = Math.max(node.renderOrder || 0, 9998);
    overlay.matrixAutoUpdate = false;
    overlay.matrix.identity();
    overlay.raycast = () => {};

    node.add(overlay);
    node.userData = {
      ...(node.userData || {}),
      rwSelectionOverlay: overlay,
    };
  });
  if (root.userData) delete root.userData.rwQueueMeshes;
}

export function clearObjectSelectionHighlight(root) {
  if (!root) return;
  root.traverse((node) => {
    if (!node.isMesh) return;
    if (node.userData?.rwIsSelectionOverlay) return;
    const overlay = node.userData?.rwSelectionOverlay;
    if (!overlay) return;
    node.remove(overlay);
    delete node.userData.rwSelectionOverlay;
  });
  if (root.userData) delete root.userData.rwQueueMeshes;
}
