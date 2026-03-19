import * as THREE from 'three';
import rwPostFxFullscreenVertexShader from '../../../../shaders/postfx/fullscreen.vertex.glsl.js';
import rwPostFxCopyFragmentShader from '../../../../shaders/postfx/copy.fragment.glsl.js';
import rwPostFxPresentFragmentShader from '../../../../shaders/postfx/present.fragment.glsl.js';

const SKYGFX_RADIOSITY_INTENSITY = 0x23;
const VCS_BLUR_OFFSET = 2.1;
const VCS_BLUR_INTENSITY = (39.0 * 0.8) / 255.0;
const VCS_HISTORY_INTENSITY = 32 / 255.0;
const VCS_TRAILS_LIMIT = 80;
const VCS_RADIOSITY_PING_PONG_PASSES = 4;
const VCS_RADIOSITY_SPREAD_WEIGHT = 36 / 255;
const DEFAULT_RADIOSITY_RESOLUTION_DIVISOR = 4;
const FULL_RES_POSTFX_TARGET_TYPE = THREE.HalfFloatType;
const POSTFX_DEBUG_VIEW = Object.freeze({
  FINAL: 'final',
  SCENE: 'scene',
  CURRENT_FRAME: 'current-frame',
  RADIOSITY_BLUR_A: 'radiosity-blur-a',
  RADIOSITY_BLUR_B: 'radiosity-blur-b',
  AFTER_RADIOSITY: 'after-radiosity',
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
    type: options.type || THREE.UnsignedByteType,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.generateMipmaps = false;
  target.texture.userData = {
    ...(target.texture.userData || {}),
    rwRenderTarget: target,
  };
  return target;
}

function computeRadiositySize(width, height, divisor = DEFAULT_RADIOSITY_RESOLUTION_DIVISOR) {
  const safeDivisor = THREE.MathUtils.clamp(Math.round(getFiniteOrDefault(divisor, DEFAULT_RADIOSITY_RESOLUTION_DIVISOR)), 1, 8);
  return {
    width: Math.max(1, Math.round(Math.max(1, width) / safeDivisor)),
    height: Math.max(1, Math.round(Math.max(1, height) / safeDivisor)),
  };
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

export class RWPostFxPipeline {
  constructor(options = {}) {
    this.enabled = true;
    this.viewportWidth = 1;
    this.viewportHeight = 1;
    this.radiosityWidth = 1;
    this.radiosityHeight = 1;
    this.hasHistory = false;

    this.sceneTarget = null;
    this.composeTarget = null;
    this.frontBufferTarget = null;
    this.lastFrameTarget = null;
    this.radiosityTargetA = null;
    this.radiosityTargetB = null;
    this.blurCurrentTarget = null;
    this.blurHistoryTarget = null;
    this.debugCurrentFrameTarget = null;
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
        uTexelSize: { value: new THREE.Vector2(1, 1) },
        uOffsetSet: { value: 0 },
        uWeight: { value: VCS_RADIOSITY_SPREAD_WEIGHT },
      },
      vertexShader: rwPostFxFullscreenVertexShader,
      fragmentShader: `
uniform sampler2D uTex;
uniform vec2 uTexelSize;
uniform int uOffsetSet;
uniform float uWeight;
varying vec2 vUv;

void main() {
  vec2 offsets[8];
  if (uOffsetSet == 0) {
    offsets[0] = vec2(-1.0, 0.0);
    offsets[1] = vec2(1.0, 0.0);
    offsets[2] = vec2(0.0, -1.0);
    offsets[3] = vec2(0.0, 1.0);
    offsets[4] = vec2(-1.0, -1.0);
    offsets[5] = vec2(1.0, -1.0);
    offsets[6] = vec2(-1.0, 1.0);
    offsets[7] = vec2(1.0, 1.0);
  } else {
    offsets[0] = vec2(1.0, 0.0);
    offsets[1] = vec2(-1.0, 0.0);
    offsets[2] = vec2(0.0, 1.0);
    offsets[3] = vec2(0.0, -1.0);
    offsets[4] = vec2(1.0, 1.0);
    offsets[5] = vec2(-1.0, 1.0);
    offsets[6] = vec2(1.0, -1.0);
    offsets[7] = vec2(-1.0, -1.0);
  }

  vec3 color = vec3(0.0);
  for (int i = 0; i < 8; i += 1) {
    color += texture2D(uTex, clamp(vUv + (offsets[i] * uTexelSize), 0.0, 1.0)).rgb * uWeight;
  }
  gl_FragColor = vec4(color, 1.0);
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
        uIntensity: { value: 0.0 },
      },
      vertexShader: rwPostFxFullscreenVertexShader,
      fragmentShader: `
uniform sampler2D uTex;
uniform float uIntensity;
varying vec2 vUv;

void main() {
  vec3 color = texture2D(uTex, clamp(vUv, 0.0, 1.0)).rgb * uIntensity;
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

    this.radiosityThresholdMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: null },
        uLimit: { value: 0.0 },
      },
      vertexShader: rwPostFxFullscreenVertexShader,
      fragmentShader: `
uniform sampler2D uTex;
uniform float uLimit;
varying vec2 vUv;

void main() {
  vec3 color = texture2D(uTex, clamp(vUv, 0.0, 1.0)).rgb;
  color = max((color * 2.0) - vec3(uLimit), vec3(0.0));
  gl_FragColor = vec4(color, 1.0);
}
`,
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
      blurColor: new THREE.Color(0, 0, 0),
      radiosityLimit: VCS_TRAILS_LIMIT,
      radiosityIntensity: SKYGFX_RADIOSITY_INTENSITY,
      radiosityResolutionDivisor: DEFAULT_RADIOSITY_RESOLUTION_DIVISOR,
      blurOffset: VCS_BLUR_OFFSET,
      blurIntensity: VCS_BLUR_INTENSITY,
      historyIntensity: VCS_HISTORY_INTENSITY,
      enableTrails: true,
      enableColorFilter: false,
      enableRadiosity: true,
      enableBlur: true,
      debugView: POSTFX_DEBUG_VIEW.FINAL,
    };
    this.runtime = {
      blurColor: new THREE.Color(0, 0, 0),
      radiosityLimit: VCS_TRAILS_LIMIT,
      radiosityIntensity: SKYGFX_RADIOSITY_INTENSITY,
      radiosityResolutionDivisor: DEFAULT_RADIOSITY_RESOLUTION_DIVISOR,
      blurOffset: VCS_BLUR_OFFSET,
      blurIntensity: VCS_BLUR_INTENSITY,
      historyIntensity: VCS_HISTORY_INTENSITY,
      enableTrails: true,
      enableColorFilter: false,
      enableRadiosity: true,
      enableBlur: true,
      debugView: POSTFX_DEBUG_VIEW.FINAL,
      debugCapture: false,
    };
    this.setConfig(options);
  }

  shouldCaptureDebug() {
    return this.runtime.debugCapture || this.runtime.debugView !== POSTFX_DEBUG_VIEW.FINAL;
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
    const nextRadiosityResolutionDivisor = THREE.MathUtils.clamp(
      Math.round(getFiniteOrDefault(config.radiosityResolutionDivisor, DEFAULT_RADIOSITY_RESOLUTION_DIVISOR)),
      1,
      8,
    );
    const nextBlurOffset = Math.max(0, getFiniteOrDefault(config.blurOffset, VCS_BLUR_OFFSET));
    const nextBlurIntensity = THREE.MathUtils.clamp(getFiniteOrDefault(config.blurIntensity, VCS_BLUR_INTENSITY), 0, 1);
    const nextHistoryIntensity = THREE.MathUtils.clamp(getFiniteOrDefault(config.historyIntensity, VCS_HISTORY_INTENSITY), 0, 1);
    const nextEnableTrails = getBooleanOrDefault(config.enableTrails, getBooleanOrDefault(config.enableHistory, true));
    const nextEnableColorFilter = getBooleanOrDefault(config.enableColorFilter, false);
    const nextEnableRadiosity = getBooleanOrDefault(config.enableRadiosity, true);
    const nextEnableBlur = getBooleanOrDefault(config.enableBlur, true);
    const nextDebugView = getPostFxDebugViewOrDefault(config.debugView);
    const configChanged = (
      this.configRuntime.radiosityLimit !== nextRadiosityLimit
      || this.configRuntime.radiosityIntensity !== nextRadiosityIntensity
      || this.configRuntime.radiosityResolutionDivisor !== nextRadiosityResolutionDivisor
      || this.configRuntime.blurOffset !== nextBlurOffset
      || this.configRuntime.blurIntensity !== nextBlurIntensity
      || this.configRuntime.historyIntensity !== nextHistoryIntensity
      || this.configRuntime.enableTrails !== nextEnableTrails
      || this.configRuntime.enableColorFilter !== nextEnableColorFilter
      || this.configRuntime.enableRadiosity !== nextEnableRadiosity
      || this.configRuntime.enableBlur !== nextEnableBlur
      || this.configRuntime.debugView !== nextDebugView
    );

    this.configRuntime.radiosityLimit = nextRadiosityLimit;
    this.configRuntime.radiosityIntensity = nextRadiosityIntensity;
    this.configRuntime.radiosityResolutionDivisor = nextRadiosityResolutionDivisor;
    this.configRuntime.blurOffset = nextBlurOffset;
    this.configRuntime.blurIntensity = nextBlurIntensity;
    this.configRuntime.historyIntensity = nextHistoryIntensity;
    this.configRuntime.enableTrails = nextEnableTrails;
    this.configRuntime.enableColorFilter = nextEnableColorFilter;
    this.configRuntime.enableRadiosity = nextEnableRadiosity;
    this.configRuntime.enableBlur = nextEnableBlur;
    this.configRuntime.debugView = nextDebugView;

    this.runtime.blurColor.copy(this.configRuntime.blurColor);
    this.runtime.radiosityLimit = this.configRuntime.radiosityLimit;
    this.runtime.radiosityIntensity = this.configRuntime.radiosityIntensity;
    this.runtime.radiosityResolutionDivisor = this.configRuntime.radiosityResolutionDivisor;
    this.runtime.blurOffset = this.configRuntime.blurOffset;
    this.runtime.blurIntensity = this.configRuntime.blurIntensity;
    this.runtime.historyIntensity = this.configRuntime.historyIntensity;
    this.runtime.enableTrails = this.configRuntime.enableTrails;
    this.runtime.enableColorFilter = this.configRuntime.enableColorFilter;
    this.runtime.enableRadiosity = this.configRuntime.enableRadiosity;
    this.runtime.enableBlur = this.configRuntime.enableBlur;
    this.runtime.debugView = this.configRuntime.debugView;

    if (configChanged) this.resetHistory();
  }

  ensureSize(width, height) {
    const nextWidth = Math.max(1, Math.floor(width || 1));
    const nextHeight = Math.max(1, Math.floor(height || 1));
    const nextRadiositySize = computeRadiositySize(
      nextWidth,
      nextHeight,
      this.runtime.radiosityResolutionDivisor,
    );
    if (
      this.viewportWidth === nextWidth
      && this.viewportHeight === nextHeight
      && this.radiosityWidth === nextRadiositySize.width
      && this.radiosityHeight === nextRadiositySize.height
      && this.sceneTarget
      && this.composeTarget
      && this.frontBufferTarget
      && this.lastFrameTarget
      && this.radiosityTargetA
      && this.radiosityTargetB
      && this.blurCurrentTarget
      && this.blurHistoryTarget
      && this.debugCurrentFrameTarget
      && this.debugRadiosityTarget
      && this.debugBlurTarget
    ) {
      return;
    }
    this.viewportWidth = nextWidth;
    this.viewportHeight = nextHeight;
    this.radiosityWidth = nextRadiositySize.width;
    this.radiosityHeight = nextRadiositySize.height;

    this.sceneTarget?.dispose();
    this.composeTarget?.dispose();
    this.frontBufferTarget?.dispose();
    this.lastFrameTarget?.dispose();
    this.radiosityTargetA?.dispose();
    this.radiosityTargetB?.dispose();
    this.blurCurrentTarget?.dispose();
    this.blurHistoryTarget?.dispose();
    this.debugCurrentFrameTarget?.dispose();
    this.debugRadiosityTarget?.dispose();
    this.debugBlurTarget?.dispose();

    this.sceneTarget = createRenderTarget(nextWidth, nextHeight, { depthBuffer: true, type: FULL_RES_POSTFX_TARGET_TYPE });
    this.composeTarget = createRenderTarget(nextWidth, nextHeight, { type: FULL_RES_POSTFX_TARGET_TYPE });
    this.frontBufferTarget = createRenderTarget(nextWidth, nextHeight, { type: FULL_RES_POSTFX_TARGET_TYPE });
    this.lastFrameTarget = createRenderTarget(nextWidth, nextHeight, { type: FULL_RES_POSTFX_TARGET_TYPE });
    this.radiosityTargetA = createRenderTarget(this.radiosityWidth, this.radiosityHeight, { type: THREE.HalfFloatType });
    this.radiosityTargetB = createRenderTarget(this.radiosityWidth, this.radiosityHeight, { type: THREE.HalfFloatType });
    this.blurCurrentTarget = createRenderTarget(nextWidth, nextHeight, { type: FULL_RES_POSTFX_TARGET_TYPE });
    this.blurHistoryTarget = createRenderTarget(nextWidth, nextHeight, { type: FULL_RES_POSTFX_TARGET_TYPE });
    this.debugCurrentFrameTarget = createRenderTarget(nextWidth, nextHeight, { type: FULL_RES_POSTFX_TARGET_TYPE });
    this.debugRadiosityTarget = createRenderTarget(nextWidth, nextHeight, { type: FULL_RES_POSTFX_TARGET_TYPE });
    this.debugBlurTarget = createRenderTarget(nextWidth, nextHeight, { type: FULL_RES_POSTFX_TARGET_TYPE });
    this.resetHistory();
  }

  updateRuntime(runtimeContext = {}) {
    this.runtime.radiosityLimit = this.configRuntime.radiosityLimit;
    this.runtime.radiosityIntensity = this.configRuntime.radiosityIntensity;
    this.runtime.radiosityResolutionDivisor = this.configRuntime.radiosityResolutionDivisor;
    this.runtime.blurOffset = this.configRuntime.blurOffset;
    this.runtime.blurIntensity = this.configRuntime.blurIntensity;
    this.runtime.historyIntensity = this.configRuntime.historyIntensity;
    this.runtime.enableTrails = this.configRuntime.enableTrails;
    this.runtime.enableColorFilter = this.configRuntime.enableColorFilter;
    this.runtime.enableRadiosity = this.configRuntime.enableRadiosity;
    this.runtime.enableBlur = this.configRuntime.enableBlur;
    this.runtime.debugView = this.configRuntime.debugView;
    this.runtime.debugCapture = Boolean(runtimeContext?.postFxDebugCapture);

    const values = runtimeContext?.timecycleCurrent?.values;
    if (!values || !values.blur) {
      this.runtime.blurColor.copy(this.configRuntime.blurColor);
      return;
    }

    const blurSource = values.postfx2 || values.blur;
    const blurR = getClampedScalar(blurSource.r, 0, 255, 0) / 255;
    const blurG = getClampedScalar(blurSource.g, 0, 255, 0) / 255;
    const blurB = getClampedScalar(blurSource.b, 0, 255, 0) / 255;
    this.runtime.blurColor.setRGB(blurR, blurG, blurB);
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

  captureDebugStage(renderer, source, destination) {
    if (!this.shouldCaptureDebug() || !source || !destination) return;
    this.copyTarget(renderer, source, destination, true);
  }

  runRadiosityStage(renderer) {
    this.copyTarget(renderer, this.frontBufferTarget, this.composeTarget, true);
    if (!this.runtime.enableRadiosity || this.runtime.radiosityIntensity <= 0) return;

    this.radiosityThresholdMaterial.uniforms.uTex.value = this.frontBufferTarget.texture;
    this.radiosityThresholdMaterial.uniforms.uLimit.value = this.runtime.radiosityLimit / 255.0;
    this.renderFullscreen(renderer, this.radiosityTargetB, this.radiosityThresholdMaterial, true);

    let source = this.radiosityTargetB;
    let destination = this.radiosityTargetA;
    this.radiosityBlurMaterial.uniforms.uTexelSize.value.set(
      1 / Math.max(1, this.radiosityTargetA.width),
      1 / Math.max(1, this.radiosityTargetA.height),
    );
    this.radiosityBlurMaterial.uniforms.uWeight.value = VCS_RADIOSITY_SPREAD_WEIGHT;
    for (let i = 0; i < VCS_RADIOSITY_PING_PONG_PASSES; i += 1) {
      this.radiosityBlurMaterial.uniforms.uTex.value = source.texture;
      this.radiosityBlurMaterial.uniforms.uOffsetSet.value = i % 2;
      this.renderFullscreen(renderer, destination, this.radiosityBlurMaterial, true);
      const nextSource = destination;
      destination = source;
      source = nextSource;
    }

    this.captureDebugStage(renderer, source, this.radiosityTargetB === source ? this.debugRadiosityTarget : this.debugRadiosityTarget);

    this.radiosityCompositeMaterial.uniforms.uTex.value = source.texture;
    this.radiosityCompositeMaterial.uniforms.uIntensity.value = THREE.MathUtils.clamp(
      (this.runtime.radiosityIntensity * 4) / 255.0,
      0,
      1,
    );
    this.renderFullscreen(renderer, this.composeTarget, this.radiosityCompositeMaterial, false);
    this.renderFullscreen(renderer, this.composeTarget, this.radiosityCompositeMaterial, false);
  }

  runBlurStage(renderer) {
    if (!this.runtime.enableBlur) return;

    this.accumulationMaterial.uniforms.uTex.value = this.frontBufferTarget.texture;
    this.accumulationMaterial.uniforms.uColor.value.set(1, 1, 1);
    this.accumulationMaterial.uniforms.uOpacity.value = 1;
    setMaterialBlendConstant(this.accumulationMaterial, this.runtime.blurIntensity);

    const blurOffset = this.runtime.blurOffset;
    const offsets = [
      new THREE.Vector2(blurOffset / this.frontBufferTarget.width, 0),
      new THREE.Vector2(blurOffset / this.frontBufferTarget.width, blurOffset / this.frontBufferTarget.height),
      new THREE.Vector2(0, blurOffset / this.frontBufferTarget.height),
    ];
    setMaterialBlendConstant(this.accumulationMaterial, this.runtime.blurIntensity);
    for (const offset of offsets) {
      this.accumulationMaterial.uniforms.uUvOffset.value.copy(offset);
      this.renderFullscreen(renderer, this.composeTarget, this.accumulationMaterial, false);
    }

    if (this.runtime.enableColorFilter) {
      setVector3FromColor(this.solidColorMaterial.uniforms.uColor.value, this.runtime.blurColor);
      this.solidColorMaterial.uniforms.uOpacity.value = 1;
      this.renderFullscreen(renderer, this.composeTarget, this.solidColorMaterial, false);
    }

    if (this.runtime.enableTrails && this.hasHistory) {
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
      case POSTFX_DEBUG_VIEW.CURRENT_FRAME:
        this.presentTarget(renderer, this.frontBufferTarget, true);
        return;
      case POSTFX_DEBUG_VIEW.RADIOSITY_BLUR_A:
        this.presentTarget(renderer, this.radiosityTargetA, true);
        return;
      case POSTFX_DEBUG_VIEW.RADIOSITY_BLUR_B:
        this.presentTarget(renderer, this.radiosityTargetB, true);
        return;
      case POSTFX_DEBUG_VIEW.AFTER_RADIOSITY:
        this.presentTarget(renderer, this.debugRadiosityTarget, true);
        return;
      case POSTFX_DEBUG_VIEW.BLUR_SOURCE:
        this.presentTarget(renderer, this.frontBufferTarget, true);
        return;
      case POSTFX_DEBUG_VIEW.HISTORY:
        this.presentTarget(renderer, this.blurHistoryTarget, true);
        return;
      case POSTFX_DEBUG_VIEW.BLUR_TINT:
        if (this.runtime.enableColorFilter) {
          setVector3FromColor(this.solidColorMaterial.uniforms.uColor.value, this.runtime.blurColor);
          this.solidColorMaterial.uniforms.uOpacity.value = 1;
        } else {
          this.solidColorMaterial.uniforms.uColor.value.set(0, 0, 0);
          this.solidColorMaterial.uniforms.uOpacity.value = 1;
        }
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
    this.captureDebugStage(renderer, this.frontBufferTarget, this.debugCurrentFrameTarget);
    this.runRadiosityStage(renderer);
    this.captureDebugStage(renderer, this.composeTarget, this.debugRadiosityTarget);
    this.runBlurStage(renderer);
    this.captureDebugStage(renderer, this.composeTarget, this.debugBlurTarget);
    this.present(renderer);
  }

  endFrame(renderer) {
    if (!this.enabled || !renderer?.setRenderTarget || !this.composeTarget || !this.blurHistoryTarget) return;
    if (!this.runtime.enableBlur || !this.runtime.enableTrails) {
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
        label: 'Current Frame',
        texture: this.debugCurrentFrameTarget?.texture || null,
        width: this.debugCurrentFrameTarget?.width || 0,
        height: this.debugCurrentFrameTarget?.height || 0,
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
        label: 'After BlurOverlay',
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
    this.debugCurrentFrameTarget?.dispose();
    this.debugRadiosityTarget?.dispose();
    this.debugBlurTarget?.dispose();
    this.copyMaterial.dispose();
    this.presentMaterial.dispose();
    this.radiosityBlurMaterial.dispose();
    this.accumulationMaterial.dispose();
    this.additiveMaterial.dispose();
    this.radiosityCompositeMaterial.dispose();
    this.radiosityThresholdMaterial.dispose();
    this.solidColorMaterial.dispose();
    this.quad.geometry.dispose();
  }
}

export default RWPostFxPipeline;
