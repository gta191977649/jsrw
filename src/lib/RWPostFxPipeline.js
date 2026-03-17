import * as THREE from 'three';
import rwPostFxFullscreenVertexShader from '../shaders/postfx/fullscreen.vertex.glsl.js';
import rwPostFxCopyFragmentShader from '../shaders/postfx/copy.fragment.glsl.js';
import rwPostFxPresentFragmentShader from '../shaders/postfx/present.fragment.glsl.js';
const SKYGFX_RADIOSITY_FILTER_PASSES = 2;
const SKYGFX_RADIOSITY_RENDER_PASSES = 1;
const SKYGFX_RADIOSITY_INTENSITY = 0x23;
const SKYGFX_RADIOSITY_U_CORRECTION = 2;
const SKYGFX_RADIOSITY_V_CORRECTION = 2;
const VCS_BLUR_OFFSET = 2.1;
const VCS_BLUR_INTENSITY = (39.0 * 0.8) / 255.0;
const VCS_HISTORY_INTENSITY = 32 / 255.0;
const VCS_TRAILS_LIMIT = 80;
const VCS_TRAILS_INTENSITY = 38;
const POSTFX_DEBUG_VIEW = Object.freeze({
  FINAL: 'final',
  SCENE: 'scene',
  FRONTBUFFER: 'frontbuffer',
  RADIOSITY_BLUR_A: 'radiosity-blur-a',
  RADIOSITY_BLUR_B: 'radiosity-blur-b',
  RADIOSITY_RESULT: 'radiosity-result',
  BLUR_SOURCE: 'blur-source',
  HISTORY: 'history',
  BLUR_TINT: 'blur-tint',
});

function getPostFxDebugViewOrDefault(value) {
  return Object.values(POSTFX_DEBUG_VIEW).includes(value) ? value : POSTFX_DEBUG_VIEW.FINAL;
}

function createRenderTarget(width, height, options = {}) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: options.depthBuffer === true,
    stencilBuffer: false,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.generateMipmaps = false;
  target.texture.userData = {
    ...(target.texture.userData || {}),
    rwRenderTarget: target,
  };
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

