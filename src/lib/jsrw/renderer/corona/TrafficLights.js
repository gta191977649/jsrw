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
    pair.forEach((localPosition, pairIndex) => {
      const worldPosition = toWorldPosition(localPosition, worldMatrix);
      if (!worldPosition) return;
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
