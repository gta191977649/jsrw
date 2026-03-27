import * as THREE from 'three';

const ANP3_FRAME_RATE = 60;

class IfpReader {
  constructor(arrayBuffer) {
    this.view = new DataView(arrayBuffer);
    this.offset = 0;
    this.decoder = new TextDecoder('ascii');
  }

  tell() {
    return this.offset;
  }

  seek(bytes) {
    this.offset += Math.max(0, Number(bytes) || 0);
  }

  readUint8() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readInt16() {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readInt32() {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readUint32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readFloat32() {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readFixedString(length) {
    const bytes = [];
    for (let index = 0; index < length; index += 1) {
      const byte = this.readUint8();
      if (byte === 0) {
        for (let skip = index + 1; skip < length; skip += 1) this.readUint8();
        break;
      }
      bytes.push(byte);
    }
    return this.decoder.decode(new Uint8Array(bytes));
  }

  readSizedString(length) {
    const bytes = new Uint8Array(this.view.buffer, this.offset, length);
    let end = bytes.indexOf(0);
    if (end < 0) end = length;
    this.offset += length;
    return this.decoder.decode(bytes.slice(0, end));
  }
}

function clampFinite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeQuaternionValues(values = []) {
  const quaternion = new THREE.Quaternion(
    clampFinite(values[0]),
    clampFinite(values[1]),
    clampFinite(values[2]),
    clampFinite(values[3], 1),
  );
  if (quaternion.lengthSq() <= Number.EPSILON) {
    quaternion.set(0, 0, 0, 1);
  } else {
    quaternion.normalize();
  }
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function createIfpKeyframe(timeSeconds, rotation, translation = [0, 0, 0], scale = [1, 1, 1]) {
  return {
    time: Math.max(0, clampFinite(timeSeconds)),
    rotation: normalizeQuaternionValues(rotation),
    translation: [
      clampFinite(translation[0]),
      clampFinite(translation[1]),
      clampFinite(translation[2]),
    ],
    scale: [
      clampFinite(scale[0], 1),
      clampFinite(scale[1], 1),
      clampFinite(scale[2], 1),
    ],
  };
}

function createIfpBoneTrack({
  name = '',
  keyframeType = 'K000',
  useBoneId = false,
  boneId = -1,
  siblingX = 0,
  siblingY = 0,
  keyframes = [],
}) {
  return {
    name: String(name || '').trim(),
    keyframeType,
    useBoneId: Boolean(useBoneId),
    boneId: Number.isInteger(boneId) ? boneId : -1,
    siblingX: clampFinite(siblingX),
    siblingY: clampFinite(siblingY),
    keyframes: Array.isArray(keyframes) ? keyframes : [],
  };
}

function createIfpAnimation(version, name, bones = [], frameRate = ANP3_FRAME_RATE) {
  const durationSeconds = bones.reduce((maxDuration, bone) => (
    Math.max(maxDuration, Number(bone.keyframes.at(-1)?.time) || 0)
  ), 0);
  return {
    version,
    name: String(name || '').trim(),
    frameRate,
    durationSeconds,
    bones,
  };
}

function readAnp3Bone(reader) {
  const name = reader.readFixedString(24);
  const keyframeType = reader.readUint32() === 4 ? 'KRT0' : 'KR00';
  const keyframeCount = reader.readUint32();
  const boneId = reader.readInt32();
  const keyframes = [];
  for (let index = 0; index < keyframeCount; index += 1) {
    const qx = reader.readInt16() / 4096;
    const qy = reader.readInt16() / 4096;
    const qz = reader.readInt16() / 4096;
    const qw = reader.readInt16() / 4096;
    const timeFrames = reader.readInt16();
    let px = 0;
    let py = 0;
    let pz = 0;
    if (keyframeType[2] === 'T') {
      px = reader.readInt16() / 1024;
      py = reader.readInt16() / 1024;
      pz = reader.readInt16() / 1024;
    }
    keyframes.push(createIfpKeyframe(
      timeFrames / ANP3_FRAME_RATE,
      [qx, qy, qz, qw],
      [px, py, pz],
    ));
  }
  return createIfpBoneTrack({
    name,
    keyframeType,
    useBoneId: true,
    boneId,
    keyframes,
  });
}

function readAnp3Animation(reader) {
  const name = reader.readFixedString(24);
  const boneCount = reader.readUint32();
  reader.readUint32();
  reader.readUint32();
  const bones = [];
  for (let index = 0; index < boneCount; index += 1) {
    bones.push(readAnp3Bone(reader));
  }
  return createIfpAnimation('ANP3', name, bones, ANP3_FRAME_RATE);
}

function readAnp3Archive(reader) {
  reader.readUint32();
  const name = reader.readFixedString(24);
  const animationCount = reader.readUint32();
  const animations = [];
  for (let index = 0; index < animationCount; index += 1) {
    animations.push(readAnp3Animation(reader));
  }
  return {
    version: 'ANP3',
    name,
    frameRate: ANP3_FRAME_RATE,
    animations,
  };
}

function readAnpkBone(reader) {
  reader.readFixedString(4);
  reader.readUint32();
  reader.readFixedString(4);
  const animationInfoLength = reader.readUint32();
  const name = reader.readSizedString(28);
  const keyframeCount = reader.readUint32();
  reader.seek(8);

  let useBoneId = false;
  let boneId = -1;
  let siblingX = 0;
  let siblingY = 0;
  if (animationInfoLength === 44) {
    boneId = reader.readInt32();
    useBoneId = true;
  } else {
    siblingX = reader.readInt32();
    siblingY = reader.readInt32();
  }

  let keyframeType = 'K000';
  const keyframes = [];
  if (keyframeCount > 0) {
    keyframeType = reader.readFixedString(4);
    reader.readUint32();
    for (let index = 0; index < keyframeCount; index += 1) {
      const qx = reader.readFloat32();
      const qy = reader.readFloat32();
      const qz = reader.readFloat32();
      const qw = reader.readFloat32();
      let px = 0;
      let py = 0;
      let pz = 0;
      if (keyframeType[2] === 'T') {
        px = reader.readFloat32();
        py = reader.readFloat32();
        pz = reader.readFloat32();
      }
      let sx = 1;
      let sy = 1;
      let sz = 1;
      if (keyframeType[3] === 'S') {
        sx = reader.readFloat32();
        sy = reader.readFloat32();
        sz = reader.readFloat32();
      }
      const timeSeconds = reader.readFloat32();
      const quaternion = new THREE.Quaternion(qx, qy, qz, qw).conjugate();
      keyframes.push(createIfpKeyframe(
        timeSeconds,
        [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
        [px, py, pz],
        [sx, sy, sz],
      ));
    }
  }

  return createIfpBoneTrack({
    name,
    keyframeType,
    useBoneId,
    boneId,
    siblingX,
    siblingY,
    keyframes,
  });
}

function readAnpkAnimation(reader) {
  reader.readFixedString(4);
  const nameLength = reader.readUint32();
  const name = reader.readSizedString(nameLength);
  const nameAlignment = (4 - (nameLength % 4)) % 4;
  reader.seek(nameAlignment);
  reader.readFixedString(4);
  reader.readUint32();
  reader.readFixedString(4);
  const infoSize = reader.readUint32();
  const boneCount = reader.readUint32();
  reader.seek(Math.max(0, infoSize - 4));
  const bones = [];
  for (let index = 0; index < boneCount; index += 1) {
    bones.push(readAnpkBone(reader));
  }
  return createIfpAnimation('ANPK', name, bones, 1);
}

function readAnpkArchive(reader) {
  reader.readUint32();
  reader.readFixedString(4);
  const infoLength = reader.readUint32();
  const animationCount = reader.readUint32();
  const name = reader.readSizedString(Math.max(0, infoLength - 4));
  const alignment = (4 - (infoLength % 4)) % 4;
  reader.seek(alignment);
  const animations = [];
  for (let index = 0; index < animationCount; index += 1) {
    animations.push(readAnpkAnimation(reader));
  }
  return {
    version: 'ANPK',
    name,
    frameRate: 1,
    animations,
  };
}

export class IFPLoader {
  parse(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer)) {
      throw new Error('IFPLoader.parse expects an ArrayBuffer');
    }
    const reader = new IfpReader(arrayBuffer);
    const version = reader.readFixedString(4);
    if (version === 'ANP3') return readAnp3Archive(reader);
    if (version === 'ANPK') return readAnpkArchive(reader);
    throw new Error(`Unsupported IFP version: ${version}`);
  }

  async load(source) {
    if (source instanceof ArrayBuffer) return this.parse(source);
    if (source?.arrayBuffer instanceof Function) {
      return this.parse(await source.arrayBuffer());
    }
    if (source?.file?.arrayBuffer instanceof Function) {
      return this.parse(await source.file.arrayBuffer());
    }
    throw new Error('IFPLoader.load expects an ArrayBuffer, Blob/File, or file record');
  }
}

export default IFPLoader;
