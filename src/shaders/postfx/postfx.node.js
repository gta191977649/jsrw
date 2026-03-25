import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  clamp,
  max,
  mix,
  oneMinus,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';

function getPostFxSampleUv(uniforms, offsetNode = vec2(0, 0)) {
  const baseUv = clamp(uv().add(offsetNode), vec2(0, 0), vec2(1, 1));
  return vec2(
    baseUv.x,
    mix(baseUv.y, oneMinus(baseUv.y), uniforms.uFlipY),
  );
}

function createBasePostFxMaterial() {
  return new MeshBasicNodeMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    fog: false,
    toneMapped: false,
  });
}

export function createPostFxCopyNodeMaterial() {
  const material = createBasePostFxMaterial();
  material.userData = {
    ...(material.userData || {}),
    rwPostFxUniforms: {
      uTex: texture(null),
      uUvOffset: uniform(new THREE.Vector2(0, 0)),
      uColor: uniform(new THREE.Vector3(1, 1, 1)),
      uOpacity: uniform(1),
      uFlipY: uniform(0),
    },
  };
  const uniforms = material.userData.rwPostFxUniforms;
  const sampleUv = getPostFxSampleUv(uniforms, uniforms.uUvOffset);
  const sampled = uniforms.uTex.sample(sampleUv);
  material.colorNode = sampled.rgb.mul(uniforms.uColor);
  material.opacityNode = uniforms.uOpacity;
  return material;
}

export function createPostFxRadiosityThresholdNodeMaterial() {
  const material = createBasePostFxMaterial();
  material.userData = {
    ...(material.userData || {}),
    rwPostFxUniforms: {
      uTex: texture(null),
      uLimit: uniform(0),
      uFlipY: uniform(0),
    },
  };
  const uniforms = material.userData.rwPostFxUniforms;
  const sampled = uniforms.uTex.sample(getPostFxSampleUv(uniforms)).rgb;
  material.colorNode = max(sampled.mul(2.0).sub(vec3(uniforms.uLimit, uniforms.uLimit, uniforms.uLimit)), vec3(0, 0, 0));
  material.opacityNode = 1;
  return material;
}

export function createPostFxRadiosityCompositeNodeMaterial() {
  const material = createBasePostFxMaterial();
  material.transparent = true;
  material.userData = {
    ...(material.userData || {}),
    rwPostFxUniforms: {
      uTex: texture(null),
      uIntensity: uniform(0),
      uFlipY: uniform(0),
    },
  };
  const uniforms = material.userData.rwPostFxUniforms;
  material.colorNode = uniforms.uTex.sample(getPostFxSampleUv(uniforms)).rgb.mul(uniforms.uIntensity);
  material.opacityNode = 1;
  return material;
}

export function createPostFxSolidColorNodeMaterial() {
  const material = createBasePostFxMaterial();
  material.transparent = true;
  material.userData = {
    ...(material.userData || {}),
    rwPostFxUniforms: {
      uColor: uniform(new THREE.Vector3(0, 0, 0)),
      uOpacity: uniform(1),
    },
  };
  const uniforms = material.userData.rwPostFxUniforms;
  material.colorNode = uniforms.uColor;
  material.opacityNode = uniforms.uOpacity;
  return material;
}

export function createPostFxRadiosityBlurNodeMaterial() {
  const material = createBasePostFxMaterial();
  material.userData = {
    ...(material.userData || {}),
    rwPostFxUniforms: {
      uTex: texture(null),
      uTexelSize: uniform(new THREE.Vector2(1, 1)),
      uOffsetSet: uniform(0),
      uWeight: uniform(1),
      uFlipY: uniform(0),
    },
  };
  const uniforms = material.userData.rwPostFxUniforms;
  const baseUv = uv();
  const selector = uniforms.uOffsetSet;
  const texel = uniforms.uTexelSize;
  const sampleAt = (offsetA, offsetB) => {
    const offset = mix(offsetA, offsetB, selector);
    const rawUv = clamp(baseUv.add(offset.mul(texel)), vec2(0, 0), vec2(1, 1));
    const sampleUv = vec2(rawUv.x, mix(rawUv.y, oneMinus(rawUv.y), uniforms.uFlipY));
    return uniforms.uTex.sample(sampleUv).rgb;
  };
  const color = sampleAt(vec2(-1, 0), vec2(1, 0))
    .add(sampleAt(vec2(1, 0), vec2(-1, 0)))
    .add(sampleAt(vec2(0, -1), vec2(0, 1)))
    .add(sampleAt(vec2(0, 1), vec2(0, -1)))
    .add(sampleAt(vec2(-1, -1), vec2(1, 1)))
    .add(sampleAt(vec2(1, -1), vec2(-1, 1)))
    .add(sampleAt(vec2(-1, 1), vec2(1, -1)))
    .add(sampleAt(vec2(1, 1), vec2(-1, -1)))
    .mul(uniforms.uWeight);
  material.colorNode = color;
  material.opacityNode = 1;
  return material;
}

export function configurePostFxCopyUniforms(material, {
  textureValue = null,
  uvOffset = null,
  color = null,
  opacity = 1,
  flipY = 0,
} = {}) {
  const uniforms = material?.userData?.rwPostFxUniforms;
  if (!uniforms) return;
  uniforms.uTex.value = textureValue;
  if (uvOffset) uniforms.uUvOffset.value.copy(uvOffset);
  else uniforms.uUvOffset.value.set(0, 0);
  if (color) uniforms.uColor.value.copy(color);
  else uniforms.uColor.value.set(1, 1, 1);
  uniforms.uOpacity.value = opacity;
  if (uniforms.uFlipY) uniforms.uFlipY.value = flipY;
}

export function configurePostFxThresholdUniforms(material, { textureValue = null, limit = 0, flipY = 0 } = {}) {
  const uniforms = material?.userData?.rwPostFxUniforms;
  if (!uniforms) return;
  uniforms.uTex.value = textureValue;
  uniforms.uLimit.value = limit;
  if (uniforms.uFlipY) uniforms.uFlipY.value = flipY;
}

export function configurePostFxCompositeUniforms(material, { textureValue = null, intensity = 0, flipY = 0 } = {}) {
  const uniforms = material?.userData?.rwPostFxUniforms;
  if (!uniforms) return;
  uniforms.uTex.value = textureValue;
  uniforms.uIntensity.value = intensity;
  if (uniforms.uFlipY) uniforms.uFlipY.value = flipY;
}

export function configurePostFxRadiosityBlurUniforms(material, {
  textureValue = null,
  texelSize = null,
  offsetSet = 0,
  weight = 1,
  flipY = 0,
} = {}) {
  const uniforms = material?.userData?.rwPostFxUniforms;
  if (!uniforms) return;
  uniforms.uTex.value = textureValue;
  if (texelSize) uniforms.uTexelSize.value.copy(texelSize);
  uniforms.uOffsetSet.value = offsetSet;
  uniforms.uWeight.value = weight;
  if (uniforms.uFlipY) uniforms.uFlipY.value = flipY;
}

export function configurePostFxSolidColorUniforms(material, {
  color = null,
  opacity = 1,
} = {}) {
  const uniforms = material?.userData?.rwPostFxUniforms;
  if (!uniforms) return;
  if (color) uniforms.uColor.value.copy(color);
  uniforms.uOpacity.value = opacity;
}
