const skyFragmentShader = `
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform vec3 uFogColor;
uniform vec3 uBelowHorizonColor;
uniform vec3 uCameraForward;
uniform vec3 uCameraRight;
uniform vec3 uCameraUp;
uniform float uHorizonY;
uniform float uSmallStripHeight;
uniform float uHorizonStrength;
uniform float uLowerBandEndY;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uBelowHorizonMix;

varying vec2 vUv;

void main() {
  vec2 ndc = (vUv * 2.0) - 1.0;
  vec3 viewDir = normalize(
    uCameraForward
    + (ndc.x * uAspect * uTanHalfFov * uCameraRight)
    + (ndc.y * uTanHalfFov * uCameraUp)
  );
  float elevation = clamp(viewDir.y * 0.5 + 0.5, 0.0, 1.0);
  float horizonVisible = step(0.0, uHorizonY) * step(uHorizonY, 1.0);
  float horizonAnchor = clamp(uHorizonY, 0.0, 1.0);

  float skyT = smoothstep(horizonAnchor, 1.0, vUv.y);
  vec3 color = mix(uSkyBottom, uSkyTop, clamp(skyT, 0.0, 1.0));

  float smallStripHeight = max(0.003, uSmallStripHeight);
  float smallStripMask = (1.0 - smoothstep(0.0, smallStripHeight, abs(vUv.y - horizonAnchor))) * horizonVisible;
  color = mix(color, uFogColor, smallStripMask * uHorizonStrength);

  float lowerStart = horizonAnchor - smallStripHeight;
  float lowerEnd = min(lowerStart, uLowerBandEndY);
  float lowerMask = (1.0 - step(horizonAnchor, vUv.y)) * smoothstep(lowerEnd, lowerStart, vUv.y) * horizonVisible;
  vec3 belowHorizonColor = mix(uBelowHorizonColor, uSkyBottom, uBelowHorizonMix);
  color = mix(color, mix(belowHorizonColor, uFogColor, smoothstep(lowerEnd, lowerStart, vUv.y)), lowerMask);

  gl_FragColor = vec4(color, 1.0);
}
`;

export default skyFragmentShader;
