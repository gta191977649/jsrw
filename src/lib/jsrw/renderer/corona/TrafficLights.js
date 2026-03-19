const TRAFFIC_LIGHT_PHASE_COLORS = Object.freeze({
  green: { r: 0, g: 255, b: 0, a: 255 },
  yellow: { r: 255, g: 128, b: 0, a: 255 },
  red: { r: 255, g: 0, b: 0, a: 255 },
});

const TRAFFIC_LIGHT_PHASE_SEQUENCE = Object.freeze([
  { phase: 'green', durationMs: 4000 },
  { phase: 'yellow', durationMs: 1000 },
  { phase: 'red', durationMs: 4000 },
]);

const TRAFFIC_LIGHT_MODEL_SPECS = Object.freeze({
  trafficlight1: {
    shadowMode: 'primary',
    buildLocalPairs(effectLights) {
      if (effectLights.length < 6) return [];
      let x = Number(effectLights[0]?.position?.x) || 0;
      let yMin = Number(effectLights[0]?.position?.y) || 0;
      let yMax = yMin;
      let zMin = Number(effectLights[0]?.position?.z) || 0;
      let zMax = zMin;
      for (const effect of effectLights.slice(0, 6)) {
        x = Number(effect?.position?.x) || x;
        yMin = Math.min(yMin, Number(effect?.position?.y) || 0);
        yMax = Math.max(yMax, Number(effect?.position?.y) || 0);
        zMin = Math.min(zMin, Number(effect?.position?.z) || 0);
        zMax = Math.max(zMax, Number(effect?.position?.z) || 0);
      }
      const zMid = (zMin + zMax) * 0.5;
      return [
        {
          phase: 'green',
          pair: [
            { x, y: yMax, z: zMin, facingRule: 'lt-zero' },
            { x, y: yMin, z: zMin, facingRule: 'gte-zero' },
          ],
        },
        {
          phase: 'yellow',
          pair: [
            { x, y: yMax, z: zMid, facingRule: 'lt-zero' },
            { x, y: yMin, z: zMid, facingRule: 'gte-zero' },
          ],
        },
        {
          phase: 'red',
          pair: [
            { x, y: yMax, z: zMax, facingRule: 'lt-zero' },
            { x, y: yMin, z: zMax, facingRule: 'gte-zero' },
          ],
        },
      ];
    },
  },
  mtraffic4: {
    shadowMode: 'primary',
    buildLocalPairs(effectLights) {
      if (effectLights.length < 3) return [];
      return [
        { phase: 'green', pair: [{ ...effectLights[2].position, facingRule: 'lt-zero' }] },
        { phase: 'yellow', pair: [{ ...effectLights[1].position, facingRule: 'lt-zero' }] },
        { phase: 'red', pair: [{ ...effectLights[0].position, facingRule: 'lt-zero' }] },
      ];
    },
  },
  mtraffic1: {
    shadowMode: 'midpoint',
    buildLocalPairs(effectLights) {
      if (effectLights.length < 6) return [];
      return [
        {
          phase: 'green',
          pair: [
            { ...effectLights[4].position, facingRule: 'gt-zero' },
            { ...effectLights[5].position, facingRule: 'lte-zero' },
          ],
        },
        {
          phase: 'yellow',
          pair: [
            { ...effectLights[2].position, facingRule: 'gt-zero' },
            { ...effectLights[3].position, facingRule: 'lte-zero' },
          ],
        },
        {
          phase: 'red',
          pair: [
            { ...effectLights[0].position, facingRule: 'gt-zero' },
            { ...effectLights[1].position, facingRule: 'lte-zero' },
          ],
        },
      ];
    },
  },
  mtraffic2: {
    shadowMode: 'midpoint',
    buildLocalPairs(effectLights) {
      if (effectLights.length < 6) return [];
      return [
        {
          phase: 'green',
          pair: [
            { ...effectLights[2].position, facingRule: 'gt-zero' },
            { ...effectLights[5].position, facingRule: 'lte-zero' },
          ],
        },
        {
          phase: 'yellow',
          pair: [
            { ...effectLights[1].position, facingRule: 'gt-zero' },
            { ...effectLights[4].position, facingRule: 'lte-zero' },
          ],
        },
        {
          phase: 'red',
          pair: [
            { ...effectLights[0].position, facingRule: 'gt-zero' },
            { ...effectLights[3].position, facingRule: 'lte-zero' },
          ],
        },
      ];
    },
  },
});

function toThreeBasisVector(x, y, z) {
  return {
    x: -(Number(x) || 0),
    y: Number(z) || 0,
    z: Number(y) || 0,
  };
}

export function computeTrafficLightBrightness(runtimeContext = null) {
  const hour = ((Math.floor(Number(runtimeContext?.timecycleCurrent?.hour) || 0) % 24) + 24) % 24;
  const minute = THREE_MATH_CLAMP_MINUTE(Number(runtimeContext?.timecycleCurrent?.minute) || 0);
  const foggyness = Math.max(0, Math.min(1, Number(runtimeContext?.timecycleCurrent?.foggyness ?? runtimeContext?.foggyness ?? 0) || 0));

  let brightness = 0;
  if (hour === 18) brightness = minute / 60;
  else if (hour > 18 || hour < 6) brightness = 1;
  else if (hour === 6) brightness = 1 - (minute / 60);

  return Math.max(brightness, foggyness);
}

