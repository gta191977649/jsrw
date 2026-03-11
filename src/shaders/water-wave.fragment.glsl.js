const waterWaveFragmentShader = `
#include <colorspace_pars_fragment>

uniform sampler2D uMap;
uniform vec2 uUvOffset;
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uAlpha;
uniform float uAlphaScale;
uniform float uDistanceAlphaStrength;
varying vec2 vUv;
varying float vNearWeight;
varying vec3 vNormalWS;
varying vec3 vViewDirWS;
varying float vViewDistance;

void main() {
  vec2 uvPrimary = vUv + uUvOffset;
  vec2 uvSecondary = (vUv * 1.75) + (uUvOffset * vec2(1.9, 0.65));
  vec4 texel = texture2D(uMap, uvPrimary);
  vec4 flowTexel = texture2D(uMap, uvSecondary);
  vec3 normal = normalize(vNormalWS);
  if (!gl_FrontFacing) {
    normal = -normal;
  }
  vec3 viewDir = normalize(vViewDirWS);
  float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.4);
  float facing = 0.45 + (0.55 * max(normal.y, 0.0));
  float streak = smoothstep(0.3, 0.95, flowTexel.r);
  vec3 litColor = texel.rgb * uColor * facing;
  litColor += vec3(0.10, 0.22, 0.24) * streak * (0.25 + 0.75 * fresnel);
  litColor += vec3(0.06, 0.12, 0.13) * vNearWeight;
  litColor += fresnel * 0.34;
  float fogFactor = smoothstep(uFogNear, uFogFar, vViewDistance);
  litColor = mix(litColor, uFogColor, fogFactor);
  float coverage = 0.45 + (0.55 * vNearWeight);
  float alphaCoverage = mix(1.0, coverage, uDistanceAlphaStrength);
  float alpha = uAlpha * uAlphaScale * alphaCoverage * (0.96 + (0.12 * vNearWeight));
  gl_FragColor = vec4(litColor, alpha);
  #include <colorspace_fragment>
}
`;

export default waterWaveFragmentShader;
