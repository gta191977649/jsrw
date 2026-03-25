import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs,
  clamp,
  max,
  min,
  mix,
  smoothstep,
  step,
  uniform,
  uv,
  vec4,
} from 'three/tsl';

export function createSkyNodeMaterial({
  skyTop,
  skyBottom,
  fogColor,
  belowHorizonColor,
  horizonY = 0.5,
  smallStripHeight = 0.01,
  horizonStrength = 0.8,
  lowerBandEndY = 0.38,
  tanHalfFov = Math.tan(THREE.MathUtils.degToRad(60 * 0.5)),
  aspect = 1,
  belowHorizonMix = 0,
} = {}) {
  const skyMaterial = new MeshBasicNodeMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  skyMaterial.userData = {
    ...(skyMaterial.userData || {}),
    rwSkyUniforms: {
      uSkyTop: uniform(skyTop?.clone?.() || new THREE.Color(1, 1, 1)),
      uSkyBottom: uniform(skyBottom?.clone?.() || new THREE.Color(1, 1, 1)),
      uFogColor: uniform(fogColor?.clone?.() || new THREE.Color(1, 1, 1)),
      uBelowHorizonColor: uniform(belowHorizonColor?.clone?.() || new THREE.Color(0, 0, 0)),
      uCameraForward: uniform(new THREE.Vector3(0, 0, -1)),
      uCameraRight: uniform(new THREE.Vector3(1, 0, 0)),
      uCameraUp: uniform(new THREE.Vector3(0, 1, 0)),
      uHorizonY: uniform(horizonY),
      uSmallStripHeight: uniform(smallStripHeight),
      uHorizonStrength: uniform(horizonStrength),
      uLowerBandEndY: uniform(lowerBandEndY),
      uTanHalfFov: uniform(tanHalfFov),
      uAspect: uniform(aspect),
      uBelowHorizonMix: uniform(belowHorizonMix),
    },
  };

  const skyUniforms = skyMaterial.userData.rwSkyUniforms;
  const skyUv = uv();
  const horizonVisible = step(0.0, skyUniforms.uHorizonY).mul(step(skyUniforms.uHorizonY, 1.0));
  const horizonAnchor = clamp(skyUniforms.uHorizonY, 0.0, 1.0);
  const skyT = smoothstep(horizonAnchor, 1.0, skyUv.y);
  const baseColor = mix(skyUniforms.uSkyBottom, skyUniforms.uSkyTop, clamp(skyT, 0.0, 1.0));
  const smallBand = max(0.003, skyUniforms.uSmallStripHeight);
  const smallStripMask = vec4(1.0)
    .sub(smoothstep(0.0, smallBand, abs(skyUv.y.sub(horizonAnchor))))
    .x
    .mul(horizonVisible);
  const foggedColor = mix(baseColor, skyUniforms.uFogColor, smallStripMask.mul(skyUniforms.uHorizonStrength));
  const lowerStart = horizonAnchor.sub(smallBand);
  const lowerEnd = min(lowerStart, skyUniforms.uLowerBandEndY);
  const lowerMask = vec4(1.0)
    .sub(step(horizonAnchor, skyUv.y))
    .x
    .mul(smoothstep(lowerEnd, lowerStart, skyUv.y))
    .mul(horizonVisible);
  const belowColor = mix(
    skyUniforms.uBelowHorizonColor,
    skyUniforms.uSkyBottom,
    skyUniforms.uBelowHorizonMix,
  );
  const lowerBandColor = mix(
    belowColor,
    skyUniforms.uFogColor,
    smoothstep(lowerEnd, lowerStart, skyUv.y),
  );

  skyMaterial.colorNode = mix(foggedColor, lowerBandColor, lowerMask);
  return skyMaterial;
}

export default createSkyNodeMaterial;
