function clonePlainColor(color, fallback = { r: 1, g: 1, b: 1 }) {
  if (!color) return { ...fallback };
  return {
    r: Number(color.r ?? color.x ?? fallback.r),
    g: Number(color.g ?? color.y ?? fallback.g),
    b: Number(color.b ?? color.z ?? fallback.b),
  };
}

export const RW_ALPHA_REF_DEFAULT = 3 / 255;

export function cloneRwColor(color, fallback) {
  return clonePlainColor(color, fallback);
}

export function cloneRwMaterialDescriptor(descriptor) {
  return {
    ...descriptor,
    color: clonePlainColor(descriptor?.color),
    surfaceProps: { ...(descriptor?.surfaceProps || {}) },
    rwFlags: { ...(descriptor?.rwFlags || {}) },
  };
}

export function withRwRenderBucket(descriptor) {
  const next = cloneRwMaterialDescriptor(descriptor);
  if (next.alphaMode === 'additive') next.renderBucket = 'additive';
  else if (next.alphaMode === 'blend') next.renderBucket = 'transparent';
  else if (next.alphaMode === 'cutout') next.renderBucket = 'cutout';
  else next.renderBucket = 'opaque';
  return next;
}
