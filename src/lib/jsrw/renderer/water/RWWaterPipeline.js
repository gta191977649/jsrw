import * as THREE from 'three';
import { getWaterLevelIndex } from '../../../waterpro.js';

const DEFAULT_WATER_COLOR = new THREE.Color(0xffffff);
const RW_DEFAULT_WAVE_HEIGHT = 35.0;
const RW_DEFAULT_WIND = 0.0;

function createFallbackTexture() {
  const data = new Uint8Array([255, 255, 255, 255]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  texture.userData = {
    ...(texture.userData || {}),
    rwWaterOwned: true,
  };
  return texture;
}

function makeCanvasTextureFromDataTexture(texture) {
  const image = texture?.image;
  if (!texture?.isDataTexture || !image?.data || !Number.isFinite(image.width) || !Number.isFinite(image.height)) {
    return null;
  }

  let canvas = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(image.width, image.height);
  } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
  }
  if (!canvas) return null;

  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.putImageData !== 'function') return null;
  const rgba = image.data instanceof Uint8ClampedArray
    ? image.data
    : new Uint8ClampedArray(image.data.buffer.slice(image.data.byteOffset, image.data.byteOffset + image.data.byteLength));
  ctx.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);

  const canvasTexture = new THREE.CanvasTexture(canvas);
  canvasTexture.wrapS = THREE.RepeatWrapping;
  canvasTexture.wrapT = THREE.RepeatWrapping;
  canvasTexture.magFilter = texture.magFilter;
  canvasTexture.minFilter = texture.minFilter;
  canvasTexture.anisotropy = texture.anisotropy;
  canvasTexture.colorSpace = texture.colorSpace;
  canvasTexture.flipY = texture.flipY;
  canvasTexture.generateMipmaps = texture.generateMipmaps;
  canvasTexture.premultiplyAlpha = texture.premultiplyAlpha;
  canvasTexture.unpackAlignment = texture.unpackAlignment;
  canvasTexture.name = texture.name;
  canvasTexture.userData = {
    ...(texture.userData || {}),
    rwWaterOwned: true,
  };
  canvasTexture.needsUpdate = true;
  return canvasTexture;
}

function cloneTexture(texture) {
  if (!texture?.isTexture) return createFallbackTexture();
  const canvasTexture = makeCanvasTextureFromDataTexture(texture);
  if (canvasTexture) return canvasTexture;
  const clone = texture.clone();
  clone.wrapS = THREE.RepeatWrapping;
  clone.wrapT = THREE.RepeatWrapping;
  clone.needsUpdate = true;
  clone.userData = {
    ...(clone.userData || {}),
    rwWaterOwned: true,
  };
  return clone;
}

function disposeTexture(texture) {
  if (texture?.userData?.rwWaterOwned && typeof texture.dispose === 'function') texture.dispose();
}

function createEmptyGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([], 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute('fade', new THREE.Float32BufferAttribute([], 1));
  return geometry;
}

function getRwWaveAmplitude(waveHeightSetting) {
  const clamped = Math.max(0, Math.min(100, Number(waveHeightSetting) || 0));
  return clamped / RW_DEFAULT_WAVE_HEIGHT;
}

