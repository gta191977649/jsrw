import * as THREE from 'three';
import { getWaterLevelIndex } from '../../utils/waterpro.js';
import { createRwFarWaterNodeMaterial } from '../../../../shaders/water-far.node.js';

const DEFAULT_WATER_COLOR = new THREE.Color(0xffffff);
const RW_DEFAULT_WAVE_HEIGHT = 35.0;
const RW_DEFAULT_WIND = 0.0;
const MIN_FAR_RENDER_DISTANCE = 512;
const COARSE_WATER_START_DISTANCE = 500;
const COARSE_WATER_GROUP_SIZE = 4;
const WATER_CULL_MARGIN_MULTIPLIER = 1.25;
const WATER_VISIBILITY_POSITION_EPSILON_SQ = 9;
const WATER_VISIBILITY_ROTATION_DOT = 0.9998;

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

function buildRwSectorPatchGeometry(toThreePosition, cellSizeX, cellSizeY, subdivisions = 8, uvScaleX = 1, uvScaleY = 1) {
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
        u0 * uvScaleX, v0 * uvScaleY,
        u1 * uvScaleX, v0 * uvScaleY,
        u1 * uvScaleX, v1 * uvScaleY,
        u0 * uvScaleX, v0 * uvScaleY,
        u1 * uvScaleX, v1 * uvScaleY,
        u0 * uvScaleX, v1 * uvScaleY,
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

function buildSectorEntries(parsed, bounds, toThreePosition) {
  const cellCount = 128;
  const cellSizeX = (bounds.end.x - bounds.start.x) / cellCount;
  const cellSizeY = (bounds.end.y - bounds.start.y) / cellCount;
  const radius = Math.sqrt((cellSizeX * cellSizeX) + (cellSizeY * cellSizeY)) * 0.5;
  const cullRadius = radius + (Math.max(cellSizeX, cellSizeY) * WATER_CULL_MARGIN_MULTIPLIER);
  const sectors = [];
  const sectorGrid = new Array(cellCount * cellCount).fill(null);

  for (let x = 0; x < cellCount; x += 1) {
    for (let y = 0; y < cellCount; y += 1) {
      const flatIndex = (x * cellCount) + y;
      const levelIndex = getWaterLevelIndex(parsed.fineBlockList[flatIndex]);
      if (levelIndex < 0 || levelIndex >= parsed.waterZs.length) continue;
      const waterZ = parsed.waterZs[levelIndex];
      if (!Number.isFinite(waterZ)) continue;
      const world = toThreePosition(
        bounds.start.x + (x * cellSizeX),
        bounds.start.y + (y * cellSizeY),
        waterZ,
      );
      const matrix = new THREE.Matrix4().makeTranslation(world.x, world.y, world.z);
      const sector = {
        index: flatIndex,
        x,
        y,
        levelIndex,
        waterZ,
        matrix,
        center: world.clone(),
        radius,
        cullRadius,
      };
      sectors.push(sector);
      sectorGrid[flatIndex] = sector;
    }
  }
  return {
    sectors,
    sectorGrid,
    cellCount,
    cellSizeX,
    cellSizeY,
  };
}

function buildCoarseSectorEntries(sectorData, bounds, toThreePosition, groupSize = COARSE_WATER_GROUP_SIZE) {
  const { sectorGrid, cellCount, cellSizeX, cellSizeY } = sectorData;
  const coarseEntries = [];
  const coarseCoveredIndices = new Set();
  const coarseRadius = Math.sqrt(
    ((cellSizeX * groupSize) * (cellSizeX * groupSize))
    + ((cellSizeY * groupSize) * (cellSizeY * groupSize)),
  ) * 0.5;
  const coarseCullRadius = coarseRadius + (Math.max(cellSizeX * groupSize, cellSizeY * groupSize) * WATER_CULL_MARGIN_MULTIPLIER);

  for (let x = 0; x < cellCount; x += groupSize) {
    for (let y = 0; y < cellCount; y += groupSize) {
      const cells = [];
      let sharedLevelIndex = null;
      let valid = true;
      for (let dx = 0; dx < groupSize && valid; dx += 1) {
        for (let dy = 0; dy < groupSize; dy += 1) {
          const cellX = x + dx;
          const cellY = y + dy;
          if (cellX >= cellCount || cellY >= cellCount) {
            valid = false;
            break;
          }
          const sector = sectorGrid[(cellX * cellCount) + cellY];
          if (!sector) {
            valid = false;
            break;
          }
          if (sharedLevelIndex === null) sharedLevelIndex = sector.levelIndex;
          else if (sharedLevelIndex !== sector.levelIndex) {
            valid = false;
            break;
          }
          cells.push(sector);
        }
      }
      if (!valid || cells.length !== (groupSize * groupSize)) continue;

      const waterZ = cells[0].waterZ;
      const world = toThreePosition(
        bounds.start.x + (x * cellSizeX),
        bounds.start.y + (y * cellSizeY),
        waterZ,
      );
      coarseEntries.push({
        matrix: new THREE.Matrix4().makeTranslation(world.x, world.y, world.z),
        center: toThreePosition(
          bounds.start.x + ((x + (groupSize * 0.5)) * cellSizeX),
          bounds.start.y + ((y + (groupSize * 0.5)) * cellSizeY),
          waterZ,
        ),
        radius: coarseRadius,
        cullRadius: coarseCullRadius,
      });
      for (const cell of cells) coarseCoveredIndices.add(cell.index);
    }
  }

  return {
    coarseEntries,
    coarseCoveredIndices,
  };
}

function createFarMaterial(sourceTexture, options = {}) {
  return createRwFarWaterNodeMaterial(sourceTexture, {
    color: DEFAULT_WATER_COLOR,
    alpha: options.alpha ?? 0.8,
    waveHeight: options.waveHeight ?? 1.0,
    wind: options.wind ?? RW_DEFAULT_WIND,
  });
}

export class RWWaterPipeline {
  constructor(options) {
    this.waterConfig = options.waterConfig;
    this.parsed = options.parsed;
    this.enabled = options.enabled !== false;
    this.timecycleProvider = null;
    this.backendId = String(options.backend?.id || 'WEBGL').toUpperCase();

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
    const sectorData = buildSectorEntries(this.parsed, bounds, options.toThreePosition);
    const coarseSectorData = buildCoarseSectorEntries(sectorData, bounds, options.toThreePosition);
    this.sectorEntries = sectorData.sectors.map((sector) => ({
      ...sector,
      coarseCovered: coarseSectorData.coarseCoveredIndices.has(sector.index),
    }));
    this.coarseSectorEntries = coarseSectorData.coarseEntries;
    this.tempProjScreenMatrix = new THREE.Matrix4();
    this.tempFrustum = new THREE.Frustum();
    this.tempSphere = new THREE.Sphere();
    this.farMesh = new THREE.InstancedMesh(sectorGeometry, this.farMaterial, sectorCount);
    this.farMesh.frustumCulled = false;
    this.farMesh.count = 0;
    this.farMesh.instanceMatrix.needsUpdate = true;
    this.farScene.add(this.farMesh);
    const coarseGeometry = buildRwSectorPatchGeometry(
      options.toThreePosition,
      cellSizeX * COARSE_WATER_GROUP_SIZE,
      cellSizeY * COARSE_WATER_GROUP_SIZE,
      4,
      COARSE_WATER_GROUP_SIZE,
      COARSE_WATER_GROUP_SIZE,
    );
    this.farCoarseMesh = new THREE.InstancedMesh(
      coarseGeometry,
      this.farMaterial,
      Math.max(1, this.coarseSectorEntries.length),
    );
    this.farCoarseMesh.frustumCulled = false;
    this.farCoarseMesh.count = 0;
    this.farCoarseMesh.instanceMatrix.needsUpdate = true;
    this.farScene.add(this.farCoarseMesh);

    this.nearMesh = new THREE.Mesh(createEmptyGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
    this.wavyMesh = new THREE.Mesh(createEmptyGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
    this.wakeMesh = new THREE.Mesh(createEmptyGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
    this.nearMesh.visible = false;
    this.wavyMesh.visible = false;
    this.wakeMesh.visible = false;

    this.visibleNearCells = 0;
    this.visibleWavyCells = 0;
    this.visibleFarCells = 0;
    this.visibleFarCoarseCells = 0;
    this.waterCellCount = sectorCount;
    this.lastVisibilityCameraPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
    this.lastVisibilityCameraQuat = new THREE.Quaternion(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    this.debugStats = {
      visibleFarCells: 0,
      visibleFarCoarseCells: 0,
      waterCellCount: sectorCount,
    };

    this.applySettings(options.settings || null);
    this.setEnabled(this.enabled);
    this.setWireframe(Boolean(options.wireframe));
  }

  setBackend(backend) {
    this.backendId = String(backend?.id || this.backendId || 'WEBGL').toUpperCase();
  }

  setTexture(sourceTexture) {
    const nextFar = cloneTexture(sourceTexture);
    disposeTexture(this.farTexture);
    this.farTexture = nextFar;
    this.farMaterial.map = this.farTexture;
    this.farMaterial.userData.rwWaterUniforms.uMap.value = this.farTexture;
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
    this.farMaterial.userData.rwWaterUniforms.uColor.value.copy(this.waterState.color);
  }

  hasRenderableWater() {
    return Boolean(this.farMesh);
  }

  getWaterCellCount() {
    return this.waterCellCount;
  }

  getVisibleFarCellCount() {
    return this.visibleFarCells;
  }

  updateVisibleFarSectors(camera) {
    if (!camera || !this.farMesh || !this.farCoarseMesh || !Array.isArray(this.sectorEntries)) return;
    const knownCameraPos = Number.isFinite(this.lastVisibilityCameraPos.x)
      && Number.isFinite(this.lastVisibilityCameraPos.y)
      && Number.isFinite(this.lastVisibilityCameraPos.z);
    const knownCameraQuat = Number.isFinite(this.lastVisibilityCameraQuat.x)
      && Number.isFinite(this.lastVisibilityCameraQuat.y)
      && Number.isFinite(this.lastVisibilityCameraQuat.z)
      && Number.isFinite(this.lastVisibilityCameraQuat.w);
    const cameraMoved = !knownCameraPos
      || camera.position.distanceToSquared(this.lastVisibilityCameraPos) > WATER_VISIBILITY_POSITION_EPSILON_SQ;
    const cameraRotated = !knownCameraQuat
      || Math.abs(camera.quaternion.dot(this.lastVisibilityCameraQuat)) < WATER_VISIBILITY_ROTATION_DOT;
    if (!cameraMoved && !cameraRotated) return;

    this.lastVisibilityCameraPos.copy(camera.position);
    this.lastVisibilityCameraQuat.copy(camera.quaternion);
    this.tempProjScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.tempFrustum.setFromProjectionMatrix(this.tempProjScreenMatrix);
    const renderDistance = Math.max(
      MIN_FAR_RENDER_DISTANCE,
      (Number(camera.far) || MIN_FAR_RENDER_DISTANCE) * 1.1,
    );
    const renderDistanceSq = renderDistance * renderDistance;
    const coarseStartDistance = this.backendId === 'WEBGPU'
      ? Math.max(COARSE_WATER_START_DISTANCE * 0.7, renderDistance * 0.15)
      : Math.max(COARSE_WATER_START_DISTANCE, renderDistance * 0.2);
    const coarseStartDistanceSq = Math.min(
      renderDistanceSq,
      coarseStartDistance ** 2,
    );
    let visibleFineCount = 0;
    let visibleCoarseCount = 0;
    for (const sector of this.sectorEntries) {
      const distanceSq = camera.position.distanceToSquared(sector.center);
      if (distanceSq > (renderDistanceSq + (sector.cullRadius * sector.cullRadius))) {
        continue;
      }
      this.tempSphere.center.copy(sector.center);
      this.tempSphere.radius = sector.cullRadius;
      if (!this.tempFrustum.intersectsSphere(this.tempSphere)) continue;
      if (sector.coarseCovered && distanceSq >= coarseStartDistanceSq) continue;
      this.farMesh.setMatrixAt(visibleFineCount, sector.matrix);
      visibleFineCount += 1;
    }
    for (const sector of this.coarseSectorEntries) {
      const distanceSq = camera.position.distanceToSquared(sector.center);
      if (distanceSq < coarseStartDistanceSq) continue;
      if (distanceSq > (renderDistanceSq + (sector.cullRadius * sector.cullRadius))) continue;
      this.tempSphere.center.copy(sector.center);
      this.tempSphere.radius = sector.cullRadius;
      if (!this.tempFrustum.intersectsSphere(this.tempSphere)) continue;
      this.farCoarseMesh.setMatrixAt(visibleCoarseCount, sector.matrix);
      visibleCoarseCount += 1;
    }
    this.visibleFarCells = visibleFineCount;
    this.visibleFarCoarseCells = visibleCoarseCount;
    this.debugStats.visibleFarCells = visibleFineCount;
    this.debugStats.visibleFarCoarseCells = visibleCoarseCount;
    this.debugStats.waterCellCount = this.waterCellCount;
    this.farMesh.count = visibleFineCount;
    this.farMesh.instanceMatrix.needsUpdate = true;
    this.farCoarseMesh.count = visibleCoarseCount;
    this.farCoarseMesh.instanceMatrix.needsUpdate = true;
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
    this.farMaterial.userData.rwWaterUniforms.uColor.value.copy(this.waterState.color);
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

    this.updateVisibleFarSectors(camera);
    this.farMesh.visible = this.enabled && this.visibleFarCells > 0;
    this.farCoarseMesh.visible = this.enabled && this.visibleFarCoarseCells > 0;
  }

  renderFar(renderer, camera, background = null) {
    if (
      !this.enabled
      || ((!this.farMesh.visible || this.visibleFarCells <= 0) && (!this.farCoarseMesh.visible || this.visibleFarCoarseCells <= 0))
    ) return;
    this.farScene.background = background ?? null;
    renderer.render(this.farScene, camera);
  }

  renderNear() {}

  renderWavy() {}

  renderWake() {}

  dispose() {
    const items = [
      this.farMesh?.geometry,
      this.farCoarseMesh?.geometry,
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
