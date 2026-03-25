import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  clamp,
  materialReference,
  max,
  mix,
  texture,
  uniform,
  vec3,
  vec4,
  vertexColor,
} from 'three/tsl';

export function createRwBuildingNodeMaterial({
  descriptor,
  sharedUniforms,
  surfaceEmissiveScale = 0,
  platformVariant = 0,
  fallbackTexture,
} = {}) {
  const diffuseTexture = descriptor?.map || fallbackTexture || null;
  const material = new MeshBasicNodeMaterial({
    name: descriptor?.name || '',
    map: diffuseTexture,
    alphaMap: null,
    color: new THREE.Color(1, 1, 1),
    transparent: descriptor?.transparent,
    opacity: descriptor?.opacity ?? 1,
    alphaTest: descriptor?.alphaRef ?? 0,
    side: descriptor?.side,
    depthTest: descriptor?.depthTest !== false,
    depthWrite: descriptor?.depthWrite !== false,
    blending: descriptor?.blending ?? THREE.NormalBlending,
    vertexColors: true,
    fog: true,
    toneMapped: false,
    wireframe: Boolean(descriptor?.wireframe),
  });

  material.userData = {
    ...(material.userData || {}),
    rwPipelineUniforms: {
      uColorScale: uniform(descriptor?.map ? (255 / 128) : 1),
      uAmb: sharedUniforms.uAmb,
      uEmiss: sharedUniforms.uEmiss,
      uSurfaceEmissiveScale: uniform(surfaceEmissiveScale),
      uUseVertexColor: uniform(!descriptor?.rwFlags?.forceIgnoreVertexColor && descriptor?.useVertexColors !== false ? 1 : 0),
      uPlatformVariant: uniform(platformVariant),
      uMap: texture(diffuseTexture),
    },
  };

  const rwUniforms = material.userData.rwPipelineUniforms;
  const vertexInput = mix(vec4(1, 1, 1, 1), vertexColor(), rwUniforms.uUseVertexColor);
  const ps2Color = clamp(
    vec4(
      vertexInput.rgb.mul(rwUniforms.uAmb).add(rwUniforms.uEmiss.mul(rwUniforms.uSurfaceEmissiveScale)),
      vertexInput.a,
    ),
    0,
    1,
  );
  const pspVertexRgb = max(vertexInput.rgb.sub(0.5).mul(1.5).add(0.5).add(0.25), vec3(0, 0, 0));
  const pspAmbientRgb = max(rwUniforms.uAmb.sub(0.5).mul(1.2).add(0.5).add(0.1), vec3(0, 0, 0));
  const pspEmissiveRgb = max(rwUniforms.uEmiss.sub(0.5).mul(1.25).add(0.5).add(0.05), vec3(0, 0, 0));
  const pspColor = clamp(
    vec4(pspEmissiveRgb.add(pspVertexRgb.mul(pspAmbientRgb)), vertexInput.a),
    0,
    1,
  );
  const pipelineColor = mix(ps2Color, pspColor, rwUniforms.uPlatformVariant);
  const sampledDiffuseColor = rwUniforms.uMap.mul(vec4(
    rwUniforms.uColorScale,
    rwUniforms.uColorScale,
    rwUniforms.uColorScale,
    1,
  ));

  material.colorNode = sampledDiffuseColor.rgb.mul(pipelineColor.rgb);
  material.opacityNode = sampledDiffuseColor.a.mul(pipelineColor.a).mul(materialReference('opacity', 'float', material));
  return material;
}

export default createRwBuildingNodeMaterial;
