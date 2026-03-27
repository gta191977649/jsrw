import * as THREE from 'three';
import { findAttachmentTarget } from '../skeleton/SkeletonInspector.js';

function applyAttachmentTransform(targetRoot, options = {}) {
  if (!targetRoot?.isObject3D) return;
  if (options.keepWorldTransform) return;
  targetRoot.position.copy(options.position?.isVector3 ? options.position : new THREE.Vector3(0, 0, 0));
  targetRoot.quaternion.copy(options.quaternion?.isQuaternion ? options.quaternion : new THREE.Quaternion());
  targetRoot.scale.copy(options.scale?.isVector3 ? options.scale : new THREE.Vector3(1, 1, 1));
}

export class CutsceneAttachmentRuntime {
  constructor(options = {}) {
    this.sceneRoot = options.sceneRoot || null;
    this.attachments = new Map();
  }

  setSceneRoot(sceneRoot) {
    this.sceneRoot = sceneRoot || null;
  }

  clear() {
    for (const attachment of Array.from(this.attachments.values())) {
      this.detach(attachment.childRoot);
    }
    this.attachments.clear();
  }

  attachObjectToBone(childRoot, parentActor, boneNameOrNodeId, options = {}) {
    return this.attach(childRoot, parentActor, 'bone', boneNameOrNodeId, options);
  }

  attachObjectToFrame(childRoot, parentActor, frameName, options = {}) {
    return this.attach(childRoot, parentActor, 'frame', frameName, options);
  }

  attach(childRoot, parentActor, targetType, targetNameOrNodeId, options = {}) {
    if (!childRoot?.isObject3D) {
      throw new Error('Attachment child must be a THREE.Object3D');
    }
    const target = findAttachmentTarget(parentActor?.skeletonInfo, targetType, targetNameOrNodeId);
    if (!target) {
      throw new Error(`Attachment target not found: ${targetType}:${targetNameOrNodeId}`);
    }
    this.detach(childRoot);
    target.attach(childRoot);
    applyAttachmentTransform(childRoot, options);
    const key = childRoot.uuid;
    const attachment = {
      childRoot,
      parentName: String(parentActor?.name || '').trim(),
      targetType,
      targetName: String(target.name || targetNameOrNodeId || '').trim(),
      targetNodeId: Number.isInteger(target.userData?.nodeId) ? target.userData.nodeId : null,
    };
    this.attachments.set(key, attachment);
    return attachment;
  }

  detach(childRoot) {
    if (!childRoot?.isObject3D) return null;
    const key = childRoot.uuid;
    const attachment = this.attachments.get(key) || null;
    if (!attachment) return null;
    if (this.sceneRoot?.isObject3D) {
      this.sceneRoot.attach(childRoot);
    } else if (childRoot.parent) {
      childRoot.parent.remove(childRoot);
    }
    this.attachments.delete(key);
    return attachment;
  }

  get(childRoot) {
    return this.attachments.get(childRoot?.uuid || '') || null;
  }

  list() {
    return Array.from(this.attachments.values()).map((entry) => ({ ...entry }));
  }
}
