import * as THREE from 'three';

export const VCS_WEATHER_NAMES = Object.freeze([
  'SUNNY',
  'CLOUDY',
  'RAINY',
  'FOGGY',
  'EXTRASUNNY',
  'HURRICANE',
  'EXTRACOLOURS',
  'ULTRASUNNY',
]);

export const WEATHER_FLAG = Object.freeze({
  SUNNY: 1 << 0,
  FOGGY: 1 << 1,
  EXTRASUNNY: 1 << 2,
});

export const VCS_WEATHER_FLAGS = Object.freeze([
  WEATHER_FLAG.SUNNY,
  0,
  0,
  WEATHER_FLAG.FOGGY,
  WEATHER_FLAG.SUNNY | WEATHER_FLAG.EXTRASUNNY,
  0,
  0,
  WEATHER_FLAG.SUNNY | WEATHER_FLAG.EXTRASUNNY,
]);

export const TIMECYCLE_FIELD_GROUPS = Object.freeze([
  { key: 'ambient', label: 'Ambient', type: 'rgb' },
  { key: 'ambientObj', label: 'Ambient Obj', type: 'rgb' },
  { key: 'ambientBl', label: 'Ambient BL', type: 'rgb' },
  { key: 'ambientObjBl', label: 'Ambient Obj BL', type: 'rgb' },
  { key: 'directional', label: 'Directional', type: 'rgb' },
  { key: 'skyTop', label: 'Sky Top', type: 'rgb' },
  { key: 'skyBottom', label: 'Sky Bottom', type: 'rgb' },
  { key: 'sunCore', label: 'Sun Core', type: 'rgb' },
  { key: 'sunCorona', label: 'Sun Corona', type: 'rgb' },
  { key: 'sunSize', label: 'Sun Size', type: 'scalar' },
  { key: 'spriteSize', label: 'Sprite Size', type: 'scalar' },
  { key: 'spriteBrightness', label: 'Sprite Brightness', type: 'scalar' },
  { key: 'shadowStrength', label: 'Shadow Strength', type: 'scalar' },
  { key: 'lightShadowStrength', label: 'Light Shadow', type: 'scalar' },
  { key: 'poleShadowStrength', label: 'Pole Shadow', type: 'scalar' },
  { key: 'farClip', label: 'Far Clip', type: 'scalar' },
  { key: 'fogStart', label: 'Fog Start', type: 'scalar' },
  { key: 'radiosityIntensity', label: 'Radiosity Intensity', type: 'scalar' },
  { key: 'radiosityLimit', label: 'Radiosity Limit', type: 'scalar' },
  { key: 'lightOnGround', label: 'Light On Ground', type: 'scalar' },
  { key: 'lowClouds', label: 'Low Clouds', type: 'rgb' },
  { key: 'fluffyCloudTop', label: 'Fluffy Cloud Top', type: 'rgb' },
  { key: 'fluffyCloudBottom', label: 'Fluffy Cloud Bottom', type: 'rgb' },
  { key: 'blur', label: 'Blur RGB', type: 'rgb' },
  { key: 'water', label: 'Water RGBA', type: 'rgba' },
  { key: 'blurAlpha', label: 'Blur Alpha', type: 'scalar' },
  { key: 'blurOffset', label: 'Blur Offset', type: 'scalar' },
  { key: 'fogColor', label: 'Fog Color', type: 'rgb' },
  { key: 'belowHorizonColor', label: 'Below Horizon', type: 'rgb' },
]);

