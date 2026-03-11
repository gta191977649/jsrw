const waterWaveVertexShader = `
uniform float uTime;
uniform int uWaveEnabled;
uniform float uWaveHeight;
uniform vec3 uCameraWorldPos;
uniform float uWaveRadiusInner;
uniform float uWaveRadiusOuter;
varying vec2 vUv;
varying float vNearWeight;
varying vec3 vNormalWS;
varying vec3 vViewDirWS;
varying float vViewDistance;

void main() {
  vUv = uv;
  vec3 transformed = position;
  vec4 baseWorldPos = modelMatrix * vec4(position, 1.0);
  vec3 localNormal = normal;
  vec2 worldXZ = baseWorldPos.xz;
  vec2 camXZ = uCameraWorldPos.xz;
  float distToCam = distance(worldXZ, camXZ);
  float waveWeight = 1.0 - smoothstep(uWaveRadiusInner, uWaveRadiusOuter, distToCam);
  vNearWeight = waveWeight;

  if (uWaveEnabled == 1) {
    if (waveWeight > 0.0) {
      float phaseA = ((worldXZ.x + worldXZ.y) * 0.085) + (uTime * 2.1);
      float phaseB = ((worldXZ.y - worldXZ.x) * 0.14) + (uTime * 3.35);
      float waveA = sin(phaseA);
      float waveB = sin(phaseB);
      float height = (waveA + (0.35 * waveB)) * uWaveHeight * waveWeight;
      transformed.y += height;

      float dAdx = 0.085;
      float dAdz = 0.085;
      float dBdx = -0.14;
      float dBdz = 0.14;
      float dhdx = (cos(phaseA) * dAdx + 0.35 * cos(phaseB) * dBdx) * uWaveHeight * waveWeight;
      float dhdz = (cos(phaseA) * dAdz + 0.35 * cos(phaseB) * dBdz) * uWaveHeight * waveWeight;
      localNormal = normalize(vec3(-dhdx, 1.0, -dhdz));
    }
  }

  vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
  vNormalWS = normalize(mat3(modelMatrix) * localNormal);
  vViewDirWS = normalize(cameraPosition - worldPos.xyz);
  vViewDistance = distance(cameraPosition, worldPos.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

export default waterWaveVertexShader;