function buildRwSectorPatchGeometry(toThreePosition, cellSizeX, cellSizeY, subdivisions = 8) {
  const origin = toThreePosition(0, 0, 0);
  const positions = [];
  const uvs = [];
  const normals = [];

  for (let ix = 0; ix < subdivisions; ix += 1) {
    const u0 = ix / subdivisions;
    const u1 = (ix + 1) / subdivisions;
    const gx0 = cellSizeX * u0;
    const gx1 = cellSizeX * u1;
    for (let iy = 0; iy < subdivisions; iy += 1) {
      const v0 = iy / subdivisions;
      const v1 = (iy + 1) / subdivisions;
      const gy0 = cellSizeY * v0;
      const gy1 = cellSizeY * v1;
      const p0 = toThreePosition(gx0, gy0, 0);
      const p1 = toThreePosition(gx1, gy0, 0);
      const p2 = toThreePosition(gx1, gy1, 0);
      const p3 = toThreePosition(gx0, gy1, 0);
      positions.push(
        p0.x - origin.x, p0.y - origin.y, p0.z - origin.z,
        p1.x - origin.x, p1.y - origin.y, p1.z - origin.z,
        p2.x - origin.x, p2.y - origin.y, p2.z - origin.z,
        p0.x - origin.x, p0.y - origin.y, p0.z - origin.z,
        p2.x - origin.x, p2.y - origin.y, p2.z - origin.z,
        p3.x - origin.x, p3.y - origin.y, p3.z - origin.z,
      );
      uvs.push(
        u0, v0,
        u1, v0,
        u1, v1,
        u0, v0,
        u1, v1,
        u0, v1,
      );
      normals.push(
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function countValidFineSectors(parsed) {
  let count = 0;
  for (let i = 0; i < parsed.fineBlockList.length; i += 1) {
    const levelIndex = getWaterLevelIndex(parsed.fineBlockList[i]);
    if (levelIndex >= 0 && levelIndex < parsed.waterZs.length && Number.isFinite(parsed.waterZs[levelIndex])) {
      count += 1;
    }
  }
  return count;
}

function populateSectorInstances(mesh, parsed, bounds, toThreePosition) {
  const cellCount = 128;
  const cellSizeX = (bounds.end.x - bounds.start.x) / cellCount;
  const cellSizeY = (bounds.end.y - bounds.start.y) / cellCount;
  const matrix = new THREE.Matrix4();
  let instanceIndex = 0;

  for (let x = 0; x < cellCount; x += 1) {
    for (let y = 0; y < cellCount; y += 1) {
      const levelIndex = getWaterLevelIndex(parsed.fineBlockList[(x * cellCount) + y]);
      if (levelIndex < 0 || levelIndex >= parsed.waterZs.length) continue;
      const waterZ = parsed.waterZs[levelIndex];
      if (!Number.isFinite(waterZ)) continue;
      const world = toThreePosition(
        bounds.start.x + (x * cellSizeX),
        bounds.start.y + (y * cellSizeY),
        waterZ,
      );
      matrix.makeTranslation(world.x, world.y, world.z);
      mesh.setMatrixAt(instanceIndex, matrix);
      instanceIndex += 1;
    }
  }

  mesh.count = instanceIndex;
  mesh.instanceMatrix.needsUpdate = true;
}

function createFarMaterial(texture, options = {}) {
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    color: DEFAULT_WATER_COLOR.clone(),
    transparent: true,
    opacity: options.alpha ?? 0.8,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    toneMapped: false,
  });
  material.userData.rwWaterUniforms = {
    uTime: { value: 0 },
    uWaveHeight: { value: options.waveHeight ?? 1.0 },
    uWind: { value: options.wind ?? RW_DEFAULT_WIND },
  };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = material.userData.rwWaterUniforms.uTime;
    shader.uniforms.uWaveHeight = material.userData.rwWaterUniforms.uWaveHeight;
    shader.uniforms.uWind = material.userData.rwWaterUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform float uWaveHeight;
uniform float uWind;`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
float gridX = uv.x * 8.0;
float gridY = uv.y * 8.0;
float angle = mod(uTime * (6.28318530718 / 4.096), 6.28318530718);
float waveA = sin(((gridX + gridY) * 0.78539816339) + angle);
float waveB = sin(((gridY - gridX) * 3.14159265359) + (2.0 * angle));
float windFactorA = (uWind * 0.7) + 0.3;
float windFactorB = uWind * 0.2;
transformed.y += ((windFactorA * waveA) + (windFactorB * waveB)) * uWaveHeight;`,
      );
    material.userData.rwWaterShader = shader;
  };
  material.customProgramCacheKey = () => 'rw-water-far-basic-v2';
  return material;
}

