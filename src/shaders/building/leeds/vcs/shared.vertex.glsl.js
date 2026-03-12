const sharedLeedsBuildingVertexShader = `
uniform vec3 uAmb;
uniform vec3 uEmiss;
uniform float uSurfaceEmissiveScale;
uniform bool uUseVertexColor;

varying vec4 rwPipelineColor;
varying vec2 rwPipelineUv;

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

vec4 applyLeedsProfile(vec4 vertexColor, vec3 ambientColor, vec3 emissiveColor, float emissiveScale) {
  vec4 outputColor = vertexColor;
  outputColor.rgb *= ambientColor;
  outputColor.rgb += emissiveColor * emissiveScale;
  outputColor = clamp(outputColor, 0.0, 1.0);
  return outputColor;
}

void main() {
  vec4 localPosition = getLocalPosition();
  vec4 worldPosition = modelMatrix * localPosition;
  vec4 mvPosition = viewMatrix * worldPosition;
  vec4 clipPosition = projectionMatrix * mvPosition;

  gl_Position = clipPosition;
  rwPipelineUv = uv;
  rwPipelineColor = applyLeedsProfile(getVertexColor(), uAmb, uEmiss, uSurfaceEmissiveScale);
}
`;

export default sharedLeedsBuildingVertexShader;
