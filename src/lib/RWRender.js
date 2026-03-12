import * as THREE from 'three';

export const RW_ALPHA_REF_DEFAULT = 2 / 255;

function mapCompressionMethod(compression, d3dFormat) {
  const c = Number(compression);
  const fmt = Number(d3dFormat);
  if (fmt === 0x31545844) return 'DXT1';
  if (fmt === 0x33545844) return 'DXT3';
  if (fmt === 0x35545844) return 'DXT5';
  if (c === 1 || c === 8) return 'DXT1';
  if (c === 3) return 'DXT3';
  if (c === 5 || c === 9) return 'DXT5';
  if (c > 0) return `COMP_${c}`;
  return 'RAW';
}

function mapPixelFormat(rasterFormat, d3dFormat) {
  const raster = Number(rasterFormat) & 0x0F00;
  if (raster === 0x0100) return 'RASTER_1555';
  if (raster === 0x0200) return 'RASTER_565';
  if (raster === 0x0300) return 'RASTER_4444';
  if (raster === 0x0400) return 'RASTER_LUM8';
  if (raster === 0x0500) return 'RASTER_8888';
  if (raster === 0x0600) return 'RASTER_888';
  if (raster === 0x0A00) return 'RASTER_555';

  const fmt = Number(d3dFormat);
  if (fmt === 21) return 'A8R8G8B8';
  if (fmt === 22) return 'X8R8G8B8';
  if (fmt === 23) return 'R5G6B5';
  if (fmt === 25) return 'A1R5G5B5';
  if (fmt === 26) return 'A4R4G4B4';
  if (!Number.isFinite(fmt) || fmt === 0) return 'UNKNOWN';
  return `0x${fmt.toString(16).toUpperCase()}`;
}

function decideAlphaMode(_texture, hasAlpha, compressionMethod, pixelFormat) {
  if (!hasAlpha) return 'opaque';
  if (compressionMethod === 'DXT1') return 'cutout';
  if (compressionMethod === 'DXT3' || compressionMethod === 'DXT5') return 'blend';
  if (pixelFormat === 'A1R5G5B5') return 'cutout';
  if (pixelFormat === 'A4R4G4B4') return 'blend';
  return 'blend';
}

function getDescriptorSide(side) {
  return side ?? THREE.DoubleSide;
}

function cloneColor(color) {
  return color?.isColor ? color.clone() : new THREE.Color(1, 1, 1);
}

function blendingFromMode(alphaMode, blending) {
  if (alphaMode === 'additive') return THREE.AdditiveBlending;
  if (alphaMode === 'blend') return THREE.NormalBlending;
  return blending ?? THREE.NormalBlending;
}

function renderBucketFromMode(alphaMode) {
  if (alphaMode === 'additive') return 'additive';
  if (alphaMode === 'blend') return 'transparent';
  if (alphaMode === 'cutout') return 'cutout';
  return 'opaque';
}

function buildRWDescriptor(material, geometry, overrides = {}) {
  const hasVertexColor = Boolean(geometry?.getAttribute?.('color'));
  const alphaMode = String(material.map?.userData?.rwAlphaMode || 'opaque');
  const baseTransparent = alphaMode === 'blend'
    || (alphaMode === 'opaque' && Boolean(material.transparent || ((typeof material.opacity === 'number') && material.opacity < 1)));
  const sourceSurfaceProps = overrides.surfaceProps || material.userData?.rwSurfaceProps || {};
  const descriptor = {
    kind: 'RWMaterial',
    version: 1,
    name: material.name || '',
    pipeline: overrides.pipeline || 'default',
    map: material.map || null,
    alphaMap: material.alphaMap || null,
    alphaMapMode: overrides.alphaMapMode || 'ignore',
    color: cloneColor(material.color),
    opacity: typeof material.opacity === 'number' ? material.opacity : 1,
    alphaMode: overrides.alphaMode || (baseTransparent ? 'blend' : alphaMode),
    alphaRef: overrides.alphaRef ?? (alphaMode === 'cutout' ? 0.5 : 0),
    depthTest: typeof material.depthTest === 'boolean' ? material.depthTest : true,
    depthWrite: typeof material.depthWrite === 'boolean' ? material.depthWrite : !baseTransparent,
    transparent: overrides.transparent ?? baseTransparent,
    blending: overrides.blending ?? material.blending ?? THREE.NormalBlending,
    side: getDescriptorSide(material.side),
    wireframe: Boolean(material.wireframe),
    vertexColorMode: hasVertexColor ? 'multiply' : 'none',
    useVertexColors: hasVertexColor,
    fog: true,
    toneMapped: false,
    filterMode: material.map?.minFilter === THREE.LinearFilter ? 'linear' : 'mipmap-linear',
    textureName: material.map?.name || material.userData?.textureName || '',
    maskName: material.alphaMap?.name || '',
    surfaceProps: {
      ambient: Number.isFinite(sourceSurfaceProps.ambient) ? sourceSurfaceProps.ambient : 1,
      specular: Number.isFinite(sourceSurfaceProps.specular) ? sourceSurfaceProps.specular : 0,
      diffuse: Number.isFinite(sourceSurfaceProps.diffuse) ? sourceSurfaceProps.diffuse : 1,
    },
    rwFlags: {
      drawLast: false,
      additive: false,
      noZWrite: false,
      disableBackfaceCulling: false,
      isFoliage: false,
      forceIgnoreVertexColor: Boolean(material.userData?.rwForceIgnoreVertexColor),
    },
    renderBucket: 'opaque',
  };

  descriptor.transparent = descriptor.alphaMode === 'blend' || descriptor.alphaMode === 'additive';
  descriptor.blending = blendingFromMode(descriptor.alphaMode, descriptor.blending);
  descriptor.renderBucket = renderBucketFromMode(descriptor.alphaMode);
  if (descriptor.alphaMode === 'blend' || descriptor.alphaMode === 'additive') {
    descriptor.depthWrite = false;
    descriptor.alphaRef = 0;
  }

  return descriptor;
}

