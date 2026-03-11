import * as THREE from 'three';
import { buildWaterBlockGeometry, buildWaterFineGeometry } from './waterpro';
import waterWaveVertexShader from '../shaders/water-wave.vertex.glsl.js';
import waterWaveFragmentShader from '../shaders/water-wave.fragment.glsl.js';

const DEFAULT_WATER_COLOR = new THREE.Color(0x6f93ab);

function markTextureAsData(texture) {
  if (!texture?.isTexture) return texture;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createFallbackTexture() {
  const data = new Uint8Array([255, 255, 255, 255]);
  const fallback = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  fallback.wrapS = THREE.RepeatWrapping;
  fallback.wrapT = THREE.RepeatWrapping;
  fallback.colorSpace = THREE.SRGBColorSpace;
  fallback.needsUpdate = true;
  fallback.userData = {
    ...(fallback.userData || {}),
    rwWaterOwned: true,
  };
  return fallback;
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
  const imageData = new ImageData(rgba, image.width, image.height);
  ctx.putImageData(imageData, 0, 0);

  const canvasTexture = new THREE.CanvasTexture(canvas);
  canvasTexture.wrapS = texture.wrapS;
  canvasTexture.wrapT = texture.wrapT;
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
  if (!texture?.isTexture) {
    return createFallbackTexture();
  }
  const canvasTexture = makeCanvasTextureFromDataTexture(texture);
  if (canvasTexture) {
    canvasTexture.wrapS = THREE.RepeatWrapping;
    canvasTexture.wrapT = THREE.RepeatWrapping;
    return canvasTexture;
  }
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
  if (texture?.userData?.rwWaterOwned && typeof texture.dispose === 'function') {
    texture.dispose();
  }
}

function hasValidTypedArray(value) {
  return Boolean(value && ArrayBuffer.isView(value) && Number.isFinite(value.byteLength));
}

function hasValidBufferAttribute(attribute) {
  return Boolean(attribute && hasValidTypedArray(attribute.array));
}

function isByteLengthUndefinedError(error) {
  const message = String(error?.message || '');
  return message.includes('byteLength') && message.includes('undefined');
}

function createGridGeometry(size, segments) {
  const positions = [];
  const uvs = [];
  for (let x = 0; x < segments; x += 1) {
    for (let y = 0; y < segments; y += 1) {
      const u0 = x / segments;
      const v0 = y / segments;
      const u1 = (x + 1) / segments;
      const v1 = (y + 1) / segments;
      const x0 = (u0 - 0.5) * size;
      const x1 = (u1 - 0.5) * size;
      const z0 = (v0 - 0.5) * size;
      const z1 = (v1 - 0.5) * size;
      positions.push(
        x0, 0, z0,
        x1, 0, z0,
        x1, 0, z1,
        x0, 0, z0,
        x1, 0, z1,
        x0, 0, z1,
      );
      uvs.push(
        u0, v0,
        u1, v0,
        u1, v1,
        u0, v0,
        u1, v1,
        u0, v1,
      );
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

function createWaterWaveMaterial(texture, options = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uUvOffset: { value: new THREE.Vector2() },
      uTime: { value: 0 },
      uColor: { value: DEFAULT_WATER_COLOR.clone() },
      uFogColor: { value: new THREE.Color(0.55, 0.68, 0.76) },
      uFogNear: { value: 1200.0 },
      uFogFar: { value: 2000.0 },
      uAlpha: { value: options.alpha ?? 0.72 },
      uAlphaScale: { value: 1.0 },
      uDistanceAlphaStrength: { value: 1.0 },
      uWaveEnabled: { value: options.waveEnabled === false ? 0 : 1 },
      uWaveHeight: { value: options.waveHeight ?? 0.0 },
      uCameraWorldPos: { value: new THREE.Vector3() },
      uWaveRadiusInner: { value: options.waveRadiusInner ?? 140.0 },
      uWaveRadiusOuter: { value: options.waveRadiusOuter ?? 260.0 },
    },
    vertexShader: waterWaveVertexShader,
    fragmentShader: waterWaveFragmentShader,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    fog: false,
    toneMapped: false,
  });
}

export class RWWaterPipeline {
  constructor(options) {
    this.waterConfig = options.waterConfig;
    this.parsed = options.parsed;
    this.enabled = options.enabled !== false;
    this.toThreePosition = options.toThreePosition;
    this.writeThreePosition = options.writeThreePosition;
    this.toGamePosition = options.toGamePosition;
    this.timecycleProvider = null;

    this.farScene = new THREE.Scene();
    this.nearScene = new THREE.Scene();
    this.wakeScene = new THREE.Scene();

    this.uvOffset = new THREE.Vector2();
    this.animationTime = 0;
    this.fineCellSizeX = (this.waterConfig.bounds.end.x - this.waterConfig.bounds.start.x) / 128;
    this.fineCellSizeY = (this.waterConfig.bounds.end.y - this.waterConfig.bounds.start.y) / 128;

    this.waterState = {
      color: DEFAULT_WATER_COLOR.clone(),
      farAlpha: 0.72,
      nearAlpha: 0.72,
      wavyAlpha: 0.82,
      wakeAlpha: 0.55,
    };
    this.animationFade = 1;
    this.settings = {
      uvSpeed: 1,
      waveHeight: 35,
      farAlpha: 0.72,
      nearAlpha: 0.72,
      wavyAlpha: 0.82,
      wakeAlpha: 0.55,
      showWavy: true,
      showWake: false,
    };

    this.farTexture = cloneTexture(options.texture);
    this.nearTexture = markTextureAsData(cloneTexture(options.texture));
    this.wakeTexture = cloneTexture(options.texture);

    this.farMaterial = new THREE.MeshBasicMaterial({
      name: 'rw-water-far',
      map: this.farTexture,
      color: this.waterState.color.clone(),
      transparent: true,
      opacity: this.waterState.farAlpha,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      wireframe: Boolean(options.wireframe),
      fog: true,
      toneMapped: false,
    });
    this.nearMaterial = createWaterWaveMaterial(this.nearTexture, {
      alpha: this.waterState.nearAlpha,
      waveEnabled: true,
      waveHeight: 0.35,
      waveRadiusInner: Math.max(this.fineCellSizeX, this.fineCellSizeY) * 3.0,
      waveRadiusOuter: Math.max(this.fineCellSizeX, this.fineCellSizeY) * 8.0,
    });
    this.nearMaterial.wireframe = Boolean(options.wireframe);
    this.wakeMaterial = new THREE.MeshBasicMaterial({
      name: 'rw-water-wake',
      map: this.wakeTexture,
      color: this.waterState.color.clone(),
      transparent: true,
      opacity: this.waterState.wakeAlpha,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      wireframe: Boolean(options.wireframe),
      fog: true,
      toneMapped: false,
      blending: THREE.NormalBlending,
    });

    this.farMesh = new THREE.Mesh(
      buildWaterBlockGeometry(this.parsed, {
        waterConfig: this.waterConfig,
        toThreePosition: this.toThreePosition,
        writePosition: this.writeThreePosition,
      }),
      this.farMaterial,
    );
    this.farMesh.frustumCulled = false;

    const nearGeometry = buildWaterFineGeometry(this.parsed, {
      waterConfig: this.waterConfig,
      toThreePosition: this.toThreePosition,
      writePosition: this.writeThreePosition,
    });

    this.nearMesh = new THREE.Mesh(nearGeometry, this.nearMaterial);
    this.nearMesh.frustumCulled = false;
    this.nearMesh.position.y += 0.02;

    this.wakeMesh = new THREE.Mesh(
      createGridGeometry(Math.max(this.fineCellSizeX, this.fineCellSizeY) * 0.75, 1),
      this.wakeMaterial,
    );
    this.wakeMesh.frustumCulled = false;
    this.wakeMesh.visible = false;
    this.wakeMesh.position.y += 0.08;

    this.farScene.add(this.farMesh);
    this.nearScene.add(this.nearMesh);
    this.wakeScene.add(this.wakeMesh);

    this.applySettings(options.settings || null);
    this.setEnabled(this.enabled);
    this.setWireframe(Boolean(options.wireframe));
  }

  setTexture(sourceTexture) {
    const nextFar = cloneTexture(sourceTexture);
    const nextNear = markTextureAsData(cloneTexture(sourceTexture));
    const nextWake = cloneTexture(sourceTexture);

    disposeTexture(this.farTexture);
    disposeTexture(this.nearTexture);
    disposeTexture(this.wakeTexture);

    this.farTexture = nextFar;
    this.nearTexture = nextNear;
    this.wakeTexture = nextWake;

    this.farMaterial.map = this.farTexture;
    this.nearMaterial.uniforms.uMap.value = this.nearTexture;
    this.wakeMaterial.map = this.wakeTexture;

    this.farMaterial.needsUpdate = true;
    this.nearMaterial.needsUpdate = true;
    this.wakeMaterial.needsUpdate = true;
  }

  hasValidGeometry(mesh, requiredAttributes = []) {
    const geometry = mesh?.geometry;
    if (!geometry?.isBufferGeometry) return false;
    if (geometry.index && !hasValidBufferAttribute(geometry.index)) return false;
    for (const name of requiredAttributes) {
      if (!hasValidBufferAttribute(geometry.getAttribute(name))) return false;
    }
    return true;
  }

  rebuildFarGeometry() {
    const nextGeometry = buildWaterBlockGeometry(this.parsed, {
      waterConfig: this.waterConfig,
      toThreePosition: this.toThreePosition,
      writePosition: this.writeThreePosition,
    });
    const previousGeometry = this.farMesh?.geometry;
    this.farMesh.geometry = nextGeometry;
    if (previousGeometry && previousGeometry !== nextGeometry) previousGeometry.dispose();
  }

  rebuildNearGeometry() {
    const nextGeometry = buildWaterFineGeometry(this.parsed, {
      waterConfig: this.waterConfig,
      toThreePosition: this.toThreePosition,
      writePosition: this.writeThreePosition,
    });
    const previousGeometry = this.nearMesh?.geometry;
    this.nearMesh.geometry = nextGeometry;
    if (previousGeometry && previousGeometry !== nextGeometry) previousGeometry.dispose();
  }

  rebuildWakeGeometry() {
    const nextGeometry = createGridGeometry(Math.max(this.fineCellSizeX, this.fineCellSizeY) * 0.75, 1);
    const previousGeometry = this.wakeMesh?.geometry;
    this.wakeMesh.geometry = nextGeometry;
    if (previousGeometry && previousGeometry !== nextGeometry) previousGeometry.dispose();
  }

  recoverBrokenGeometryBuffers() {
    let repaired = false;
    if (!this.hasValidGeometry(this.farMesh, ['position', 'uv'])) {
      this.rebuildFarGeometry();
      repaired = true;
    }
    if (!this.hasValidGeometry(this.nearMesh, ['position', 'uv', 'normal'])) {
      this.rebuildNearGeometry();
      repaired = true;
    }
    if (!this.hasValidGeometry(this.wakeMesh, ['position', 'uv', 'normal'])) {
      this.rebuildWakeGeometry();
      repaired = true;
    }
    return repaired;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.farMesh.visible = this.enabled;
    this.nearMesh.visible = this.enabled;
    if (!this.enabled) {
      this.wakeMesh.visible = false;
    }
  }

  setWireframe(enabled) {
    const value = Boolean(enabled);
    this.farMaterial.wireframe = value;
    this.nearMaterial.wireframe = value;
    this.wakeMaterial.wireframe = value;
  }

  setTimecycleProvider(provider) {
    this.timecycleProvider = typeof provider === 'function' ? provider : null;
  }

  applySettings(settings) {
    if (settings && typeof settings === 'object') {
      this.settings = { ...this.settings, ...settings };
    }
    const normalizedWaveHeight = Math.max(0, Math.min(100, this.settings.waveHeight)) / 100;
    this.farMaterial.opacity = this.settings.farAlpha;
    this.nearMaterial.uniforms.uAlpha.value = this.settings.nearAlpha;
    this.nearMaterial.uniforms.uAlphaScale.value = 1.0;
    this.nearMaterial.uniforms.uDistanceAlphaStrength.value = 1.0;
    this.nearMaterial.uniforms.uWaveEnabled.value = this.settings.showWavy ? 1 : 0;
    this.nearMaterial.uniforms.uWaveHeight.value = normalizedWaveHeight * 1.35;
    this.nearMaterial.uniforms.uWaveRadiusInner.value = Math.max(this.fineCellSizeX, this.fineCellSizeY) * 3.0;
    this.nearMaterial.uniforms.uWaveRadiusOuter.value = Math.max(this.fineCellSizeX, this.fineCellSizeY) * 9.0;
    this.wakeMaterial.opacity = this.settings.wakeAlpha;
  }

  hasRenderableWater() {
    return Boolean(this.farMesh && this.nearMesh);
  }

  update(camera, timeMs, dt) {
    if (!this.enabled || !this.hasRenderableWater()) return;

    const delta = Number.isFinite(dt) ? dt : 0;
    const cameraHeight = Math.max(0, camera.position.y);
    const animationFade = 1.0 - THREE.MathUtils.smoothstep(cameraHeight, 80, 260);
    this.animationFade = animationFade;
    this.animationTime += delta * animationFade;

    const windAdd = (0.0006 + (0.0005 * 0.35)) * this.settings.uvSpeed * animationFade;
    this.uvOffset.x = (this.uvOffset.x + (windAdd * delta * 60)) % 1;
    this.uvOffset.y = (this.uvOffset.y + (windAdd * delta * 60)) % 1;

    this.farTexture.offset.copy(this.uvOffset);
    this.nearTexture.offset.copy(this.uvOffset);
    this.wakeTexture.offset.set((this.uvOffset.x * 1.35) % 1, (this.uvOffset.y * 0.8) % 1);

    const timeSeconds = timeMs * 0.001;
    const radiusBase = Math.max(this.fineCellSizeX, this.fineCellSizeY);
    const radiusBoost = Math.min(220, cameraHeight * 1.2);
    this.nearMaterial.uniforms.uUvOffset.value.copy(this.uvOffset);
    this.nearMaterial.uniforms.uTime.value = timeSeconds;
    this.nearMaterial.uniforms.uCameraWorldPos.value.copy(camera.position);
    this.nearMaterial.uniforms.uAlphaScale.value = 1.0;
    this.nearMaterial.uniforms.uDistanceAlphaStrength.value = animationFade;
    this.nearMaterial.uniforms.uWaveRadiusInner.value = (radiusBase * 3.0) + (radiusBoost * 0.45);
    this.nearMaterial.uniforms.uWaveRadiusOuter.value = (radiusBase * 9.0) + radiusBoost;
    this.nearMaterial.uniforms.uWaveHeight.value = (Math.max(0, Math.min(100, this.settings.waveHeight)) / 100) * 1.35 * animationFade;

    const timecycleState = this.timecycleProvider ? this.timecycleProvider() : null;
    if (timecycleState?.color?.isColor) {
      this.waterState.color.copy(timecycleState.color);
    }
    const fogColor = timecycleState?.fogColor?.isColor ? timecycleState.fogColor : null;
    const fogNear = Number.isFinite(timecycleState?.fogNear) ? timecycleState.fogNear : null;
    const fogFar = Number.isFinite(timecycleState?.fogFar) ? timecycleState.fogFar : null;
    this.waterState.farAlpha = this.settings.farAlpha;
    this.waterState.nearAlpha = this.settings.nearAlpha;
    this.waterState.wavyAlpha = this.settings.wavyAlpha;
    this.waterState.wakeAlpha = this.settings.wakeAlpha;
    if (Number.isFinite(timecycleState?.farAlpha)) this.waterState.farAlpha = timecycleState.farAlpha;
    if (Number.isFinite(timecycleState?.nearAlpha)) this.waterState.nearAlpha = timecycleState.nearAlpha;
    if (Number.isFinite(timecycleState?.wavyAlpha)) this.waterState.wavyAlpha = timecycleState.wavyAlpha;
    if (Number.isFinite(timecycleState?.wakeAlpha)) this.waterState.wakeAlpha = timecycleState.wakeAlpha;

    this.farMaterial.color.copy(this.waterState.color);
    this.farMaterial.opacity = this.waterState.farAlpha;
    this.nearMaterial.uniforms.uColor.value.copy(this.waterState.color);
    this.nearMaterial.uniforms.uAlpha.value = this.waterState.nearAlpha;
    this.wakeMaterial.color.copy(this.waterState.color);
    this.wakeMaterial.opacity = this.waterState.wakeAlpha;
    if (fogColor && fogNear !== null && fogFar !== null) {
      const farFogNear = Math.max(0, Math.min(fogNear, fogFar - 1));
      const farFogFar = Math.max(farFogNear + 1, fogFar);
      const fog = this.farScene.fog?.isFog ? this.farScene.fog : new THREE.Fog(fogColor.clone(), farFogNear, farFogFar);
      fog.color.copy(fogColor);
      fog.near = farFogNear;
      fog.far = farFogFar;
      this.farScene.fog = fog;
      this.nearScene.fog = fog;
      this.wakeScene.fog = fog;
      this.nearMaterial.uniforms.uFogColor.value.copy(fogColor);
      this.nearMaterial.uniforms.uFogNear.value = farFogNear;
      this.nearMaterial.uniforms.uFogFar.value = farFogFar;
    } else {
      this.farScene.fog = null;
      this.nearScene.fog = null;
      this.wakeScene.fog = null;
    }

    this.updateWakeQuad(camera);
  }

  updateWakeQuad(camera) {
    if (!this.settings.showWake || !this.enabled || !this.nearMesh.visible || this.animationFade <= 0.001) {
      this.wakeMesh.visible = false;
      return;
    }
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) {
      this.wakeMesh.visible = false;
      return;
    }
    forward.normalize();
    const offset = forward.clone().multiplyScalar(-Math.max(this.fineCellSizeX, this.fineCellSizeY) * 0.45);
    this.wakeMesh.visible = true;
    this.wakeMesh.position.set(
      camera.position.x + offset.x,
      this.nearMesh.position.y + 0.03,
      camera.position.z + offset.z,
    );
    this.wakeMesh.rotation.y = Math.atan2(forward.x, forward.z);
  }

  renderFar(renderer, camera, background = null) {
    if (!this.enabled || !this.farMesh.visible) return;
    this.farScene.background = background ?? null;
    this.recoverBrokenGeometryBuffers();
    try {
      renderer.render(this.farScene, camera);
    } catch (error) {
      if (!isByteLengthUndefinedError(error)) throw error;
      this.recoverBrokenGeometryBuffers();
      renderer.render(this.farScene, camera);
    }
  }

  renderNear(renderer, camera) {
    if (!this.enabled || !this.nearMesh.visible) return;
    this.recoverBrokenGeometryBuffers();
    renderer.render(this.nearScene, camera);
  }

  renderWavy() {
    if (!this.enabled) return;
  }

  renderWake(renderer, camera) {
    if (!this.enabled || !this.wakeMesh.visible) return;
    this.recoverBrokenGeometryBuffers();
    renderer.render(this.wakeScene, camera);
  }

  dispose() {
    const items = [
      this.farMesh?.geometry,
      this.nearMesh?.geometry,
      this.wakeMesh?.geometry,
      this.farMaterial,
      this.nearMaterial,
      this.wakeMaterial,
      this.farTexture,
      this.nearTexture,
      this.wakeTexture,
    ];
    for (const item of items) {
      if (item && typeof item.dispose === 'function') item.dispose();
    }
    this.farScene.clear();
    this.nearScene.clear();
    this.wakeScene.clear();
  }
}