export class RWWaterPipeline {
  constructor(options) {
    this.waterConfig = options.waterConfig;
    this.parsed = options.parsed;
    this.enabled = options.enabled !== false;
    this.timecycleProvider = null;

    this.settings = {
      uvSpeed: 1,
      waveHeight: RW_DEFAULT_WAVE_HEIGHT,
      farAlpha: 0.72,
      ...(options.settings || {}),
    };

    this.waterState = {
      color: DEFAULT_WATER_COLOR.clone(),
      farAlpha: this.settings.farAlpha,
    };

    this.farScene = new THREE.Scene();
    this.nearScene = new THREE.Scene();
    this.wavyScene = new THREE.Scene();
    this.wakeScene = new THREE.Scene();
    this.uvOffset = new THREE.Vector2();

    this.farTexture = cloneTexture(options.texture);
    this.farMaterial = createFarMaterial(this.farTexture, {
      alpha: this.waterState.farAlpha,
      waveHeight: getRwWaveAmplitude(this.settings.waveHeight),
      wind: RW_DEFAULT_WIND,
    });
    this.farMaterial.wireframe = Boolean(options.wireframe);

    const bounds = this.waterConfig.bounds;
    const cellSizeX = (bounds.end.x - bounds.start.x) / 128;
    const cellSizeY = (bounds.end.y - bounds.start.y) / 128;
    const sectorGeometry = buildRwSectorPatchGeometry(options.toThreePosition, cellSizeX, cellSizeY, 8);
    const sectorCount = countValidFineSectors(this.parsed);
    this.farMesh = new THREE.InstancedMesh(sectorGeometry, this.farMaterial, sectorCount);
    this.farMesh.frustumCulled = false;
    populateSectorInstances(this.farMesh, this.parsed, bounds, options.toThreePosition);
    this.farScene.add(this.farMesh);

    this.nearMesh = new THREE.Mesh(createEmptyGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
    this.wavyMesh = new THREE.Mesh(createEmptyGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
    this.wakeMesh = new THREE.Mesh(createEmptyGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
    this.nearMesh.visible = false;
    this.wavyMesh.visible = false;
    this.wakeMesh.visible = false;

    this.visibleNearCells = 0;
    this.visibleWavyCells = 0;
    this.waterCellCount = sectorCount;

    this.applySettings(options.settings || null);
    this.setEnabled(this.enabled);
    this.setWireframe(Boolean(options.wireframe));
  }

  setTexture(sourceTexture) {
    const nextFar = cloneTexture(sourceTexture);
    disposeTexture(this.farTexture);
    this.farTexture = nextFar;
    this.farMaterial.map = this.farTexture;
    this.farMaterial.needsUpdate = true;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.farMesh.visible = this.enabled;
    this.nearMesh.visible = false;
    this.wavyMesh.visible = false;
    this.wakeMesh.visible = false;
  }

  setWireframe(enabled) {
    this.farMaterial.wireframe = Boolean(enabled);
  }

  setTimecycleProvider(provider) {
    this.timecycleProvider = typeof provider === 'function' ? provider : null;
  }

  applySettings(settings) {
    if (settings && typeof settings === 'object') {
      this.settings = { ...this.settings, ...settings };
    }
    this.farMaterial.opacity = this.settings.farAlpha;
    this.farMaterial.userData.rwWaterUniforms.uWaveHeight.value = getRwWaveAmplitude(this.settings.waveHeight);
  }

  hasRenderableWater() {
    return Boolean(this.farMesh);
  }

  getWaterCellCount() {
    return this.waterCellCount;
  }

  update(camera, timeMs, dt) {
    if (!this.enabled || !this.hasRenderableWater()) return;

    const delta = Number.isFinite(dt) ? dt : 0;
    const wind = this.farMaterial.userData.rwWaterUniforms.uWind.value;
    const windAddUv = ((wind * 0.0015) + 0.0005) * this.settings.uvSpeed;
    const jitterU = (Math.random() - 0.5) * 0.001 * this.settings.uvSpeed;
    const jitterV = (Math.random() - 0.5) * 0.001 * this.settings.uvSpeed;
    this.uvOffset.x = (this.uvOffset.x + ((windAddUv + jitterU) * delta * 60)) % 1;
    this.uvOffset.y = (this.uvOffset.y + ((windAddUv + jitterV) * delta * 60)) % 1;
    if (this.uvOffset.x < 0) this.uvOffset.x += 1;
    if (this.uvOffset.y < 0) this.uvOffset.y += 1;

    this.farTexture.offset.copy(this.uvOffset);

    const timeSeconds = timeMs * 0.001;
    this.farMaterial.userData.rwWaterUniforms.uTime.value = timeSeconds;
    this.farMaterial.userData.rwWaterUniforms.uWaveHeight.value = getRwWaveAmplitude(this.settings.waveHeight);

    const timecycleState = this.timecycleProvider ? this.timecycleProvider() : null;
    const resolvedFarAlpha = Number.isFinite(timecycleState?.farAlpha) ? timecycleState.farAlpha : this.settings.farAlpha;
    this.waterState.farAlpha = Math.max(0.18, resolvedFarAlpha);
    if (timecycleState?.color?.isColor) this.waterState.color.copy(timecycleState.color);

    this.farMaterial.color.copy(this.waterState.color);
    this.farMaterial.opacity = this.waterState.farAlpha;

    const fogColor = timecycleState?.fogColor?.isColor ? timecycleState.fogColor : null;
    const fogNear = Number.isFinite(timecycleState?.fogNear) ? timecycleState.fogNear : null;
    const fogFar = Number.isFinite(timecycleState?.fogFar) ? timecycleState.fogFar : null;
    if (fogColor && fogNear !== null && fogFar !== null) {
      const farFogNear = Math.max(0, Math.min(fogNear, fogFar - 1));
      const farFogFar = Math.max(farFogNear + 1, fogFar);
      this.farScene.fog = new THREE.Fog(fogColor.clone(), farFogNear, farFogFar);
    } else {
      this.farScene.fog = null;
    }

    this.farMesh.visible = this.enabled;
  }

  renderFar(renderer, camera, background = null) {
    if (!this.enabled || !this.farMesh.visible) return;
    this.farScene.background = background ?? null;
    renderer.render(this.farScene, camera);
  }

  renderNear() {}

  renderWavy() {}

  renderWake() {}

  dispose() {
    const items = [
      this.farMesh?.geometry,
      this.nearMesh?.geometry,
      this.wavyMesh?.geometry,
      this.wakeMesh?.geometry,
      this.farMaterial,
      this.nearMesh?.material,
      this.wavyMesh?.material,
      this.wakeMesh?.material,
      this.farTexture,
    ];
    for (const item of items) {
      if (item && typeof item.dispose === 'function') item.dispose();
    }
    this.farScene.clear();
    this.nearScene.clear();
    this.wavyScene.clear();
    this.wakeScene.clear();
  }
}
