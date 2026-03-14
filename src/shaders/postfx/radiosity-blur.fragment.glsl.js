const rwPostFxRadiosityBlurFragmentShader = `
uniform sampler2D uTex;
uniform vec2 uTexelSize;
uniform vec2 uOffsets[4];
uniform float uTapWeight;
varying vec2 vUv;

void main() {
  vec3 color = vec3(0.0);
  for (int i = 0; i < 4; i += 1) {
    vec2 uv = clamp(vUv + (uOffsets[i] * uTexelSize), 0.0, 1.0);
    color += texture2D(uTex, uv).rgb;
  }
  gl_FragColor = vec4(color * uTapWeight, 1.0);
}
`;

export default rwPostFxRadiosityBlurFragmentShader;
