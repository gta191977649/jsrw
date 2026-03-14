const rwPostFxRadiosityThresholdFragmentShader = `
uniform sampler2D uTex;
uniform float uLimit;
varying vec2 vUv;

void main() {
  vec3 sampled = texture2D(uTex, vUv).rgb;
  vec3 result = max(sampled - vec3(uLimit * 0.5), vec3(0.0));
  gl_FragColor = vec4(result, 1.0);
}
`;

export default rwPostFxRadiosityThresholdFragmentShader;