function getClampedScalar(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return THREE.MathUtils.clamp(numeric, min, max);
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
    this.blurCurrentTarget = null;
    this.blurHistoryTarget = null;
    this.debugColourFilterTarget = null;
    this.debugRadiosityTarget = null;
    this.debugBlurTarget = null;

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

    this.radiosityBlurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uDirection: { value: new THREE.Vector2(0, 0) },
        uScale: { value: 1 },
      },
      vertexShader: rwPostFxFullscreenVertexShader,
      fragmentShader: `
uniform sampler2D uTex;
uniform vec2 uDirection;
uniform float uScale;
varying vec2 vUv;

void main() {
  vec4 color = vec4(0.0);
  for (int i = 0; i < 10; i += 1) {
    float t = (float(i) / 9.0) - 0.5;
    color += texture2D(uTex, clamp(vUv + (uDirection * t * uScale), 0.0, 1.0));
  }
  gl_FragColor = vec4(color.rgb / 10.0, 1.0);
}
`,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      toneMapped: false,
    });

    this.radiosityCompositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uLimit: { value: 0.0 },
        uIntensity: { value: 0.0 },
        uRenderPasses: { value: SKYGFX_RADIOSITY_RENDER_PASSES },
        uUvOffset: { value: new THREE.Vector2(0, 0) },
        uUvScale: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: rwPostFxFullscreenVertexShader,
      fragmentShader: `
uniform sampler2D uTex;
uniform float uLimit;
uniform float uIntensity;
uniform float uRenderPasses;
uniform vec2 uUvOffset;
uniform vec2 uUvScale;
varying vec2 vUv;

void main() {
  vec2 uv = (vUv * uUvScale) + uUvOffset;
  vec3 color = texture2D(uTex, clamp(uv, 0.0, 1.0)).rgb;
  color = clamp((color * 2.0) - vec3(uLimit), vec3(0.0), vec3(1.0));
  color *= (uIntensity * uRenderPasses);
  gl_FragColor = vec4(color, 1.0);
}
`,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    });
    this.radiosityCompositeMaterial.blending = THREE.CustomBlending;
    this.radiosityCompositeMaterial.blendSrc = THREE.OneFactor;
    this.radiosityCompositeMaterial.blendDst = THREE.OneFactor;
    this.radiosityCompositeMaterial.blendEquation = THREE.AddEquation;
    this.radiosityCompositeMaterial.blendSrcAlpha = THREE.OneFactor;
    this.radiosityCompositeMaterial.blendDstAlpha = THREE.ZeroFactor;
    this.radiosityCompositeMaterial.blendEquationAlpha = THREE.AddEquation;

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

    this.solidColorMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Vector3(0, 0, 0) },
        uOpacity: { value: 1 },
      },
      vertexShader: rwPostFxFullscreenVertexShader,
      fragmentShader: `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
}
`,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    });
    this.solidColorMaterial.blending = THREE.AdditiveBlending;
    this.solidColorMaterial.blendSrcAlpha = THREE.OneFactor;
    this.solidColorMaterial.blendDstAlpha = THREE.ZeroFactor;
    this.solidColorMaterial.blendEquationAlpha = THREE.AddEquation;

    this.configRuntime = {
      filterColor1Rgb: new THREE.Color(1, 1, 1),
      filterColor1Alpha: 1,
      filterColor2Rgb: new THREE.Color(0, 0, 0),
      filterColor2Alpha: 0,
      blurColor: new THREE.Color(0, 0, 0),
      radiosityLimit: VCS_TRAILS_LIMIT,
      radiosityIntensity: SKYGFX_RADIOSITY_INTENSITY,
      blurOffset: VCS_BLUR_OFFSET,
      blurIntensity: VCS_BLUR_INTENSITY,
      historyIntensity: VCS_HISTORY_INTENSITY,
      enableColourFilter: true,
      enableRadiosity: true,
      enableBlur: true,
      enableHistory: true,
      debugView: POSTFX_DEBUG_VIEW.FINAL,
    };
    this.runtime = {
      filterColor1Rgb: new THREE.Color(1, 1, 1),
      filterColor1Alpha: 1,
      filterColor2Rgb: new THREE.Color(0, 0, 0),
      filterColor2Alpha: 0,
      blurColor: new THREE.Color(0, 0, 0),
      radiosityLimit: VCS_TRAILS_LIMIT,
      radiosityIntensity: SKYGFX_RADIOSITY_INTENSITY,
      blurOffset: VCS_BLUR_OFFSET,
      blurIntensity: VCS_BLUR_INTENSITY,
      historyIntensity: VCS_HISTORY_INTENSITY,
      enableColourFilter: true,
      enableRadiosity: true,
      enableBlur: true,
      enableHistory: true,
      debugView: POSTFX_DEBUG_VIEW.FINAL,
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
    const nextRadiosityLimit = THREE.MathUtils.clamp(getFiniteOrDefault(config.trailsLimit, VCS_TRAILS_LIMIT), 0, 255);
    const nextRadiosityIntensity = THREE.MathUtils.clamp(getFiniteOrDefault(config.trailsIntensity, SKYGFX_RADIOSITY_INTENSITY), 0, 63);
    const nextBlurOffset = Math.max(0, getFiniteOrDefault(config.blurOffset, VCS_BLUR_OFFSET));
    const nextBlurIntensity = THREE.MathUtils.clamp(getFiniteOrDefault(config.blurIntensity, VCS_BLUR_INTENSITY), 0, 1);
    const nextHistoryIntensity = THREE.MathUtils.clamp(getFiniteOrDefault(config.historyIntensity, VCS_HISTORY_INTENSITY), 0, 1);
    const nextEnableColourFilter = getBooleanOrDefault(config.enableColourFilter, true);
    const nextEnableRadiosity = getBooleanOrDefault(config.enableRadiosity, true);
    const nextEnableBlur = getBooleanOrDefault(config.enableBlur, true);
    const nextEnableHistory = getBooleanOrDefault(config.enableHistory, true);
    const nextDebugView = getPostFxDebugViewOrDefault(config.debugView);
    const filterColor1 = getColorConfig(config, 'filterColor1', 255);
    const filterColor2 = getColorConfig(config, 'filterColor2', 0);
    const configChanged = (
      this.configRuntime.radiosityLimit !== nextRadiosityLimit
      || this.configRuntime.radiosityIntensity !== nextRadiosityIntensity
      || this.configRuntime.blurOffset !== nextBlurOffset
      || this.configRuntime.blurIntensity !== nextBlurIntensity
      || this.configRuntime.historyIntensity !== nextHistoryIntensity
      || this.configRuntime.enableColourFilter !== nextEnableColourFilter
      || this.configRuntime.enableRadiosity !== nextEnableRadiosity
      || this.configRuntime.enableBlur !== nextEnableBlur
      || this.configRuntime.enableHistory !== nextEnableHistory
      || this.configRuntime.debugView !== nextDebugView
      || Math.round(this.configRuntime.filterColor1Rgb.r * 255) !== filterColor1.r
      || Math.round(this.configRuntime.filterColor1Rgb.g * 255) !== filterColor1.g
      || Math.round(this.configRuntime.filterColor1Rgb.b * 255) !== filterColor1.b
      || Math.round(this.configRuntime.filterColor2Rgb.r * 255) !== filterColor2.r
      || Math.round(this.configRuntime.filterColor2Rgb.g * 255) !== filterColor2.g
      || Math.round(this.configRuntime.filterColor2Rgb.b * 255) !== filterColor2.b
      || Math.round(this.configRuntime.filterColor1Alpha * 255) !== filterColor1.a
      || Math.round(this.configRuntime.filterColor2Alpha * 255) !== filterColor2.a
    );

    this.configRuntime.radiosityLimit = nextRadiosityLimit;
    this.configRuntime.radiosityIntensity = nextRadiosityIntensity;
    this.configRuntime.blurOffset = nextBlurOffset;
    this.configRuntime.blurIntensity = nextBlurIntensity;
    this.configRuntime.historyIntensity = nextHistoryIntensity;
    this.configRuntime.enableColourFilter = nextEnableColourFilter;
    this.configRuntime.enableRadiosity = nextEnableRadiosity;
    this.configRuntime.enableBlur = nextEnableBlur;
    this.configRuntime.enableHistory = nextEnableHistory;
    this.configRuntime.debugView = nextDebugView;
    this.configRuntime.filterColor1Rgb.setRGB(
      filterColor1.r / 255,
      filterColor1.g / 255,
      filterColor1.b / 255,
      THREE.LinearSRGBColorSpace,
    );
    this.configRuntime.filterColor1Alpha = filterColor1.a / 255;
    this.configRuntime.filterColor2Rgb.setRGB(
      filterColor2.r / 255,
      filterColor2.g / 255,
      filterColor2.b / 255,
      THREE.LinearSRGBColorSpace,
    );
    this.configRuntime.filterColor2Alpha = filterColor2.a / 255;
    this.configRuntime.blurColor.copy(this.configRuntime.filterColor2Rgb);

    this.runtime.filterColor1Rgb.copy(this.configRuntime.filterColor1Rgb);
    this.runtime.filterColor1Alpha = this.configRuntime.filterColor1Alpha;
    this.runtime.filterColor2Rgb.copy(this.configRuntime.filterColor2Rgb);
    this.runtime.filterColor2Alpha = this.configRuntime.filterColor2Alpha;
    this.runtime.blurColor.copy(this.configRuntime.blurColor);
    this.runtime.radiosityLimit = this.configRuntime.radiosityLimit;
    this.runtime.radiosityIntensity = this.configRuntime.radiosityIntensity;
    this.runtime.blurOffset = this.configRuntime.blurOffset;
    this.runtime.blurIntensity = this.configRuntime.blurIntensity;
    this.runtime.historyIntensity = this.configRuntime.historyIntensity;
    this.runtime.enableColourFilter = this.configRuntime.enableColourFilter;
    this.runtime.enableRadiosity = this.configRuntime.enableRadiosity;
    this.runtime.enableBlur = this.configRuntime.enableBlur;
    this.runtime.enableHistory = this.configRuntime.enableHistory;
    this.runtime.debugView = this.configRuntime.debugView;

    if (configChanged) this.resetHistory();
    if (!this.runtime.enableHistory) this.resetHistory();
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
      && this.blurCurrentTarget
      && this.blurHistoryTarget
      && this.debugColourFilterTarget
      && this.debugRadiosityTarget
      && this.debugBlurTarget
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
    this.blurCurrentTarget?.dispose();
    this.blurHistoryTarget?.dispose();
    this.debugColourFilterTarget?.dispose();
    this.debugRadiosityTarget?.dispose();
    this.debugBlurTarget?.dispose();

    this.sceneTarget = createRenderTarget(nextWidth, nextHeight, { depthBuffer: true });
    this.composeTarget = createRenderTarget(nextWidth, nextHeight);
    this.frontBufferTarget = createRenderTarget(nextWidth, nextHeight);
    this.lastFrameTarget = createRenderTarget(nextWidth, nextHeight);
    this.radiosityTargetA = createRenderTarget(nextWidth, nextHeight);
    this.radiosityTargetB = createRenderTarget(nextWidth, nextHeight);
    this.blurCurrentTarget = createRenderTarget(nextWidth, nextHeight);
    this.blurHistoryTarget = createRenderTarget(nextWidth, nextHeight);
    this.debugColourFilterTarget = createRenderTarget(nextWidth, nextHeight);
    this.debugRadiosityTarget = createRenderTarget(nextWidth, nextHeight);
    this.debugBlurTarget = createRenderTarget(nextWidth, nextHeight);
    this.resetHistory();
  }

  updateRuntime(runtimeContext = {}) {
    this.runtime.filterColor1Rgb.copy(this.configRuntime.filterColor1Rgb);
    this.runtime.filterColor1Alpha = this.configRuntime.filterColor1Alpha;
    this.runtime.filterColor2Rgb.copy(this.configRuntime.filterColor2Rgb);
    this.runtime.filterColor2Alpha = this.configRuntime.filterColor2Alpha;
    this.runtime.radiosityLimit = this.configRuntime.radiosityLimit;
    this.runtime.radiosityIntensity = this.configRuntime.radiosityIntensity;
    this.runtime.blurOffset = this.configRuntime.blurOffset;
    this.runtime.blurIntensity = this.configRuntime.blurIntensity;
    this.runtime.historyIntensity = this.configRuntime.historyIntensity;
    this.runtime.enableColourFilter = this.configRuntime.enableColourFilter;
    this.runtime.enableRadiosity = this.configRuntime.enableRadiosity;
    this.runtime.enableBlur = this.configRuntime.enableBlur;
    this.runtime.enableHistory = this.configRuntime.enableHistory;
    this.runtime.debugView = this.configRuntime.debugView;

    const values = runtimeContext?.timecycleCurrent?.values;
    if (!values || !this.runtime.enableColourFilter || !values.blur) {
      this.runtime.blurColor.setRGB(0, 0, 0, THREE.LinearSRGBColorSpace);
      return;
    }

    this.runtime.blurColor.setRGB(
      getClampedScalar(values.blur.r, 0, 255, 0) / 255,
      getClampedScalar(values.blur.g, 0, 255, 0) / 255,
      getClampedScalar(values.blur.b, 0, 255, 0) / 255,
      THREE.LinearSRGBColorSpace,
    );
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

  captureDebugStage(renderer, source, destination) {
    if (!source || !destination) return;
    this.copyTarget(renderer, source, destination, true);
  }

  runRadiosityStage(renderer) {
    if (!this.runtime.enableRadiosity || this.runtime.radiosityIntensity <= 0) return;

    const blurScale = (2 ** SKYGFX_RADIOSITY_FILTER_PASSES) * (this.viewportWidth / 640.0);
    this.radiosityBlurMaterial.uniforms.uTex.value = this.frontBufferTarget.texture;
    this.radiosityBlurMaterial.uniforms.uDirection.value.set(0, 1 / Math.max(1, this.frontBufferTarget.height));
    this.radiosityBlurMaterial.uniforms.uScale.value = blurScale;
    this.renderFullscreen(renderer, this.radiosityTargetA, this.radiosityBlurMaterial, true);

    this.radiosityBlurMaterial.uniforms.uTex.value = this.radiosityTargetA.texture;
    this.radiosityBlurMaterial.uniforms.uDirection.value.set(1 / Math.max(1, this.frontBufferTarget.width), 0);
    this.radiosityBlurMaterial.uniforms.uScale.value = blurScale;
    this.renderFullscreen(renderer, this.radiosityTargetB, this.radiosityBlurMaterial, true);

    const off = (2 ** SKYGFX_RADIOSITY_FILTER_PASSES) - 1;
    const offU = off * SKYGFX_RADIOSITY_U_CORRECTION;
    const offV = off * SKYGFX_RADIOSITY_V_CORRECTION;
    const maxU = this.viewportWidth - offU;
    const maxV = this.viewportHeight - offV;
    const cU = ((offU * (this.viewportWidth + 0.5)) + (offU * 0.5)) / this.viewportWidth;
    const cV = ((offV * (this.viewportHeight + 0.5)) + (offV * 0.5)) / this.viewportHeight;

    this.radiosityCompositeMaterial.uniforms.uTex.value = this.radiosityTargetB.texture;
    this.radiosityCompositeMaterial.uniforms.uLimit.value = this.runtime.radiosityLimit / 255.0;
    this.radiosityCompositeMaterial.uniforms.uIntensity.value = THREE.MathUtils.clamp(
      this.runtime.radiosityIntensity / 255.0,
      0,
      1,
    );
    this.radiosityCompositeMaterial.uniforms.uRenderPasses.value = SKYGFX_RADIOSITY_RENDER_PASSES;
    this.radiosityCompositeMaterial.uniforms.uUvOffset.value.set(
      cU / Math.max(1, this.frontBufferTarget.width),
      cV / Math.max(1, this.frontBufferTarget.height),
    );
    this.radiosityCompositeMaterial.uniforms.uUvScale.value.set(
      (maxU - offU) / Math.max(1, this.viewportWidth),
      (maxV - offV) / Math.max(1, this.viewportHeight),
    );
    this.renderFullscreen(renderer, this.composeTarget, this.radiosityCompositeMaterial, false);
  }

  runBlurStage(renderer) {
    if (!this.runtime.enableBlur) return;

    // VCS trails sample the original captured front buffer, not a colour-filtered or radiosity-fed result.
    this.copyTarget(renderer, this.frontBufferTarget, this.blurCurrentTarget, true);

    this.accumulationMaterial.uniforms.uTex.value = this.blurCurrentTarget.texture;
    this.accumulationMaterial.uniforms.uColor.value.set(1, 1, 1);
    this.accumulationMaterial.uniforms.uOpacity.value = 1;
    setMaterialBlendConstant(this.accumulationMaterial, this.runtime.blurIntensity);

    const blurOffset = this.runtime.blurOffset;
    const blurIntensity = this.runtime.blurIntensity;
    const offsets = [
      new THREE.Vector2(blurOffset / this.blurCurrentTarget.width, 0),
      new THREE.Vector2(blurOffset / this.blurCurrentTarget.width, blurOffset / this.blurCurrentTarget.height),
      new THREE.Vector2(0, blurOffset / this.blurCurrentTarget.height),
    ];
    setMaterialBlendConstant(this.accumulationMaterial, blurIntensity);
    for (const offset of offsets) {
      this.accumulationMaterial.uniforms.uUvOffset.value.copy(offset);
      this.renderFullscreen(renderer, this.composeTarget, this.accumulationMaterial, false);
    }

    setVector3FromColor(this.solidColorMaterial.uniforms.uColor.value, this.runtime.blurColor);
    this.solidColorMaterial.uniforms.uOpacity.value = 1;
    this.renderFullscreen(renderer, this.composeTarget, this.solidColorMaterial, false);

    if (this.runtime.enableHistory && this.hasHistory) {
      this.accumulationMaterial.uniforms.uTex.value = this.blurHistoryTarget.texture;
      this.accumulationMaterial.uniforms.uUvOffset.value.set(0, 0);
      this.accumulationMaterial.uniforms.uColor.value.set(1, 1, 1);
      setMaterialBlendConstant(this.accumulationMaterial, this.runtime.historyIntensity);
      this.renderFullscreen(renderer, this.composeTarget, this.accumulationMaterial, false);
    }
  }

  present(renderer) {
    switch (this.runtime.debugView) {
      case POSTFX_DEBUG_VIEW.SCENE:
        this.presentTarget(renderer, this.sceneTarget, true);
        return;
      case POSTFX_DEBUG_VIEW.FRONTBUFFER:
        this.presentTarget(renderer, this.frontBufferTarget, true);
        return;
      case POSTFX_DEBUG_VIEW.RADIOSITY_BLUR_A:
        this.presentTarget(renderer, this.radiosityTargetA, true);
        return;
      case POSTFX_DEBUG_VIEW.RADIOSITY_BLUR_B:
        this.presentTarget(renderer, this.radiosityTargetB, true);
        return;
      case POSTFX_DEBUG_VIEW.RADIOSITY_RESULT:
        this.presentTarget(renderer, this.frontBufferTarget, true);
        return;
      case POSTFX_DEBUG_VIEW.BLUR_SOURCE:
        this.presentTarget(renderer, this.blurCurrentTarget, true);
        return;
      case POSTFX_DEBUG_VIEW.HISTORY:
        this.presentTarget(renderer, this.blurHistoryTarget, true);
        return;
      case POSTFX_DEBUG_VIEW.BLUR_TINT:
        setVector3FromColor(this.solidColorMaterial.uniforms.uColor.value, this.runtime.blurColor);
        this.solidColorMaterial.uniforms.uOpacity.value = 1;
        this.renderFullscreen(renderer, null, this.solidColorMaterial, true);
        return;
      default:
        this.presentTarget(renderer, this.composeTarget, true);
    }
  }

  applyVcsPostFx(renderer, runtimeContext = {}) {
    if (!this.enabled || !renderer?.setRenderTarget || !this.sceneTarget) return;
    const width = runtimeContext.viewportWidth || this.viewportWidth;
    const height = runtimeContext.viewportHeight || this.viewportHeight;
    this.ensureSize(width, height);
    this.updateRuntime(runtimeContext);

    this.primeFrontBuffer(renderer);
    this.runColourFilterStage(renderer);
    this.captureDebugStage(renderer, this.composeTarget, this.debugColourFilterTarget);
    this.runRadiosityStage(renderer);
    this.captureDebugStage(renderer, this.composeTarget, this.debugRadiosityTarget);
    this.runBlurStage(renderer);
    this.captureDebugStage(renderer, this.composeTarget, this.debugBlurTarget);
    this.present(renderer);
  }

  endFrame(renderer) {
    if (!this.enabled || !renderer?.setRenderTarget || !this.composeTarget || !this.blurHistoryTarget) return;
    if (!this.runtime.enableBlur || !this.runtime.enableHistory) {
      this.resetHistory();
      return;
    }
    this.copyTarget(renderer, this.composeTarget, this.blurHistoryTarget, true);
    this.hasHistory = true;
  }

  render(renderer, runtimeContext = {}) {
    this.applyVcsPostFx(renderer, runtimeContext);
    this.endFrame(renderer);
  }

  getDebugPreviewTextures() {
    return [
      {
        id: 'pre-radiosity',
        label: 'Pre Radiosity',
        texture: this.debugColourFilterTarget?.texture || null,
        width: this.debugColourFilterTarget?.width || 0,
        height: this.debugColourFilterTarget?.height || 0,
      },
      {
        id: 'radiosity',
        label: 'After Radiosity',
        texture: this.debugRadiosityTarget?.texture || null,
        width: this.debugRadiosityTarget?.width || 0,
        height: this.debugRadiosityTarget?.height || 0,
      },
      {
        id: 'blur',
        label: 'After Blur',
        texture: this.debugBlurTarget?.texture || null,
        width: this.debugBlurTarget?.width || 0,
        height: this.debugBlurTarget?.height || 0,
      },
    ];
  }

  dispose() {
    this.sceneTarget?.dispose();
    this.composeTarget?.dispose();
    this.frontBufferTarget?.dispose();
    this.lastFrameTarget?.dispose();
    this.radiosityTargetA?.dispose();
    this.radiosityTargetB?.dispose();
    this.blurCurrentTarget?.dispose();
    this.blurHistoryTarget?.dispose();
    this.debugColourFilterTarget?.dispose();
    this.debugRadiosityTarget?.dispose();
    this.debugBlurTarget?.dispose();
    this.copyMaterial.dispose();
    this.presentMaterial.dispose();
    this.radiosityBlurMaterial.dispose();
    this.accumulationMaterial.dispose();
    this.additiveMaterial.dispose();
    this.colourFilterAddMaterial.dispose();
    this.radiosityCompositeMaterial.dispose();
    this.solidColorMaterial.dispose();
    this.quad.geometry.dispose();
  }
}

export default RWPostFxPipeline;
