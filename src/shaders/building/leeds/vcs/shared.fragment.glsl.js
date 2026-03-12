const sharedLeedsBuildingFragmentShader = `
uniform sampler2D map;
uniform float uColorScale;
uniform float opacity;
uniform float alphaTest;

varying vec4 rwPipelineColor;
varying vec2 rwPipelineUv;

void main() {
  vec4 color = rwPipelineColor * texture2D(map, vec2(rwPipelineUv.x, 1.0 - rwPipelineUv.y)) * uColorScale;
  color.a *= opacity;
  color.rgb = clamp(color.rgb, 0.0, 1.0);

  if (color.a < alphaTest) {
    discard;
  }

  gl_FragColor = color;
  #include <colorspace_fragment>
}
`;

export default sharedLeedsBuildingFragmentShader;