export function cloneRWMaterialDescriptor(descriptor) {
  return {
    ...descriptor,
    color: cloneColor(descriptor.color),
    surfaceProps: { ...(descriptor.surfaceProps || {}) },
    rwFlags: { ...(descriptor.rwFlags || {}) },
  };
}

export function getRWMaterialDescriptor(material) {
  return material?.userData?.rwMaterial || null;
}

export function setRWMaterialDescriptor(material, descriptor) {
  if (!material) return material;
  material.userData = {
    ...(material.userData || {}),
    rwMaterial: descriptor,
    rwForceIgnoreVertexColor: Boolean(descriptor?.rwFlags?.forceIgnoreVertexColor),
  };
  return material;
}

export function syncThreeMaterialFromRW(material, geometry) {
  const descriptor = getRWMaterialDescriptor(material);
  if (!material || !descriptor) return material;
  const isPipelineMaterial = Boolean(material.userData?.rwPipelineMaterial);

  const hasVertexColor = Boolean(geometry?.getAttribute?.('color'));
  const allowVertexColors = descriptor.vertexColorMode !== 'none' && hasVertexColor && !descriptor.rwFlags?.forceIgnoreVertexColor;

  material.name = descriptor.name || '';
  if ('map' in material) material.map = descriptor.map || null;
  if ('alphaMap' in material) material.alphaMap = descriptor.alphaMapMode === 'separate' ? (descriptor.alphaMap || null) : null;
  if (material.color?.copy) material.color.copy(descriptor.color || new THREE.Color(1, 1, 1));
  material.opacity = descriptor.opacity ?? 1;
  material.transparent = Boolean(descriptor.transparent);
  material.alphaTest = descriptor.alphaRef ?? 0;
  material.depthTest = descriptor.depthTest !== false;
  material.depthWrite = descriptor.depthWrite !== false;
  material.side = getDescriptorSide(descriptor.side);
  material.blending = blendingFromMode(descriptor.alphaMode, descriptor.blending);
  material.wireframe = Boolean(descriptor.wireframe);
  material.fog = isPipelineMaterial ? false : Boolean(descriptor.fog);
  material.toneMapped = Boolean(descriptor.toneMapped);
  material.vertexColors = allowVertexColors;
  material.needsUpdate = true;

  material.userData = {
    ...(material.userData || {}),
    rwMaterial: descriptor,
    rwForceIgnoreVertexColor: Boolean(descriptor.rwFlags?.forceIgnoreVertexColor),
  };

  if (isPipelineMaterial) {
    const uniforms = material.uniforms || {};
    if (uniforms.uUseVertexColor) {
      uniforms.uUseVertexColor.value = allowVertexColors;
    }
    if (uniforms.opacity) {
      uniforms.opacity.value = descriptor.opacity ?? 1;
    }
    if (uniforms.alphaTest) {
      uniforms.alphaTest.value = descriptor.alphaRef ?? 0;
    }
    if (uniforms.map) {
      uniforms.map.value = descriptor.map || uniforms.map.value;
    }
  }

  if (descriptor.pipeline === 'tobj') {
    material.transparent = true;
    material.opacity = 1;
    material.depthWrite = false;
    material.alphaTest = 0;
    material.blending = THREE.NormalBlending;
  }

  return material;
}

export function createThreeMaterialFromRW(descriptor, geometry) {
  const material = new THREE.MeshBasicMaterial({
    name: descriptor.name || '',
    map: descriptor.map || null,
    alphaMap: null,
    color: cloneColor(descriptor.color),
    transparent: Boolean(descriptor.transparent),
    opacity: descriptor.opacity ?? 1,
    alphaTest: descriptor.alphaRef ?? 0,
    side: getDescriptorSide(descriptor.side),
    depthTest: descriptor.depthTest !== false,
    depthWrite: descriptor.depthWrite !== false,
    blending: blendingFromMode(descriptor.alphaMode, descriptor.blending),
    wireframe: Boolean(descriptor.wireframe),
    vertexColors: false,
    fog: Boolean(descriptor.fog),
    toneMapped: Boolean(descriptor.toneMapped),
  });
  setRWMaterialDescriptor(material, cloneRWMaterialDescriptor(descriptor));
  return syncThreeMaterialFromRW(material, geometry);
}

