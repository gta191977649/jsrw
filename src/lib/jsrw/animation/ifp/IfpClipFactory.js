import * as THREE from 'three';
import { gtaPositionToThree } from '../../utils/gtaTransforms.js';

function createBindingPath(target) {
  return String(target?.uuid || '').trim();
}

function clampTimeValue(value) {
  return Math.max(0, Number(value) || 0);
}

function ensureTimes(keyframes = []) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return [0];
  return keyframes.map((keyframe) => clampTimeValue(keyframe?.time));
}

function ensureQuaternionValues(keyframes = []) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return [0, 0, 0, 1];
  const values = [];
  let previous = null;
  for (const keyframe of keyframes) {
    const rotation = Array.isArray(keyframe?.rotation) ? keyframe.rotation : [0, 0, 0, 1];
    const quaternion = new THREE.Quaternion(
      Number(rotation[0]) || 0,
      Number(rotation[1]) || 0,
      Number(rotation[2]) || 0,
      Number(rotation[3]) || 1,
    );
    if (quaternion.lengthSq() <= Number.EPSILON) quaternion.set(0, 0, 0, 1);
    else quaternion.normalize();
    // Match RenderWare anim blending: keep quaternion signs continuous so
    // slerp does not take the long path on fast-moving limbs.
    if (previous && previous.dot(quaternion) < 0) {
      quaternion.multiplyScalar(-1);
    }
    values.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    previous = quaternion.clone();
  }
  return values;
}

function toVector3Array(value, fallback = [0, 0, 0]) {
  const source = Array.isArray(value) ? value : fallback;
  return [
    Number(source[0]) || 0,
    Number(source[1]) || 0,
    Number(source[2]) || 0,
  ];
}

function ensureVectorValues(keyframes = [], property = 'translation') {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return [0, 0, 0];
  return keyframes.flatMap((keyframe) => {
    return toVector3Array(keyframe?.[property]);
  });
}

function createRootMotionTrack(boneTrack) {
  if (!boneTrack?.keyframeType?.includes?.('T') || !Array.isArray(boneTrack.keyframes) || boneTrack.keyframes.length === 0) {
    return null;
  }
  return {
    name: String(boneTrack.name || '').trim(),
    boneId: Number.isInteger(boneTrack.boneId) ? boneTrack.boneId : -1,
    keyframes: boneTrack.keyframes.map((keyframe) => ({
      time: clampTimeValue(keyframe?.time),
      translation: Array.isArray(keyframe?.translation) ? [...keyframe.translation] : [0, 0, 0],
    })),
  };
}

function selectAnimationTarget(skeletonInfo, boneTrack) {
  const trackName = String(boneTrack?.name || '').trim();
  if (trackName && skeletonInfo?.bonesByName?.has?.(trackName)) {
    return skeletonInfo.bonesByName.get(trackName);
  }
  if (trackName && skeletonInfo?.framesByName?.has?.(trackName)) {
    return skeletonInfo.framesByName.get(trackName);
  }
  if (Number.isInteger(boneTrack?.boneId) && skeletonInfo?.bonesByNodeId?.has?.(boneTrack.boneId)) {
    return skeletonInfo.bonesByNodeId.get(boneTrack.boneId);
  }
  return null;
}

function isSuspiciousLeadTranslation(firstTranslation, secondTranslation, restTranslation) {
  const first = new THREE.Vector3(...toVector3Array(firstTranslation));
  const second = new THREE.Vector3(...toVector3Array(secondTranslation));
  const rest = new THREE.Vector3(...toVector3Array(restTranslation));
  if (first.distanceTo(second) < 4.0) return false;
  if (Math.max(second.length(), rest.length()) > 1.0) return false;
  const delta = first.clone().sub(second);
  const flaggedAxisCount = ['x', 'y', 'z'].reduce((count, axis) => (
    count + (Math.abs(Math.abs(delta[axis]) - 10.0) < 0.35 ? 1 : 0)
  ), 0);
  return flaggedAxisCount >= 2 || first.length() > 8.0;
}