function THREE_MATH_CLAMP_MINUTE(value) {
  return Math.max(0, Math.min(59, Math.floor(Number(value) || 0)));
}

export function isTrafficLightModelName(modelName) {
  return Object.hasOwn(TRAFFIC_LIGHT_MODEL_SPECS, String(modelName || '').trim().toLowerCase());
}

function normalizeDegrees(angle) {
  return ((angle % 360) + 360) % 360;
}

export function findTrafficLightTypeFromForward(forward = null) {
  const threeX = Number(forward?.x) || 0;
  const threeZ = Number(forward?.z) || 0;
  const gtaX = -threeX;
  const gtaY = threeZ;
  const orientation = normalizeDegrees((Math.atan2(gtaX, gtaY) * 180) / Math.PI);
  if (
    (orientation > 60 && orientation < 150)
    || (orientation > 240 && orientation < 330)
  ) {
    return 1;
  }
  return 2;
}

export function buildTrafficLightCoronaEmitters(options = {}) {
  const {
    effectLights = [],
    placement = null,
    placementIndex = 0,
    worldMatrix = null,
    baseId = '',
    toWorldPosition = null,
    toWorldDirection = null,
  } = options;

  if (!placement || !worldMatrix || typeof toWorldPosition !== 'function') return [];
  const modelName = String(placement.modelName || '').trim().toLowerCase();
  const modelSpec = TRAFFIC_LIGHT_MODEL_SPECS[modelName];
  if (!modelSpec) return [];

  const phasePairs = modelSpec.buildLocalPairs(effectLights);
  if (phasePairs.length === 0) return [];

  const worldForward = typeof toWorldDirection === 'function'
    ? toWorldDirection({ x: 0, y: 1, z: 0 }, worldMatrix)
    : null;
  const trafficLightType = findTrafficLightTypeFromForward(worldForward);

  const emitters = [];
  phasePairs.forEach(({ phase, pair }) => {
    const phaseColor = TRAFFIC_LIGHT_PHASE_COLORS[phase];
    const worldPositions = [];
    pair.forEach((localPosition, pairIndex) => {
      const worldPosition = toWorldPosition(localPosition, worldMatrix);
      if (!worldPosition) return;
      worldPositions.push(worldPosition);
      emitters.push({
        id: `trafficlight:${baseId}:${phase}:${pairIndex}`,
        sourceType: 'trafficLight',
        modelName: placement.modelName,
        placementIndex,
        position: worldPosition,
        direction: worldForward,
        trafficLightForward: worldForward,
        trafficLightFacingRule: localPosition.facingRule || 'always',
        trafficLightPhase: phase,
        trafficLightType,
        color: phaseColor,
        alpha: 255,
        size: 1.75,
        sizeMode: 'trafficLight',
        drawDistance: 50,
        textureKey: 'coronastar',
        flareType: 0,
        reflection: 1,
        losCheck: false,
        longDistance: false,
        visibilityMode: 'traffic-light',
      });
    });

    if (worldPositions.length > 0) {
      const shadowPosition = modelSpec.shadowMode === 'midpoint' && worldPositions.length > 1
        ? {
          x: (Number(worldPositions[0].x) + Number(worldPositions[1].x)) * 0.5,
          y: (Number(worldPositions[0].y) + Number(worldPositions[1].y)) * 0.5,
          z: (Number(worldPositions[0].z) + Number(worldPositions[1].z)) * 0.5,
        }
        : worldPositions[0];
      emitters.push({
        id: `trafficlight-shadow:${baseId}:${phase}`,
        sourceType: 'trafficLightShadow',
        modelName: placement.modelName,
        placementIndex,
        position: shadowPosition,
        trafficLightPhase: phase,
        trafficLightType,
        trafficLightIgnoreFacing: true,
        color: phaseColor,
        drawDistance: 40,
        visibilityMode: 'traffic-light',
        shadow: {
          textureKey: 'shad_exp',
          size: 8,
          intensity: 128,
          front: toThreeBasisVector(8, 0, 0),
          side: toThreeBasisVector(0, -8, 0),
          zDistance: 12,
          drawDistance: 40,
          colorScale: 'trafficLightGround',
        },
      });
    }
  });

  return emitters;
}

export function resolveTrafficLightPhase(timeMs = 0, trafficLightType = 1, settings = null) {
  const forcedPhase = String(settings?.forcePhase || 'auto').toLowerCase();
  if (forcedPhase === 'none' || forcedPhase === 'red' || forcedPhase === 'yellow' || forcedPhase === 'green') return forcedPhase;

  const normalizedTime = ((Math.floor(Number(timeMs) || 0) % 16384) + 16384) % 16384;
  const windBlink = Boolean(settings?.windBlinking);
  const windStrength = Number(settings?.windStrength) || 0;

  if (windBlink && windStrength > 1.1) {
    return (normalizedTime & 0x400) !== 0 ? 'none' : 'yellow';
  }

  if (Number(trafficLightType) === 1) {
    if (normalizedTime < 5000) return 'green';
    if (normalizedTime < 6000) return 'yellow';
    return 'red';
  }

  if (normalizedTime < 6000) return 'red';
  if (normalizedTime < 11000) return 'green';
  if (normalizedTime < 12000) return 'yellow';
  return 'red';
}
