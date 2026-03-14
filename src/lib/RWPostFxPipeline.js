import * as THREE from 'three';
import rwPostFxFullscreenVertexShader from '../shaders/postfx/fullscreen.vertex.glsl.js';
import rwPostFxCopyFragmentShader from '../shaders/postfx/copy.fragment.glsl.js';
import rwPostFxPresentFragmentShader from '../shaders/postfx/present.fragment.glsl.js';
import rwPostFxRadiosityThresholdFragmentShader from '../shaders/postfx/radiosity-threshold.fragment.glsl.js';
import rwPostFxRadiosityBlurFragmentShader from '../shaders/postfx/radiosity-blur.fragment.glsl.js';

const VCS_RADIOSITY_WIDTH = 256;
const VCS_RADIOSITY_HEIGHT = 128;
const VCS_BLUR_OFFSET = 2.1;
const VCS_BLUR_INTENSITY = (39.0 * 0.8) / 255.0;
const VCS_HISTORY_INTENSITY = 32 / 255.0;
const VCS_TRAILS_LIMIT = 80;
const VCS_TRAILS_INTENSITY = 38;
const VCS_RADIOSITY_TAP_WEIGHT = 36 / 255.0;
const VCS_RADIOSITY_OFFSETS_A = Object.freeze([
  new THREE.Vector2(-1, 0),
  new THREE.Vector2(1, 0),
  new THREE.Vector2(0, -1),
  new THREE.Vector2(0, 1),
]);
const VCS_RADIOSITY_OFFSETS_B = Object.freeze([
  new THREE.Vector2(-1, -1),
  new THREE.Vector2(1, -1),
  new THREE.Vector2(-1, 1),
  new THREE.Vector2(1, 1),
]);

function createRenderTarget(width, height, options = {}) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: options.depthBuffer === true,
    stencilBuffer: false,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.generateMipmaps = false;
  return target;
}

function setMaterialBlendConstant(material, scalar) {
  const clamped = THREE.MathUtils.clamp(scalar, 0, 1);
  material.blendColor.setRGB(clamped, clamped, clamped, THREE.LinearSRGBColorSpace);
}

