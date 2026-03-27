export function inspectSkeletonHierarchy(root) {
  const bones = [];
  const frames = [];
  const bonesByName = new Map();
  const bonesByNodeId = new Map();
  const framesByName = new Map();
  let skinnedMeshCount = 0;
  let skeletonCount = 0;
  let meshCount = 0;

  root?.traverse?.((node) => {
    if (!node?.isObject3D) return;
    frames.push(node);
    const nodeName = String(node.name || '').trim();
    if (nodeName && !framesByName.has(nodeName)) {
      framesByName.set(nodeName, node);
    }
    if (node.isSkinnedMesh) {
      skinnedMeshCount += 1;
      if (node.skeleton) skeletonCount += 1;
    }
    if (node.isMesh) {
      meshCount += 1;
    }
    if (!node.isBone) return;
    bones.push(node);
    if (nodeName && !bonesByName.has(nodeName)) {
      bonesByName.set(nodeName, node);
    }
    if (Number.isInteger(node.userData?.nodeId) && !bonesByNodeId.has(node.userData.nodeId)) {
      bonesByNodeId.set(node.userData.nodeId, node);
    }
  });

  const attachmentTargets = [];
  const seenTargets = new Set();
  const addTarget = (type, node, label, extra = {}) => {
    if (!node?.isObject3D) return;
    const key = `${type}:${label}`;
    if (!label || seenTargets.has(key)) return;
    seenTargets.add(key);
    attachmentTargets.push({
      type,
      name: label,
      label: `${type === 'bone' ? 'Bone' : 'Frame'}: ${label}`,
      nodeId: Number.isInteger(node.userData?.nodeId) ? node.userData.nodeId : null,
      ...extra,
    });
  };

  for (const bone of bones) {
    addTarget('bone', bone, String(bone.name || '').trim(), {
      nodeIndex: Number.isInteger(bone.userData?.nodeIndex) ? bone.userData.nodeIndex : null,
    });
  }
  for (const frame of frames) {
    const frameName = String(frame.name || '').trim();
    if (!frameName) continue;
    addTarget('frame', frame, frameName);
  }

  return {
    root,
    bones,
    frames,
    bonesByName,
    bonesByNodeId,
    framesByName,
    attachmentTargets,
    boneCount: bones.length,
    frameCount: frames.length,
    meshCount,
    skinnedMeshCount,
    skeletonCount,
  };
}

export function findAttachmentTarget(skeletonInfo, type, nameOrNodeId) {
  if (!skeletonInfo) return null;
  if (type === 'bone') {
    if (Number.isInteger(nameOrNodeId)) {
      return skeletonInfo.bonesByNodeId.get(nameOrNodeId) || null;
    }
    const normalizedName = String(nameOrNodeId || '').trim();
    if (normalizedName && skeletonInfo.bonesByName.has(normalizedName)) {
      return skeletonInfo.bonesByName.get(normalizedName) || null;
    }
  }

  const normalizedFrameName = String(nameOrNodeId || '').trim();
  if (normalizedFrameName && skeletonInfo.framesByName.has(normalizedFrameName)) {
    return skeletonInfo.framesByName.get(normalizedFrameName) || null;
  }

  return null;
}
