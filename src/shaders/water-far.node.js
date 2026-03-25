import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  materialReference,
  mod,
  positionLocal,
  sin,
  texture,
  uniform,
  uv,
  vec3,
} from 'three/tsl';

export function createRwFarWaterNodeMaterial(sourceTexture, {
  color = new THREE.Color(0xffffff),
  alpha = 0.8,
  waveHeight = 1,
  wind = 0,
} = {}) {
  const material = new MeshBasicNodeMaterial({
    map: sourceTexture,
    color: color.clone(),
    transparent: true,
    opacity: alpha,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    toneMapped: false,
  });

  material.userData = {
    ...(material.userData || {}),
    rwWaterUniforms: {
      uTime: uniform(0),
      uWaveHeight: uniform(waveHeight),
      uWind: uniform(wind),
      uColor: uniform(color.clone()),
      uMap: texture(sourceTexture),
    },
  };

  const rwUniforms = material.userData.rwWaterUniforms;
  const waterUv = uv();
  const gridX = waterUv.x.mul(8.0);
  const gridY = waterUv.y.mul(8.0);
  const angle = mod(rwUniforms.uTime.mul(6.28318530718 / 4.096), 6.28318530718);
  const waveA = sin(gridX.add(gridY).mul(0.78539816339).add(angle));
  const waveB = sin(gridY.sub(gridX).mul(3.14159265359).add(angle.mul(2.0)));
  const windFactorA = rwUniforms.uWind.mul(0.7).add(0.3);
  const windFactorB = rwUniforms.uWind.mul(0.2);
  const displacement = windFactorA.mul(waveA).add(windFactorB.mul(waveB)).mul(rwUniforms.uWaveHeight);

  material.positionNode = positionLocal.add(vec3(0, displacement, 0));
  material.colorNode = rwUniforms.uMap.rgb.mul(rwUniforms.uColor);
  material.opacityNode = rwUniforms.uMap.a.mul(materialReference('opacity', 'float', material));
  return material;
}

export default createRwFarWaterNodeMaterial;
