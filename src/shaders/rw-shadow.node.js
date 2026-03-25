import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { max, texture, uniform } from 'three/tsl';

export function createRwShadowNodeMaterial(shadowTexture) {
  const material = new MeshBasicNodeMaterial({
    map: shadowTexture,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });

  material.userData = {
    ...(material.userData || {}),
    rwShadowUniforms: {
      uColor: uniform(new THREE.Color(1, 1, 1)),
      uOpacity: uniform(1),
      uMap: texture(shadowTexture || null),
    },
  };

  const rwUniforms = material.userData.rwShadowUniforms;
  const shadowMask = max(
    rwUniforms.uMap.a,
    max(rwUniforms.uMap.r, max(rwUniforms.uMap.g, rwUniforms.uMap.b)),
  );
  material.colorNode = rwUniforms.uColor;
  material.opacityNode = shadowMask.mul(rwUniforms.uOpacity);
  return material;
}

export default createRwShadowNodeMaterial;
