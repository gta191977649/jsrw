const rwPostFxCopyFragmentShader = `
uniform sampler2D uTex;
uniform vec2 uUvOffset;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;

void main() {
  vec2 uv = clamp(vUv + uUvOffset, 0.0, 1.0);
  gl_FragColor = vec4(texture2D(uTex, uv).rgb * uColor, uOpacity);
}
`;

export default rwPostFxCopyFragmentShader;