export function createRWMaterial(material, geometry, overrides = {}) {
  if (!material) return material;
  if (material.isShaderMaterial) {
    return material;
  }
  const descriptor = buildRWDescriptor(material, geometry, overrides);
  return createThreeMaterialFromRW(descriptor, geometry);
}

export function buildRWMaterialDescriptor(material, geometry, overrides = {}) {
  return buildRWDescriptor(material, geometry, overrides);
}

export function applyDisableVertexColor(root, disableVertexColor) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) continue;
      const descriptor = getRWMaterialDescriptor(material);
      if (!descriptor) continue;
      descriptor.rwFlags.forceIgnoreVertexColor = Boolean(disableVertexColor);
      syncThreeMaterialFromRW(material, node.geometry);
      const useVertexColorUniform = material.uniforms?.uUseVertexColor;
      if (useVertexColorUniform) {
        useVertexColorUniform.value = descriptor.rwFlags.forceIgnoreVertexColor ? 0 : (descriptor.useVertexColors ? 1 : 0);
      }
    }
  });
}

export function tuneTransparentMaterial(material) {
  if (!material) return;
  if (material.transparent || (typeof material.opacity === 'number' && material.opacity < 1)) {
    material.transparent = true;
    material.blending = THREE.NormalBlending;
    material.depthWrite = false;
    material.depthTest = true;
    material.alphaTest = 0;
    material.needsUpdate = true;
  }
}

export function toRWMaterial(material, geometry) {
  return createRWMaterial(material, geometry, {
    alphaMapMode: 'ignore',
  });
}

export function normalizeTextureDictionary(dict, options = {}) {
  if (!dict || typeof dict.entries !== 'function') return dict;
  const metadataByName = options.metadataByName instanceof Map ? options.metadataByName : new Map();
  const normalized = new Map();
  for (const [rawKey, rawEntry] of dict.entries()) {
    const key = String(rawKey || '').toLowerCase();
    if (!key) continue;
    const texture = rawEntry?.isTexture ? rawEntry : rawEntry?.texture;
    if (!texture || !texture.isTexture) continue;
    texture.flipY = false;
    texture.premultiplyAlpha = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    const hasAlpha = rawEntry?.hasAlpha === true || texture.hasAlpha === true;
    const meta = metadataByName.get(key) || {};
    const compressionMethod = mapCompressionMethod(meta.compression ?? rawEntry?.compression, meta.d3dFormat ?? rawEntry?.d3dFormat);
    const pixelFormat = mapPixelFormat(meta.rasterFormat ?? rawEntry?.rasterFormat, meta.d3dFormat ?? rawEntry?.d3dFormat);
    const alphaMode = decideAlphaMode(texture, hasAlpha, compressionMethod, pixelFormat);
    texture.hasAlpha = hasAlpha;
    texture.userData = {
      ...(texture.userData || {}),
      rwAlphaMode: alphaMode,
      rwCompressionMethod: compressionMethod,
      rwPixelFormat: pixelFormat,
      rwD3dFormat: Number(meta.d3dFormat ?? rawEntry?.d3dFormat) || 0,
      rwRasterFormat: Number(meta.rasterFormat ?? rawEntry?.rasterFormat) || 0,
    };

    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = alphaMode === 'blend' ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = alphaMode === 'cutout';
    texture.needsUpdate = true;

    normalized.set(key, {
      texture,
      hasAlpha,
      compressionMethod,
      pixelFormat,
      d3dFormat: Number(meta.d3dFormat ?? rawEntry?.d3dFormat) || 0,
      rasterFormat: Number(meta.rasterFormat ?? rawEntry?.rasterFormat) || 0,
      clone() {
        return texture.clone();
      },
    });
  }
  return normalized;
}

export function prepareTobjInstanceMaterials(root, disableVertexColor = false) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    const sourceMaterials = Array.isArray(node.material) ? node.material : [node.material];
    const tobjMaterials = sourceMaterials.map((mat) => {
      if (!mat) return mat;
      const descriptor = getRWMaterialDescriptor(mat)
        ? cloneRWMaterialDescriptor(getRWMaterialDescriptor(mat))
        : buildRWDescriptor(mat, node.geometry);
      descriptor.pipeline = 'tobj';
      descriptor.alphaMode = 'blend';
      descriptor.alphaRef = 0;
      descriptor.transparent = true;
      descriptor.depthWrite = false;
      descriptor.depthTest = true;
      descriptor.blending = THREE.NormalBlending;
      descriptor.side = THREE.DoubleSide;
      descriptor.color = new THREE.Color(1, 1, 1);
      descriptor.opacity = 1;
      descriptor.rwFlags.forceIgnoreVertexColor = Boolean(disableVertexColor);
      descriptor.renderBucket = 'transparent';
      return createThreeMaterialFromRW(descriptor, node.geometry);
    });

    node.material = Array.isArray(node.material) ? tobjMaterials : tobjMaterials[0];
    node.renderOrder = 50;
  });
}