const BELOW_HORIZON_HOURS = Object.freeze([0, 5, 6, 7, 12, 19, 20, 22, 24]);
const BELOW_HORIZON_VALUES = Object.freeze([30, 30, 30, 50, 60, 60, 50, 35]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampByte(value) {
  return clamp(Math.round(value), 0, 255);
}

function makeRgb(r = 0, g = 0, b = 0) {
  return { r, g, b };
}

function makeRgba(r = 0, g = 0, b = 0, a = 255) {
  return { r, g, b, a };
}

function lerp(a, b, t) {
  return a + ((b - a) * t);
}

function lerpRgb(a, b, t) {
  return makeRgb(
    lerp(a.r, b.r, t),
    lerp(a.g, b.g, t),
    lerp(a.b, b.b, t),
  );
}

function lerpRgba(a, b, t) {
  return makeRgba(
    lerp(a.r, b.r, t),
    lerp(a.g, b.g, t),
    lerp(a.b, b.b, t),
    lerp(a.a, b.a, t),
  );
}

function toThreeColor(rgb) {
  return new THREE.Color().setRGB(
    clampByte(rgb.r) / 255,
    clampByte(rgb.g) / 255,
    clampByte(rgb.b) / 255,
    THREE.SRGBColorSpace,
  );
}

function parseVcsEntry(tokens) {
  if (tokens.length < 56) {
    throw new Error(`VCS timecyc row has ${tokens.length} fields, expected 56`);
  }
  let i = 0;
  const next = () => tokens[i++];
  const rgb = () => makeRgb(next(), next(), next());
  return {
    ambient: rgb(),
    ambientObj: rgb(),
    ambientBl: rgb(),
    ambientObjBl: rgb(),
    directional: rgb(),
    skyTop: rgb(),
    skyBottom: rgb(),
    sunCore: rgb(),
    sunCorona: rgb(),
    sunSize: next(),
    spriteSize: next(),
    spriteBrightness: next(),
    shadowStrength: next(),
    lightShadowStrength: next(),
    poleShadowStrength: next(),
    farClip: next(),
    fogStart: next(),
    radiosityIntensity: next(),
    radiosityLimit: next(),
    lightOnGround: next(),
    lowClouds: rgb(),
    fluffyCloudTop: rgb(),
    fluffyCloudBottom: rgb(),
    blur: rgb(),
    water: makeRgba(next(), next(), next(), next()),
    blurAlpha: next(),
    blurOffset: next(),
  };
}

function interpolateEntry(a, b, t) {
  return {
    ambient: lerpRgb(a.ambient, b.ambient, t),
    ambientObj: lerpRgb(a.ambientObj, b.ambientObj, t),
    ambientBl: lerpRgb(a.ambientBl, b.ambientBl, t),
    ambientObjBl: lerpRgb(a.ambientObjBl, b.ambientObjBl, t),
    directional: lerpRgb(a.directional, b.directional, t),
    skyTop: lerpRgb(a.skyTop, b.skyTop, t),
    skyBottom: lerpRgb(a.skyBottom, b.skyBottom, t),
    sunCore: lerpRgb(a.sunCore, b.sunCore, t),
    sunCorona: lerpRgb(a.sunCorona, b.sunCorona, t),
    sunSize: lerp(a.sunSize, b.sunSize, t),
    spriteSize: lerp(a.spriteSize, b.spriteSize, t),
    spriteBrightness: lerp(a.spriteBrightness, b.spriteBrightness, t),
    shadowStrength: lerp(a.shadowStrength, b.shadowStrength, t),
    lightShadowStrength: lerp(a.lightShadowStrength, b.lightShadowStrength, t),
    poleShadowStrength: lerp(a.poleShadowStrength, b.poleShadowStrength, t),
    farClip: lerp(a.farClip, b.farClip, t),
    fogStart: lerp(a.fogStart, b.fogStart, t),
    radiosityIntensity: lerp(a.radiosityIntensity, b.radiosityIntensity, t),
    radiosityLimit: lerp(a.radiosityLimit, b.radiosityLimit, t),
    lightOnGround: lerp(a.lightOnGround, b.lightOnGround, t),
    lowClouds: lerpRgb(a.lowClouds, b.lowClouds, t),
    fluffyCloudTop: lerpRgb(a.fluffyCloudTop, b.fluffyCloudTop, t),
    fluffyCloudBottom: lerpRgb(a.fluffyCloudBottom, b.fluffyCloudBottom, t),
    blur: lerpRgb(a.blur, b.blur, t),
    water: lerpRgba(a.water, b.water, t),
    blurAlpha: lerp(a.blurAlpha, b.blurAlpha, t),
    blurOffset: lerp(a.blurOffset, b.blurOffset, t),
  };
}

function buildFogColor(entry) {
  return makeRgb(
    (entry.skyTop.r + (2 * entry.skyBottom.r)) / 3,
    (entry.skyTop.g + (2 * entry.skyBottom.g)) / 3,
    (entry.skyTop.b + (2 * entry.skyBottom.b)) / 3,
  );
}

function buildBelowHorizonColor(hour, minute) {
  const time = clamp(hour, 0, 23) + (clamp(minute, 0, 59) / 60);
  let idx = 0;
  while (idx + 1 < BELOW_HORIZON_HOURS.length - 1 && time >= BELOW_HORIZON_HOURS[idx + 1]) idx += 1;
  const currentHour = BELOW_HORIZON_HOURS[idx];
  const nextHour = BELOW_HORIZON_HOURS[idx + 1];
  const currentValue = BELOW_HORIZON_VALUES[idx];
  const nextValue = BELOW_HORIZON_VALUES[(idx + 1) % BELOW_HORIZON_VALUES.length];
  const span = Math.max(1, nextHour - currentHour);
  const alpha = clamp((time - currentHour) / span, 0, 1);
  const value = lerp(currentValue, nextValue, alpha);
  return makeRgb(value, value, value);
}

function buildPostFxFromBlur(entry) {
  const blur = entry?.blur || makeRgb(0, 0, 0);
  const alpha = Number.isFinite(Number(entry?.blurAlpha)) ? Number(entry.blurAlpha) : 0;
  return makeRgba(blur.r, blur.g, blur.b, alpha);
}

function sanitizeLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.startsWith('#') && !line.startsWith(';'));
}

