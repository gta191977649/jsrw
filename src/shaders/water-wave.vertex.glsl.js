const waterWaveVertexShader = `
#ifdef USE_INSTANCING
attribute mat4 instanceMatrix;
attribute float instanceFade;
#endif
attribute float fade;

uniform float uTime;
uniform int uWaveEnabled;
uniform float uWaveHeight;
uniform float uWind;
uniform vec3 uCameraWorldPos;
uniform float uWaveRadiusInner;
uniform float uWaveRadiusOuter;
varying vec2 vUv;
varying float vNearWeight;
varying vec3 vNormalWS;
varying vec3 vViewDirWS;
varying float vViewDistance;
varying float vPatchFade;

void main() {
  vUv = uv;
  vPatchFade = fade;
  vec3 transformed = position;
  mat4 worldMatrix = modelMatrix;
  #ifdef USE_INSTANCING
    worldMatrix = modelMatrix * instanceMatrix;
    vPatchFade = instanceFade;
  #endif
  vec4 baseWorldPos = worldMatrix * vec4(position, 1.0);
  vec3 localNormal = normal;
  vec2 worldXZ = baseWorldPos.xz;
  vec2 camXZ = uCameraWorldPos.xz;
  float distToCam = distance(worldXZ, camXZ);
  float waveWeight = 1.0 - smoothstep(uWaveRadiusInner, uWaveRadiusOuter, distToCam);
  vNearWeight = waveWeight;

  if (uWaveEnabled == 1) {
    if (waveWeight > 0.0) {
      vec2 sectorUv = fract(worldXZ / 32.0);
      float gridX = sectorUv.x * 8.0;
      float gridY = sectorUv.y * 8.0;
      float angle = mod(uTime * (6.28318530718 / 4.096), 6.28318530718);
      float waveA = sin(((gridX + gridY) * 0.78539816339) + angle);
      float waveB = sin(((gridY - gridX) * 3.14159265359) + (2.0 * angle));
      float windFactorA = (uWind * 0.7) + 0.3;
      float windFactorB = uWind * 0.2;
      float height = ((windFactorA * waveA) + (windFactorB * waveB)) * uWaveHeight * waveWeight;
      transformed.y += height;

      float dGrid = 8.0 / 32.0;
      float dAdx = 0.78539816339 * dGrid;
      float dAdz = 0.78539816339 * dGrid;
      float dBdx = -3.14159265359 * dGrid;
      float dBdz = 3.14159265359 * dGrid;
      float dhdx = ((windFactorA * cos(((gridX + gridY) * 0.78539816339) + angle) * dAdx)
        + (windFactorB * cos(((gridY - gridX) * 3.14159265359) + (2.0 * angle)) * dBdx)) * uWaveHeight * waveWeight;
      float dhdz = ((windFactorA * cos(((gridX + gridY) * 0.78539816339) + angle) * dAdz)
        + (windFactorB * cos(((gridY - gridX) * 3.14159265359) + (2.0 * angle)) * dBdz)) * uWaveHeight * waveWeight;
      localNormal = normalize(vec3(-dhdx, 1.0, -dhdz));
    }
  }

  vec4 worldPos = worldMatrix * vec4(transformed, 1.0);
  vNormalWS = normalize(mat3(worldMatrix) * localNormal);
  vViewDirWS = normalize(cameraPosition - worldPos.xyz);
  vViewDistance = distance(cameraPosition, worldPos.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

export default waterWaveVertexShader;
