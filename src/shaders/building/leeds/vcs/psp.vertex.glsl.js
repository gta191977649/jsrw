const leedsVcsPspBuildingVertexShader = `
uniform vec3 uAmb;
uniform vec3 uEmiss;
uniform float uSurfaceEmissiveScale;
uniform bool uUseVertexColor;
uniform bool uFogEnabled;
uniform float uFogFar;
uniform float uFogRange;

varying vec4 rwPipelineColor;
varying vec2 rwPipelineUv;
varying float rwPipelineFogFactor;

vec4 getLocalPosition() {
  vec4 localPosition = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    localPosition = instanceMatrix * localPosition;
  #endif
  return localPosition;
}

vec4 getVertexColor() {
  if (!uUseVertexColor) {
    return vec4(1.0);
  }
  #if defined( USE_COLOR_ALPHA )
    return color;
  #elif defined( USE_COLOR )
    return vec4(color.rgb, 1.0);
  #else
    return vec4(1.0);
  #endif
}

void main() {
  vec4 localPosition = getLocalPosition();
  vec4 worldPosition = modelMatrix * localPosition;
  vec4 mvPosition = viewMatrix * worldPosition;
  vec4 clipPosition = projectionMatrix * mvPosition;

  gl_Position = clipPosition;
  rwPipelineUv = uv;

  vec3 vertexRgb = getVertexColor().rgb;
  vec3 ambientRgb = uAmb;
  vec3 emissiveRgb = uEmiss;

  vertexRgb = ((vertexRgb - 0.5) * max(1.5, 0.0)) + 0.5;
  vertexRgb += 0.25;
  vertexRgb = max(vertexRgb, vec3(0.0));

  ambientRgb = ((ambientRgb - 0.5) * max(1.2, 0.0)) + 0.5;
  ambientRgb += 0.1;
  ambientRgb = max(ambientRgb, vec3(0.0));

  emissiveRgb = ((emissiveRgb - 0.5) * max(1.25, 0.0)) + 0.5;
  emissiveRgb += 0.05;
  emissiveRgb = max(emissiveRgb, vec3(0.0));

  vec4 vertexColor = getVertexColor();
  rwPipelineColor.rgb = emissiveRgb + (vertexRgb * ambientRgb);
  rwPipelineColor.a = vertexColor.a;
  rwPipelineColor = clamp(rwPipelineColor, 0.0, 1.0);

  rwPipelineFogFactor = uFogEnabled ? clamp((clipPosition.w - uFogFar) * uFogRange, 0.0, 1.0) : 1.0;
}
`;

export default leedsVcsPspBuildingVertexShader;