function getSchemaForVersion(gameVersion) {
  const version = String(gameVersion || '').trim().toUpperCase();
  if (version === 'VCS') {
    return {
      version,
      weatherNames: VCS_WEATHER_NAMES,
      weatherFlags: VCS_WEATHER_FLAGS,
      parseEntry: parseVcsEntry,
      hours: 24,
      ordering: 'weather-major',
      extraColourWeatherIndex: 6,
      extraColourCount: 1,
    };
  }
  throw new Error(`Timecycle format not implemented for game version: ${version || 'unknown'}`);
}

export function parseTimecyc(text, options = {}) {
  const schema = getSchemaForVersion(options.gameVersion);
  const lines = sanitizeLines(text);
  const expectedRows = schema.hours * schema.weatherNames.length;
  if (lines.length < expectedRows) {
    throw new Error(`timecyc.dat has ${lines.length} data rows, expected at least ${expectedRows}`);
  }
  const entries = [];
  for (let index = 0; index < expectedRows; index += 1) {
    const tokens = lines[index]
      .split(/\s+/)
      .map((token) => Number.parseFloat(token))
      .filter((value) => Number.isFinite(value));
    entries.push(schema.parseEntry(tokens));
  }
  return {
    gameVersion: schema.version,
    hours: schema.hours,
    ordering: schema.ordering || 'hour-major',
    weatherFlags: [...(schema.weatherFlags || [])],
    extraColourWeatherIndex: Number.isFinite(schema.extraColourWeatherIndex) ? schema.extraColourWeatherIndex : -1,
    extraColourCount: Number.isFinite(schema.extraColourCount) ? schema.extraColourCount : 0,
    weatherNames: [...schema.weatherNames],
    entries,
  };
}

