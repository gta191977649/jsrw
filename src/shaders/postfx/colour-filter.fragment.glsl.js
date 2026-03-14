const rwPostFxColourFilterFragmentShader = `
uniform sampler2D uTex;
uniform vec3 uFilterColor1;
uniform vec3 uFilterColor2;
varying vec2 vUv;

void main() {
  vec3 baseColor = texture2D(uTex, vUv).rgb;
  vec3 filtered = baseColor * max(uFilterColor1 * 2.0, vec3(0.0));
  filtered += uFilterColor2 * 0.25;
  filtered = max(filtered, vec3(0.0));
  gl_FragColor = vec4(filtered, 1.0);
}
`;

export default rwPostFxColourFilterFragmentShader;