function getFiniteOrDefault(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getBooleanOrDefault(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function setVector3FromColor(target, color, scale = 1) {
  target.set(
    (color?.r ?? 0) * scale,
    (color?.g ?? 0) * scale,
    (color?.b ?? 0) * scale,
  );
}

function normalizeByteChannel(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric >= 0 && numeric <= 1) {
    return THREE.MathUtils.clamp(Math.round(numeric * 255), 0, 255);
  }
  return THREE.MathUtils.clamp(Math.round(numeric), 0, 255);
}

function getColorConfig(config, key, fallbackAlpha) {
  const source = config?.[key] || {};
  return {
    r: normalizeByteChannel(source.r, key === 'filterColor1' ? 128 : 0),
    g: normalizeByteChannel(source.g, key === 'filterColor1' ? 128 : 0),
    b: normalizeByteChannel(source.b, key === 'filterColor1' ? 128 : 0),
    a: normalizeByteChannel(source.a, fallbackAlpha),
  };
}

export class RWPostFxPipeline {
  constructor(options = {}) {
    this.enabled = true;
    this.viewportWidth = 1;
    this.viewportHeight = 1;
    this.hasHistory = false;

    this.sceneTarget = null;
    this.composeTarget = null;
    this.frontBufferTarget = null;
    this.lastFrameTarget = null;
    this.radiosityTargetA = null;
    this.radiosityTargetB = null;

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
    this.camera.position.z = 1;
    this.scene = new THREE.Scene();

    const geometry = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(geometry, null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uUvOffset: { value: new THREE.Vector2(0, 0) },
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uOpacity: { value: 1 },
      },
      vertexShader: rwPostFxFullscreenVertexShader,
      fragmentShader: rwPostFxCopyFragmentShader,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      toneMapped: false,
    });

    this.presentMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uUvOffset: { value: new THREE.Vector2(0, 0) },
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uOpacity: { value: 1 },
      },
      vertexShader: rwPostFxFullscreenVertexShader,
      fragmentShader: rwPostFxPresentFragmentShader,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      toneMapped: false,
    });

    this.thresholdMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uLimit: { value: 0.5 },
      },
      vertexShader: rwPostFxFullscreenVertexShader,
      fragmentShader: rwPostFxRadiosityThresholdFragmentShader,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      toneMapped: false,
    });

    this.radiosityBlurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uTexelSize: { value: new THREE.Vector2(1 / VCS_RADIOSITY_WIDTH, 1 / VCS_RADIOSITY_HEIGHT) },
        uOffsets: {
          value: [
            new THREE.Vector2(),
            new THREE.Vector2(),
            new THREE.Vector2(),
            new THREE.Vector2(),
          ],
        },
        uTapWeight: { value: VCS_RADIOSITY_TAP_WEIGHT },
      },
      vertexShader: rwPostFxFullscreenVertexShader,
      fragmentShader: rwPostFxRadiosityBlurFragmentShader,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      toneMapped: false,
    });

    this.accumulationMaterial = this.copyMaterial.clone();
    this.accumulationMaterial.transparent = true;
    this.accumulationMaterial.blending = THREE.CustomBlending;
    this.accumulationMaterial.blendSrc = THREE.ConstantColorFactor;
    this.accumulationMaterial.blendDst = THREE.OneMinusConstantColorFactor;
    this.accumulationMaterial.blendEquation = THREE.AddEquation;
    this.accumulationMaterial.blendSrcAlpha = THREE.OneFactor;
    this.accumulationMaterial.blendDstAlpha = THREE.ZeroFactor;
    this.accumulationMaterial.blendEquationAlpha = THREE.AddEquation;
    this.accumulationMaterial.blendColor = new THREE.Color(VCS_BLUR_INTENSITY, VCS_BLUR_INTENSITY, VCS_BLUR_INTENSITY);

    this.additiveMaterial = this.copyMaterial.clone();
    this.additiveMaterial.transparent = true;
    this.additiveMaterial.blending = THREE.AdditiveBlending;
    this.additiveMaterial.blendSrcAlpha = THREE.OneFactor;
    this.additiveMaterial.blendDstAlpha = THREE.ZeroFactor;
    this.additiveMaterial.blendEquationAlpha = THREE.AddEquation;

    this.colourFilterAddMaterial = this.copyMaterial.clone();
    this.colourFilterAddMaterial.transparent = true;
    this.colourFilterAddMaterial.blending = THREE.CustomBlending;
    this.colourFilterAddMaterial.blendSrc = THREE.SrcAlphaFactor;
    this.colourFilterAddMaterial.blendDst = THREE.OneFactor;
    this.colourFilterAddMaterial.blendEquation = THREE.AddEquation;
    this.colourFilterAddMaterial.blendSrcAlpha = THREE.OneFactor;
    this.colourFilterAddMaterial.blendDstAlpha = THREE.ZeroFactor;
    this.colourFilterAddMaterial.blendEquationAlpha = THREE.AddEquation;

    this.radiosityCompositeMaterial = this.copyMaterial.clone();
    this.radiosityCompositeMaterial.transparent = true;
    this.radiosityCompositeMaterial.blending = THREE.CustomBlending;
    this.radiosityCompositeMaterial.blendSrc = THREE.ConstantColorFactor;
    this.radiosityCompositeMaterial.blendDst = THREE.OneFactor;
    this.radiosityCompositeMaterial.blendEquation = THREE.AddEquation;
    this.radiosityCompositeMaterial.blendColor = new THREE.Color(0, 0, 0);

    this.runtime = {
      filterColor1Rgb: new THREE.Color(1, 1, 1),
      filterColor1Alpha: 1,
      filterColor2Rgb: new THREE.Color(0, 0, 0),
      filterColor2Alpha: 0,
      blurColor: new THREE.Color(0, 0, 0),
      radiosityLimit: VCS_TRAILS_LIMIT,
      radiosityIntensity: VCS_TRAILS_INTENSITY,
      blurOffset: VCS_BLUR_OFFSET,
      blurIntensity: VCS_BLUR_INTENSITY,
      historyIntensity: VCS_HISTORY_INTENSITY,
      enableColourFilter: true,
      enableRadiosity: true,
      enableBlur: true,
      enableHistory: true,
    };
    this.setConfig(options);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.resetHistory();
  }

  resetHistory() {
    this.hasHistory = false;
  }

  setConfig(config = {}) {
    this.runtime.radiosityLimit = THREE.MathUtils.clamp(getFiniteOrDefault(config.trailsLimit, VCS_TRAILS_LIMIT), 0, 255);
    this.runtime.radiosityIntensity = THREE.MathUtils.clamp(getFiniteOrDefault(config.trailsIntensity, VCS_TRAILS_INTENSITY), 0, 63);
    this.runtime.blurOffset = Math.max(0, getFiniteOrDefault(config.blurOffset, VCS_BLUR_OFFSET));
    this.runtime.blurIntensity = THREE.MathUtils.clamp(getFiniteOrDefault(config.blurIntensity, VCS_BLUR_INTENSITY), 0, 1);
    this.runtime.historyIntensity = THREE.MathUtils.clamp(getFiniteOrDefault(config.historyIntensity, VCS_HISTORY_INTENSITY), 0, 1);
    this.runtime.enableColourFilter = getBooleanOrDefault(config.enableColourFilter, true);
    this.runtime.enableRadiosity = getBooleanOrDefault(config.enableRadiosity, true);
    this.runtime.enableBlur = getBooleanOrDefault(config.enableBlur, true);
    this.runtime.enableHistory = getBooleanOrDefault(config.enableHistory, true);
    const filterColor1 = getColorConfig(config, 'filterColor1', 255);
    const filterColor2 = getColorConfig(config, 'filterColor2', 0);
    this.runtime.filterColor1Rgb.setRGB(
      filterColor1.r / 255,
      filterColor1.g / 255,
      filterColor1.b / 255,
      THREE.LinearSRGBColorSpace,
    );
    this.runtime.filterColor1Alpha = filterColor1.a / 255;
    this.runtime.filterColor2Rgb.setRGB(
      filterColor2.r / 255,
      filterColor2.g / 255,
      filterColor2.b / 255,
      THREE.LinearSRGBColorSpace,
    );
    this.runtime.filterColor2Alpha = filterColor2.a / 255;
    this.runtime.blurColor.copy(this.runtime.filterColor2Rgb);
  }

  ensureSize(width, height) {
    const nextWidth = Math.max(1, Math.floor(width || 1));
    const nextHeight = Math.max(1, Math.floor(height || 1));
    if (
      this.viewportWidth === nextWidth
      && this.viewportHeight === nextHeight
      && this.sceneTarget
      && this.composeTarget
      && this.frontBufferTarget
      && this.lastFrameTarget
      && this.radiosityTargetA
      && this.radiosityTargetB
    ) {
      return;
    }
    this.viewportWidth = nextWidth;
    this.viewportHeight = nextHeight;

    this.sceneTarget?.dispose();
    this.composeTarget?.dispose();
    this.frontBufferTarget?.dispose();
    this.lastFrameTarget?.dispose();
    this.radiosityTargetA?.dispose();
    this.radiosityTargetB?.dispose();

    this.sceneTarget = createRenderTarget(nextWidth, nextHeight, { depthBuffer: true });
    this.composeTarget = createRenderTarget(nextWidth, nextHeight);
    this.frontBufferTarget = createRenderTarget(nextWidth, nextHeight);
    this.lastFrameTarget = createRenderTarget(nextWidth, nextHeight);
    this.radiosityTargetA = createRenderTarget(VCS_RADIOSITY_WIDTH, VCS_RADIOSITY_HEIGHT);
    this.radiosityTargetB = createRenderTarget(VCS_RADIOSITY_WIDTH, VCS_RADIOSITY_HEIGHT);
    this.resetHistory();
  }

  updateRuntime(runtimeContext = {}) {
    void runtimeContext;
  }

  beginSceneCapture(runtimeContext = {}) {
    const width = runtimeContext.viewportWidth || this.viewportWidth;
    const height = runtimeContext.viewportHeight || this.viewportHeight;
    this.ensureSize(width, height);
    return this.enabled ? this.sceneTarget : null;
  }

  captureScene(runtimeContext = {}) {
    return this.beginSceneCapture(runtimeContext);
  }

  primeFrontBuffer(renderer) {
    this.copyTarget(renderer, this.sceneTarget, this.frontBufferTarget, true);
  }

  renderFullscreen(renderer, target, material, clear = false) {
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    renderer.setRenderTarget(target);
    renderer.autoClear = false;
    if (clear) renderer.clear(true, true, true);
    this.quad.material = material;
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }

  copyTarget(renderer, source, destination, clear = true) {
    this.copyMaterial.uniforms.uTex.value = source.texture;
    this.copyMaterial.uniforms.uUvOffset.value.set(0, 0);
    this.copyMaterial.uniforms.uColor.value.set(1, 1, 1);
    this.copyMaterial.uniforms.uOpacity.value = 1;
    this.copyMaterial.transparent = false;
    this.copyMaterial.blending = THREE.NormalBlending;
    this.renderFullscreen(renderer, destination, this.copyMaterial, clear);
  }

  presentTarget(renderer, source, clear = true) {
    this.presentMaterial.uniforms.uTex.value = source.texture;
    this.presentMaterial.uniforms.uUvOffset.value.set(0, 0);
    this.presentMaterial.uniforms.uColor.value.set(1, 1, 1);
    this.presentMaterial.uniforms.uOpacity.value = 1;
    this.presentMaterial.transparent = false;
    this.presentMaterial.blending = THREE.NormalBlending;
    this.renderFullscreen(renderer, null, this.presentMaterial, clear);
  }

  runColourFilterStage(renderer) {
    if (!this.runtime.enableColourFilter) {
      this.copyTarget(renderer, this.frontBufferTarget, this.composeTarget, true);
      return;
    }
    // VCS follows SKYGFX::ColourFilter_PS2/ColourFilter_switch semantics here.
    // reVC's extended VC colourfilter shader is a different path and is intentionally not used.
    this.copyMaterial.uniforms.uTex.value = this.frontBufferTarget.texture;
    this.copyMaterial.uniforms.uUvOffset.value.set(0, 0);
    setVector3FromColor(this.copyMaterial.uniforms.uColor.value, this.runtime.filterColor1Rgb, 255 / 128);
    this.copyMaterial.uniforms.uOpacity.value = 1;
    this.copyMaterial.transparent = false;
    this.copyMaterial.blending = THREE.NormalBlending;
    this.renderFullscreen(renderer, this.composeTarget, this.copyMaterial, true);

    if (this.runtime.filterColor2Alpha <= 0) return;

    this.colourFilterAddMaterial.uniforms.uTex.value = this.frontBufferTarget.texture;
    this.colourFilterAddMaterial.uniforms.uUvOffset.value.set(0, 0);
    setVector3FromColor(this.colourFilterAddMaterial.uniforms.uColor.value, this.runtime.filterColor2Rgb);
    this.colourFilterAddMaterial.uniforms.uOpacity.value = this.runtime.filterColor2Alpha;
    this.renderFullscreen(renderer, this.composeTarget, this.colourFilterAddMaterial, false);
  }

  updateFrontBuffer(renderer) {
    this.copyTarget(renderer, this.composeTarget, this.frontBufferTarget, true);
  }

  runRadiosityStage(renderer) {
    if (!this.runtime.enableRadiosity || this.runtime.radiosityIntensity <= 0) return;

    this.thresholdMaterial.uniforms.uTex.value = this.frontBufferTarget.texture;
    this.thresholdMaterial.uniforms.uLimit.value = this.runtime.radiosityLimit / 255.0;
    this.renderFullscreen(renderer, this.radiosityTargetB, this.thresholdMaterial, true);

    const offsetGroups = [VCS_RADIOSITY_OFFSETS_A, VCS_RADIOSITY_OFFSETS_B];
    let source = this.radiosityTargetB;
    let destination = this.radiosityTargetA;
    for (let pass = 0; pass < 4; pass += 1) {
      const group = offsetGroups[pass % 2];
      this.radiosityBlurMaterial.uniforms.uTex.value = source.texture;
      this.radiosityBlurMaterial.uniforms.uOffsets.value[0].copy(group[0]);
      this.radiosityBlurMaterial.uniforms.uOffsets.value[1].copy(group[1]);
      this.radiosityBlurMaterial.uniforms.uOffsets.value[2].copy(group[2]);
      this.radiosityBlurMaterial.uniforms.uOffsets.value[3].copy(group[3]);
      this.renderFullscreen(renderer, destination, this.radiosityBlurMaterial, true);
      const tmp = source;
      source = destination;
      destination = tmp;
    }

    this.radiosityCompositeMaterial.uniforms.uTex.value = source.texture;
    this.radiosityCompositeMaterial.uniforms.uUvOffset.value.set(0, 0);
    this.radiosityCompositeMaterial.uniforms.uColor.value.set(1, 1, 1);
    this.radiosityCompositeMaterial.uniforms.uOpacity.value = 1;
    const factor = THREE.MathUtils.clamp((this.runtime.radiosityIntensity * 4) / 255.0, 0, 1);
    setMaterialBlendConstant(this.radiosityCompositeMaterial, factor);
    this.renderFullscreen(renderer, this.composeTarget, this.radiosityCompositeMaterial, false);
    this.renderFullscreen(renderer, this.composeTarget, this.radiosityCompositeMaterial, false);
  }

  runBlurStage(renderer) {
    if (!this.runtime.enableBlur) return;

    this.accumulationMaterial.uniforms.uTex.value = this.frontBufferTarget.texture;
    this.accumulationMaterial.uniforms.uColor.value.set(1, 1, 1);
    this.accumulationMaterial.uniforms.uOpacity.value = 1;
    setMaterialBlendConstant(this.accumulationMaterial, this.runtime.blurIntensity);

    const offsets = [
      new THREE.Vector2(this.runtime.blurOffset / this.viewportWidth, 0),
      new THREE.Vector2(this.runtime.blurOffset / this.viewportWidth, this.runtime.blurOffset / this.viewportHeight),
      new THREE.Vector2(0, this.runtime.blurOffset / this.viewportHeight),
    ];
    for (const offset of offsets) {
      this.accumulationMaterial.uniforms.uUvOffset.value.copy(offset);
      this.renderFullscreen(renderer, this.composeTarget, this.accumulationMaterial, false);
    }

    this.additiveMaterial.uniforms.uTex.value = this.frontBufferTarget.texture;
    this.additiveMaterial.uniforms.uUvOffset.value.set(0, 0);
    setVector3FromColor(this.additiveMaterial.uniforms.uColor.value, this.runtime.blurColor);
    this.additiveMaterial.uniforms.uOpacity.value = 1;
    this.renderFullscreen(renderer, this.composeTarget, this.additiveMaterial, false);

    if (this.runtime.enableHistory && this.hasHistory) {
      this.accumulationMaterial.uniforms.uTex.value = this.lastFrameTarget.texture;
      this.accumulationMaterial.uniforms.uUvOffset.value.set(0, 0);
      this.accumulationMaterial.uniforms.uColor.value.set(1, 1, 1);
      setMaterialBlendConstant(this.accumulationMaterial, this.runtime.historyIntensity);
      this.renderFullscreen(renderer, this.composeTarget, this.accumulationMaterial, false);
    }
  }

  present(renderer) {
    this.presentTarget(renderer, this.composeTarget, true);
  }

  applyVcsPostFx(renderer, runtimeContext = {}) {
    if (!this.enabled || !renderer?.setRenderTarget || !this.sceneTarget) return;
    const width = runtimeContext.viewportWidth || this.viewportWidth;
    const height = runtimeContext.viewportHeight || this.viewportHeight;
    this.ensureSize(width, height);
    this.updateRuntime(runtimeContext);

    this.primeFrontBuffer(renderer);
    this.runColourFilterStage(renderer);
    this.updateFrontBuffer(renderer);
    this.runRadiosityStage(renderer);
    this.updateFrontBuffer(renderer);
    this.runBlurStage(renderer);
    this.present(renderer);
  }

  endFrame(renderer) {
    if (!this.enabled || !renderer?.setRenderTarget || !this.composeTarget || !this.lastFrameTarget) return;
    this.copyTarget(renderer, this.composeTarget, this.lastFrameTarget, true);
    this.hasHistory = true;
  }

  render(renderer, runtimeContext = {}) {
    this.applyVcsPostFx(renderer, runtimeContext);
    this.endFrame(renderer);
  }

  dispose() {
    this.sceneTarget?.dispose();
    this.composeTarget?.dispose();
    this.frontBufferTarget?.dispose();
    this.lastFrameTarget?.dispose();
    this.radiosityTargetA?.dispose();
    this.radiosityTargetB?.dispose();
    this.copyMaterial.dispose();
    this.presentMaterial.dispose();
    this.thresholdMaterial.dispose();
    this.radiosityBlurMaterial.dispose();
    this.accumulationMaterial.dispose();
    this.additiveMaterial.dispose();
    this.colourFilterAddMaterial.dispose();
    this.radiosityCompositeMaterial.dispose();
    this.quad.geometry.dispose();
  }
}

export default RWPostFxPipeline;