export function sampleTimecyc(data, options = {}) {
  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) return null;
  const hour = clamp(Math.floor(Number(options.hour) || 0), 0, data.hours - 1);
  const minute = clamp(Math.floor(Number(options.minute) || 0), 0, 59);
  const timeAlpha = minute / 60;
  const weatherCount = data.weatherNames.length;
  const weatherA = clamp(Math.floor(Number(options.weatherA) || 0), 0, weatherCount - 1);
  const weatherB = clamp(Math.floor(Number(options.weatherB) || 0), 0, weatherCount - 1);
  const weatherBlend = clamp(Number(options.weatherBlend) || 0, 0, 1);
  const rawExtraColour = Number(options.extraColour);
  const extraColour = Number.isFinite(rawExtraColour) ? Math.floor(rawExtraColour) : -1;
  const nextHour = (hour + 1) % data.hours;
  const indexAt = (h, w) => (
    data.ordering === 'weather-major'
      ? (w * data.hours) + h
      : (h * weatherCount) + w
  );

  const weatherASample = interpolateEntry(
    data.entries[indexAt(hour, weatherA)],
    data.entries[indexAt(nextHour, weatherA)],
    timeAlpha,
  );
  const weatherBSample = interpolateEntry(
    data.entries[indexAt(hour, weatherB)],
    data.entries[indexAt(nextHour, weatherB)],
    timeAlpha,
  );
  let current = interpolateEntry(weatherASample, weatherBSample, weatherBlend);
  const extraColourEnabled = (
    extraColour >= 0
    && data.extraColourWeatherIndex >= 0
    && data.extraColourCount > 0
  );
  if (extraColourEnabled) {
    const block = Math.floor(extraColour / data.hours);
    const blockHour = clamp(extraColour % data.hours, 0, data.hours - 1);
    const weatherIndex = data.extraColourWeatherIndex + block;
    if (weatherIndex >= 0 && weatherIndex < weatherCount) {
      current = interpolateEntry(
        data.entries[indexAt(blockHour, weatherIndex)],
        data.entries[indexAt(blockHour, weatherIndex)],
        0,
      );
    }
  }
  const fogColor = buildFogColor(current);
  const belowHorizonColor = buildBelowHorizonColor(hour, minute);
  const postfx1 = buildPostFxFromBlur(current);
  const postfx2 = buildPostFxFromBlur(current);
  const flagsA = data.weatherFlags?.[weatherA] || 0;
  const flagsB = data.weatherFlags?.[weatherB] || 0;
  let cloudCoverage = (flagsA & WEATHER_FLAG.SUNNY) ? 0 : (1 - weatherBlend);
  if ((flagsB & WEATHER_FLAG.SUNNY) === 0) cloudCoverage += weatherBlend;
  let foggyness = (flagsA & WEATHER_FLAG.FOGGY) ? (1 - weatherBlend) : 0;
  if (flagsB & WEATHER_FLAG.FOGGY) foggyness += weatherBlend;
  let extraSunnyness = (flagsA & WEATHER_FLAG.EXTRASUNNY) ? (1 - weatherBlend) : 0;
  if (flagsB & WEATHER_FLAG.EXTRASUNNY) extraSunnyness += weatherBlend;
  if (extraColourEnabled) {
    cloudCoverage = 0;
    foggyness = 0;
    extraSunnyness = 0;
  }

  return {
    hour,
    minute,
    nextHour,
    timeAlpha,
    weatherA,
    weatherB,
    weatherBlend,
    extraColour,
    extraColourEnabled,
    weatherNameA: data.weatherNames[weatherA] || `WEATHER_${weatherA}`,
    weatherNameB: data.weatherNames[weatherB] || `WEATHER_${weatherB}`,
    cloudCoverage,
    foggyness,
    extraSunnyness,
    values: {
      ...current,
      postfx1,
      postfx2,
      fogColor,
      belowHorizonColor,
    },
    three: {
      fogColor: toThreeColor(fogColor),
      belowHorizonColor: toThreeColor(belowHorizonColor),
      skyTop: toThreeColor(current.skyTop),
      skyBottom: toThreeColor(current.skyBottom),
      waterColor: toThreeColor(current.water),
    },
  };
}
