import * as THREE from 'three';
import { RW_ALPHA_REF_DEFAULT, getRWMaterialDescriptor, syncThreeMaterialFromRW } from './RWRender';

export const RW_IDE_FLAG = Object.freeze({
  IS_ROAD: 0x1,
  DRAW_LAST: 0x4,
  ADDITIVE: 0x8,
  NO_ZBUFFER_WRITE: 0x40,
  DONT_RECEIVE_SHADOWS: 0x80,
  IS_GLASS_TYPE_1: 0x200,
  IS_GLASS_TYPE_2: 0x400,
  IS_GARAGE_DOOR: 0x800,
  IS_DAMAGABLE: 0x1000,
  IS_TREE: 0x2000,
  IS_PALM: 0x4000,
  DOES_NOT_COLLIDE_WITH_FLYER: 0x8000,
  IS_TAG: 0x100000,
  DISABLE_BACKFACE_CULLING: 0x200000,
  IS_BREAKABLE_STATUE: 0x400000,
});

const RW_IDE_FLAG_NAME = Object.freeze({
  [RW_IDE_FLAG.IS_ROAD]: 'IS_ROAD',
  [RW_IDE_FLAG.DRAW_LAST]: 'DRAW_LAST',
  [RW_IDE_FLAG.ADDITIVE]: 'ADDITIVE',
  [RW_IDE_FLAG.NO_ZBUFFER_WRITE]: 'NO_ZBUFFER_WRITE',
  [RW_IDE_FLAG.DONT_RECEIVE_SHADOWS]: 'DONT_RECEIVE_SHADOWS',
  [RW_IDE_FLAG.IS_GLASS_TYPE_1]: 'IS_GLASS_TYPE_1',
  [RW_IDE_FLAG.IS_GLASS_TYPE_2]: 'IS_GLASS_TYPE_2',
  [RW_IDE_FLAG.IS_GARAGE_DOOR]: 'IS_GARAGE_DOOR',
  [RW_IDE_FLAG.IS_DAMAGABLE]: 'IS_DAMAGABLE',
  [RW_IDE_FLAG.IS_TREE]: 'IS_TREE',
  [RW_IDE_FLAG.IS_PALM]: 'IS_PALM',
  [RW_IDE_FLAG.DOES_NOT_COLLIDE_WITH_FLYER]: 'DOES_NOT_COLLIDE_WITH_FLYER',
  [RW_IDE_FLAG.IS_TAG]: 'IS_TAG',
  [RW_IDE_FLAG.DISABLE_BACKFACE_CULLING]: 'DISABLE_BACKFACE_CULLING',
  [RW_IDE_FLAG.IS_BREAKABLE_STATUE]: 'IS_BREAKABLE_STATUE',
});

function toInt32Flags(flags) {
  return Number(flags) | 0;
}

export function hasRwIdeFlag(flags, mask) {
  return ((toInt32Flags(flags) & mask) !== 0);
}

export function decodeRwIdeFlags(flags) {
  const value = toInt32Flags(flags);
  const activeFlags = [];
  for (const [maskText, name] of Object.entries(RW_IDE_FLAG_NAME)) {
    const mask = Number(maskText);
    if ((value & mask) !== 0) activeFlags.push(name);
  }
  return {
    value,
    activeFlags,
    isRoad: hasRwIdeFlag(value, RW_IDE_FLAG.IS_ROAD),
    drawLast: hasRwIdeFlag(value, RW_IDE_FLAG.DRAW_LAST),
    additive: hasRwIdeFlag(value, RW_IDE_FLAG.ADDITIVE),
    noZWrite: hasRwIdeFlag(value, RW_IDE_FLAG.NO_ZBUFFER_WRITE),
    dontReceiveShadows: hasRwIdeFlag(value, RW_IDE_FLAG.DONT_RECEIVE_SHADOWS),
    isTree: hasRwIdeFlag(value, RW_IDE_FLAG.IS_TREE),
    isPalm: hasRwIdeFlag(value, RW_IDE_FLAG.IS_PALM),
    disableBackfaceCulling: hasRwIdeFlag(value, RW_IDE_FLAG.DISABLE_BACKFACE_CULLING),
  };
}

export function applyRwIdeFlagsToInstance(root, flags) {
  const decoded = decodeRwIdeFlags(flags);
  const isFoliage = decoded.isTree || decoded.isPalm;

  root.userData = {
    ...(root.userData || {}),
    rwIdeFlags: decoded.value,
    rwIdeFlagsDecoded: decoded,
  };

  root.traverse((node) => {
    if (!node.isMesh) return;

    if (decoded.dontReceiveShadows) {
      node.receiveShadow = false;
    }

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) continue;
      const descriptor = getRWMaterialDescriptor(material);

      if (decoded.disableBackfaceCulling) {
        if (descriptor) {
          descriptor.side = THREE.DoubleSide;
          descriptor.rwFlags.disableBackfaceCulling = true;
        } else {
          material.side = THREE.DoubleSide;
        }
      }

      if (isFoliage) {
        if (descriptor) {
          descriptor.alphaMode = 'cutout';
          descriptor.alphaRef = Math.max(descriptor.alphaRef || 0, RW_ALPHA_REF_DEFAULT);
          descriptor.transparent = false;
          descriptor.depthTest = true;
          descriptor.depthWrite = true;
          descriptor.renderBucket = 'cutout';
          descriptor.rwFlags.isFoliage = true;
        } else {
          material.transparent = false;
          material.depthTest = true;
          material.depthWrite = true;
          material.alphaTest = Math.max(material.alphaTest || 0, RW_ALPHA_REF_DEFAULT);
        }
      }

      if (descriptor) {
        descriptor.rwFlags.drawLast = decoded.drawLast;
        descriptor.rwFlags.additive = decoded.additive;
        descriptor.rwFlags.noZWrite = decoded.noZWrite;
        if (decoded.additive) {
          descriptor.alphaMode = 'additive';
          descriptor.transparent = true;
          descriptor.depthWrite = false;
          descriptor.alphaRef = 0;
          descriptor.blending = THREE.AdditiveBlending;
          descriptor.renderBucket = 'additive';
        } else if (decoded.drawLast) {
          descriptor.transparent = true;
          descriptor.depthTest = true;
          descriptor.depthWrite = false;
          descriptor.alphaRef = 0;
          if (descriptor.alphaMode === 'opaque') descriptor.alphaMode = 'blend';
          descriptor.renderBucket = 'transparent';
        }
        if (decoded.noZWrite) {
          descriptor.depthWrite = false;
          if (descriptor.alphaMode !== 'additive') descriptor.renderBucket = 'transparent';
        }
        syncThreeMaterialFromRW(material, node.geometry);
      } else {
        if (decoded.drawLast || decoded.additive) {
          material.transparent = true;
          material.depthTest = true;
          material.alphaTest = 0;
        }
        if (decoded.additive) {
          material.blending = THREE.AdditiveBlending;
        }
        if (decoded.noZWrite || decoded.drawLast || decoded.additive) {
          material.depthWrite = false;
        }
        material.needsUpdate = true;
      }
    }

    if (decoded.additive) {
      node.renderOrder = Math.max(node.renderOrder || 0, 400);
    } else if (decoded.drawLast) {
      node.renderOrder = Math.max(node.renderOrder || 0, 300);
    }
  });
}