function sanitizeTranslationKeyframes(boneTrack, target, isRootTrack = false) {
  if (isRootTrack || !boneTrack?.keyframeType?.includes?.('T') || !Array.isArray(boneTrack.keyframes)) {
    return Array.isArray(boneTrack?.keyframes) ? boneTrack.keyframes : [];
  }
  const sanitized = boneTrack.keyframes.map((keyframe) => ({
    ...keyframe,
    translation: toVector3Array(keyframe?.translation),
  }));
  if (sanitized.length < 2) return sanitized;

  const restTranslation = target?.position?.toArray?.() || [0, 0, 0];
  if (!isSuspiciousLeadTranslation(sanitized[0].translation, sanitized[1].translation, restTranslation)) {
    return sanitized;
  }

  sanitized[0] = {
    ...sanitized[0],
    translation: [...sanitized[1].translation],
  };
  return sanitized;
}

export function createIfpAnimationClip(animation, skeletonInfo) {
  if (!animation || !skeletonInfo) return null;
  const tracks = [];
  let rootMotion = null;
  let matchedTrackCount = 0;

  const rootBone = skeletonInfo.bones[0] || null;
  const rootBoneName = String(rootBone?.name || '').trim();
  const rootBoneNodeId = Number.isInteger(rootBone?.userData?.nodeId) ? rootBone.userData.nodeId : null;

  for (const boneTrack of animation.bones || []) {
    const target = selectAnimationTarget(skeletonInfo, boneTrack);
    if (!target) continue;
    matchedTrackCount += 1;
    const bindingPath = createBindingPath(target);
    if (!bindingPath) continue;

    const isRootTrack = (
      (rootBoneName && String(boneTrack?.name || '').trim() === rootBoneName)
      || (rootBoneNodeId !== null && boneTrack?.boneId === rootBoneNodeId)
    );
    const effectiveKeyframes = sanitizeTranslationKeyframes(boneTrack, target, isRootTrack);

    tracks.push(new THREE.QuaternionKeyframeTrack(
      `${bindingPath}.quaternion`,
      ensureTimes(effectiveKeyframes),
      ensureQuaternionValues(effectiveKeyframes),
    ));

    if (boneTrack?.keyframeType?.includes?.('S')) {
      tracks.push(new THREE.VectorKeyframeTrack(
        `${bindingPath}.scale`,
        ensureTimes(effectiveKeyframes),
        ensureVectorValues(effectiveKeyframes, 'scale'),
      ));
    }

    if (boneTrack?.keyframeType?.includes?.('T')) {
      if (isRootTrack && !rootMotion) {
        rootMotion = createRootMotionTrack(boneTrack);
      } else {
        tracks.push(new THREE.VectorKeyframeTrack(
          `${bindingPath}.position`,
          ensureTimes(effectiveKeyframes),
          ensureVectorValues(effectiveKeyframes, 'translation'),
        ));
      }
    }
  }

  return {
    clip: new THREE.AnimationClip(
      String(animation.name || 'ifp_anim'),
      Math.max(0, Number(animation.durationSeconds) || 0),
      tracks,
    ),
    matchedTrackCount,
    rootMotion,
  };
}

export function sampleRootMotion(rootMotion, timeSeconds = 0) {
  if (!rootMotion?.keyframes?.length) {
    return new THREE.Vector3(0, 0, 0);
  }
  const clampedTime = Math.max(0, Number(timeSeconds) || 0);
  const first = rootMotion.keyframes[0];
  const last = rootMotion.keyframes.at(-1);
  if (clampedTime <= first.time) {
    return new THREE.Vector3(...first.translation);
  }
  if (clampedTime >= last.time) {
    return new THREE.Vector3(...last.translation);
  }
  for (let index = 1; index < rootMotion.keyframes.length; index += 1) {
    const previous = rootMotion.keyframes[index - 1];
    const next = rootMotion.keyframes[index];
    if (clampedTime > next.time) continue;
    const span = Math.max(Number.EPSILON, next.time - previous.time);
    const alpha = THREE.MathUtils.clamp((clampedTime - previous.time) / span, 0, 1);
    return new THREE.Vector3(
      THREE.MathUtils.lerp(previous.translation[0], next.translation[0], alpha),
      THREE.MathUtils.lerp(previous.translation[1], next.translation[1], alpha),
      THREE.MathUtils.lerp(previous.translation[2], next.translation[2], alpha),
    );
  }
  return new THREE.Vector3(...last.translation);
}

export function rootMotionToThreeOffset(vector) {
  return gtaPositionToThree(vector?.x || 0, vector?.y || 0, vector?.z || 0);
}
