const COMMENT_RE = /(#|;|\/\/).*$/g;

/**
 * 2DFX section format (GTA III / Vice City)
 *
 * # type 0: lights (III/VC)
 * Id, X, Y, Z, R, G, B, A, 2DFXType, "Corona", "Shadow", Distance, OuterRange, Size, ShadowSize, ShadowIntensity, LightType, RoadReflection, Flare, Flags
 *
 * # type 1: particles (III/VC)
 * Id, X, Y, Z, R, G, B, A, 2DFXType, Particle, StrengthX, StrengthY, StrengthZ, Scale
 *
 * # type 2 (III/VC)
 * Id, X, Y, Z, R, G, B, A, 2DFXType, unknown, unk1, unk2, unk3, Probability
 *
 * # type 3: peds (VC)
 * Id, X, Y, Z, R, G, B, A, 2DFXType, Behavior, unk1, unk2, unk3, RotX, RotY, RotZ
 *
 * # type 4: sun reflections (VC)
 * Id, X, Y, Z, R, G, B, A, 2DFXType
 */

export const IDE_EFFECT_TYPE = Object.freeze({
  LIGHT: 0,
  PARTICLE: 1,
  ATTRACTOR: 2,
  PED_ATTRACTOR: 3,
  SUN_GLARE: 4,
});

export const IDE_LIGHT_TYPE = Object.freeze({
  ON: 0,
  ON_NIGHT: 1,
  FLICKER: 2,
  FLICKER_NIGHT: 3,
  FLASH1: 4,
  FLASH1_NIGHT: 5,
  FLASH2: 6,
  FLASH2_NIGHT: 7,
  FLASH3: 8,
  FLASH3_NIGHT: 9,
  RANDOM_FLICKER: 10,
  RANDOM_FLICKER_NIGHT: 11,
  SPECIAL: 12,
  BRIDGE_FLASH1: 13,
  BRIDGE_FLASH2: 14,
});

export const IDE_LIGHT_FLAG = Object.freeze({
  LOS_CHECK: 1,
  LOSCHECK: 1,
  FOG_NORMAL: 2,
  FOG_ALWAYS: 4,
  FOG_TYPE_MASK: 6,
  FOG_TYPE_SHIFT: 1,
  HIDE_OBJECT: 8,
  LONG_DISTANCE: 16,
  LONG_DIST: 16,
});

function cleanLine(line) {
  return String(line || '').replace(COMMENT_RE, '').trim();
}

export function normalizePath(input) {
  return String(input || '').trim().replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

export function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  result.push(current.trim());
  return result;
}

function unquote(value) {
  const normalized = String(value || '').trim();
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function attachEffectsToDefinitions(byId, effectsById) {
  for (const definition of byId.values()) {
    definition.effects = effectsById.get(definition.id) || [];
  }
}

function normalize2dfxLightFlags(flags) {
  let normalizedFlags = Number.isFinite(flags) ? flags | 0 : 0;
  if (normalizedFlags & IDE_LIGHT_FLAG.FOG_ALWAYS) {
    normalizedFlags &= ~IDE_LIGHT_FLAG.FOG_NORMAL;
  }
  return normalizedFlags;
}

function parse2dfxLight(tokens, rawLine) {
  if (tokens.length < 20) return null;
  const id = Number.parseInt(tokens[0], 10);
  const x = Number.parseFloat(tokens[1]);
  const y = Number.parseFloat(tokens[2]);
  const z = Number.parseFloat(tokens[3]);
  const r = Number.parseInt(tokens[4], 10);
  const g = Number.parseInt(tokens[5], 10);
  const b = Number.parseInt(tokens[6], 10);
  const a = Number.parseInt(tokens[7], 10);
  const effectType = Number.parseInt(tokens[8], 10);
  if (!Number.isFinite(id) || ![x, y, z, r, g, b].every(Number.isFinite)) return null;
  if (effectType !== IDE_EFFECT_TYPE.LIGHT) return null;

  const shadowIntensity = Number.parseInt(tokens[15], 10);
  const lightType = Number.parseInt(tokens[16], 10);
  const roadReflection = Number.parseInt(tokens[17], 10);
  const flare = Number.parseInt(tokens[18], 10);
  const flags = normalize2dfxLightFlags(Number.parseInt(tokens[19], 10));
  const shadowSize = Number.parseFloat(tokens[14]);

  return {
    type: effectType,
    kind: 'light',
    modelId: id,
    position: { x, y, z },
    color: {
      r,
      g,
      b,
      a: Number.isFinite(a) ? a : 255,
    },
    alpha: Number.isFinite(a) ? a : 255,
    coronaTextureName: unquote(tokens[9]).toLowerCase(),
    shadowTextureName: unquote(tokens[10]).toLowerCase(),
    distance: Number.parseFloat(tokens[11]),
    outerRange: Number.parseFloat(tokens[12]),
    size: Number.parseFloat(tokens[13]),
    innerRange: shadowSize,
    shadowSize,
    shadowIntensity: Number.isFinite(shadowIntensity) ? shadowIntensity : 0,
    flash: Number.isFinite(lightType) ? lightType : 0,
    lightType: Number.isFinite(lightType) ? lightType : 0,
    wet: Number.isFinite(roadReflection) ? roadReflection : 0,
    roadReflection: Number.isFinite(roadReflection) ? roadReflection : 0,
    flare: Number.isFinite(flare) ? flare : 0,
    flags,
    raw: rawLine,
  };
}

function parse2dfxParticle(tokens, rawLine) {
  if (tokens.length < 14) return null;
  const id = Number.parseInt(tokens[0], 10);
  const x = Number.parseFloat(tokens[1]);
  const y = Number.parseFloat(tokens[2]);
  const z = Number.parseFloat(tokens[3]);
  const r = Number.parseInt(tokens[4], 10);
  const g = Number.parseInt(tokens[5], 10);
  const b = Number.parseInt(tokens[6], 10);
  const a = Number.parseInt(tokens[7], 10);
  const effectType = Number.parseInt(tokens[8], 10);
  if (!Number.isFinite(id) || ![x, y, z, r, g, b].every(Number.isFinite)) return null;
  if (effectType !== IDE_EFFECT_TYPE.PARTICLE) return null;

  return {
    type: effectType,
    kind: 'particle',
    modelId: id,
    position: { x, y, z },
    color: {
      r,
      g,
      b,
      a: Number.isFinite(a) ? a : 255,
    },
    alpha: Number.isFinite(a) ? a : 255,
    particle: unquote(tokens[9]).toLowerCase(),
    strengthX: Number.parseFloat(tokens[10]),
    strengthY: Number.parseFloat(tokens[11]),
    strengthZ: Number.parseFloat(tokens[12]),
    scale: Number.parseFloat(tokens[13]),
    raw: rawLine,
  };
}

function parse2dfxAttractor(tokens, rawLine) {
  if (tokens.length < 14) return null;
  const id = Number.parseInt(tokens[0], 10);
  const x = Number.parseFloat(tokens[1]);
  const y = Number.parseFloat(tokens[2]);
  const z = Number.parseFloat(tokens[3]);
  const r = Number.parseInt(tokens[4], 10);
  const g = Number.parseInt(tokens[5], 10);
  const b = Number.parseInt(tokens[6], 10);
  const a = Number.parseInt(tokens[7], 10);
  const effectType = Number.parseInt(tokens[8], 10);
  if (!Number.isFinite(id) || ![x, y, z, r, g, b].every(Number.isFinite)) return null;
  if (effectType !== IDE_EFFECT_TYPE.ATTRACTOR) return null;

  return {
    type: effectType,
    kind: 'attractor',
    modelId: id,
    position: { x, y, z },
    color: {
      r,
      g,
      b,
      a: Number.isFinite(a) ? a : 255,
    },
    alpha: Number.isFinite(a) ? a : 255,
    unk1: tokens[10],
    unk2: tokens[11],
    unk3: tokens[12],
    probability: Number.parseInt(tokens[13], 10),
    raw: rawLine,
  };
}

function parse2dfxPedAttractor(tokens, rawLine) {
  if (tokens.length < 16) return null;
  const id = Number.parseInt(tokens[0], 10);
  const x = Number.parseFloat(tokens[1]);
  const y = Number.parseFloat(tokens[2]);
  const z = Number.parseFloat(tokens[3]);
  const r = Number.parseInt(tokens[4], 10);
  const g = Number.parseInt(tokens[5], 10);
  const b = Number.parseInt(tokens[6], 10);
  const a = Number.parseInt(tokens[7], 10);
  const effectType = Number.parseInt(tokens[8], 10);
  if (!Number.isFinite(id) || ![x, y, z, r, g, b].every(Number.isFinite)) return null;
  if (effectType !== IDE_EFFECT_TYPE.PED_ATTRACTOR) return null;

  return {
    type: effectType,
    kind: 'pedAttractor',
    modelId: id,
    position: { x, y, z },
    color: {
      r,
      g,
      b,
      a: Number.isFinite(a) ? a : 255,
    },
    alpha: Number.isFinite(a) ? a : 255,
    behavior: unquote(tokens[9]).toLowerCase(),
    unk1: tokens[10],
    unk2: tokens[11],
    unk3: tokens[12],
    rotX: Number.parseFloat(tokens[13]),
    rotY: Number.parseFloat(tokens[14]),
    rotZ: Number.parseFloat(tokens[15]),
    raw: rawLine,
  };
}

function parse2dfxSunGlare(tokens, rawLine) {
  if (tokens.length < 9) return null;
  const id = Number.parseInt(tokens[0], 10);
  const x = Number.parseFloat(tokens[1]);
  const y = Number.parseFloat(tokens[2]);
  const z = Number.parseFloat(tokens[3]);
  const r = Number.parseInt(tokens[4], 10);
  const g = Number.parseInt(tokens[5], 10);
  const b = Number.parseInt(tokens[6], 10);
  const a = Number.parseInt(tokens[7], 10);
  const effectType = Number.parseInt(tokens[8], 10);
  if (!Number.isFinite(id) || ![x, y, z, r, g, b].every(Number.isFinite)) return null;
  if (effectType !== IDE_EFFECT_TYPE.SUN_GLARE) return null;

  return {
    type: effectType,
    kind: 'sunGlare',
    modelId: id,
    position: { x, y, z },
    color: {
      r,
      g,
      b,
      a: Number.isFinite(a) ? a : 255,
    },
    alpha: Number.isFinite(a) ? a : 255,
    raw: rawLine,
  };
}

function parse2dfxEntry(tokens, rawLine) {
  if (tokens.length < 9) return null;
  const effectType = Number.parseInt(tokens[8], 10);
  switch (effectType) {
    case IDE_EFFECT_TYPE.LIGHT:
      return parse2dfxLight(tokens, rawLine);
    case IDE_EFFECT_TYPE.PARTICLE:
      return parse2dfxParticle(tokens, rawLine);
    case IDE_EFFECT_TYPE.ATTRACTOR:
      return parse2dfxAttractor(tokens, rawLine);
    case IDE_EFFECT_TYPE.PED_ATTRACTOR:
      return parse2dfxPedAttractor(tokens, rawLine);
    case IDE_EFFECT_TYPE.SUN_GLARE:
      return parse2dfxSunGlare(tokens, rawLine);
    default:
      return null;
  }
}

function parseIdeObjectEntry(tokens, rawLine, section) {
  if (tokens.length < 3) return null;

  const id = Number.parseInt(tokens[0], 10);
  const modelName = String(tokens[1] || '').toLowerCase();
  const txdName = String(tokens[2] || '').toLowerCase();

  if (!Number.isFinite(id) || !modelName || !txdName) return null;

  const countToken = Number.parseInt(tokens[3], 10);
  const drawCount = Number.isFinite(countToken) && countToken > 0 ? countToken : 1;
  const drawValues = [];
  for (let index = 0; index < drawCount; index += 1) {
    const drawValue = Number.parseFloat(tokens[4 + index]);
    if (Number.isFinite(drawValue)) drawValues.push(drawValue);
  }

  const parsedFlags = Number.parseInt(tokens[tokens.length - 1], 10);
  return {
    id,
    modelName,
    txdName,
    drawDistance: drawValues.length > 0 ? Math.max(...drawValues) : null,
    flags: Number.isFinite(parsedFlags) ? parsedFlags : 0,
    section,
    raw: rawLine,
  };
}

function parseRotationAndLod(tokens, gameVersion) {
  const version = String(gameVersion || 'VCS').toUpperCase();
  const isQuaternionLike = (x, y, z, w) => {
    if (![x, y, z, w].every(Number.isFinite)) return false;
    if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z), Math.abs(w)) > 1.2) return false;
    const normSq = (x * x) + (y * y) + (z * z) + (w * w);
    return normSq > 0.2 && normSq < 1.8;
  };

  const trySa = () => {
    if (tokens.length < 10) return null;
    const rx = Number.parseFloat(tokens[6]);
    const ry = Number.parseFloat(tokens[7]);
    const rz = Number.parseFloat(tokens[8]);
    const rw = Number.parseFloat(tokens[9]);
    const lod = Number.parseInt(tokens[10], 10);
    if (!isQuaternionLike(rx, ry, rz, rw)) return null;
    return { rotation: { x: rx, y: ry, z: rz, w: rw }, lod: Number.isFinite(lod) ? lod : -1 };
  };

  const tryVcs = () => {
    if (tokens.length < 13) return null;
    const rx = Number.parseFloat(tokens[9]);
    const ry = Number.parseFloat(tokens[10]);
    const rz = Number.parseFloat(tokens[11]);
    const rw = Number.parseFloat(tokens[12]);
    const lod = Number.parseInt(tokens[13], 10);
    if (!isQuaternionLike(rx, ry, rz, rw)) return null;
    return { rotation: { x: rx, y: ry, z: rz, w: rw }, lod: Number.isFinite(lod) ? lod : -1 };
  };

  if (version === 'SA') return trySa() ?? tryVcs();
  if (version === 'VCS') return tryVcs() ?? trySa();
  return tryVcs() ?? trySa();
}

export class SectionLoader {
  constructor(options = {}) {
    this.gameVersion = String(options.gameVersion || 'VCS').toUpperCase();
    this.sections = new Map();
    this.sectionAliases = new Map();
  }

  registerSection(name, definition = {}) {
    const normalizedName = String(name || '').trim().toLowerCase();
    if (!normalizedName) {
      throw new Error('Section name is required');
    }

    const normalizedDefinition = {
      ...definition,
      name: normalizedName,
      aliases: (definition.aliases || []).map((alias) => String(alias || '').trim().toLowerCase()).filter(Boolean),
    };

    this.sections.set(normalizedName, normalizedDefinition);
    this.sectionAliases.set(normalizedName, normalizedName);
    for (const alias of normalizedDefinition.aliases) {
      this.sectionAliases.set(alias, normalizedName);
    }
    return this;
  }

  getSection(name) {
    const normalizedName = this.sectionAliases.get(String(name || '').trim().toLowerCase());
    if (!normalizedName) return null;
    return this.sections.get(normalizedName) || null;
  }

  parse(content, state = {}) {
    let activeSection = null;

    for (const raw of String(content || '').split(/\r?\n/)) {
      const line = cleanLine(raw);
      if (!line) continue;

      const lowered = line.toLowerCase();
      if (lowered === 'end') {
        activeSection = null;
        continue;
      }

      const declaredSection = this.getSection(lowered);
      if (declaredSection) {
        activeSection = declaredSection;
        continue;
      }

      if (!activeSection?.parseLine) continue;
      const tokens = parseCsvLine(line);
      activeSection.parseLine({
        loader: this,
        section: activeSection,
        state,
        line,
        raw,
        tokens,
      });
    }

    return state;
  }
}

export function registerIdeSections(loader) {
  loader.registerSection('objs', {
    parseLine: ({ state, tokens, line }) => {
      const definition = parseIdeObjectEntry(tokens, line, 'objs');
      if (!definition) return;
      state.byId.set(definition.id, definition);
      state.byModel.set(definition.modelName, definition);
    },
  });

  loader.registerSection('tobjs', {
    aliases: ['tobj'],
    parseLine: ({ state, tokens, line }) => {
      const definition = parseIdeObjectEntry(tokens, line, 'tobjs');
      if (!definition) return;
      state.byId.set(definition.id, definition);
      state.byModel.set(definition.modelName, definition);
    },
  });

  loader.registerSection('2dfx', {
    parseLine: ({ state, tokens, line }) => {
      const effect = parse2dfxEntry(tokens, line);
      if (!effect) return;
      if (!state.effectsById.has(effect.modelId)) {
        state.effectsById.set(effect.modelId, []);
      }
      const effectList = state.effectsById.get(effect.modelId);
      effectList.push({
        ...effect,
        effectIndex: effectList.length,
      });
    },
  });

  return loader;
}

export function createIdeSectionLoader() {
  return registerIdeSections(new SectionLoader());
}

export function parseIde(content) {
  const state = {
    byId: new Map(),
    byModel: new Map(),
    effectsById: new Map(),
  };

  createIdeSectionLoader().parse(content, state);
  attachEffectsToDefinitions(state.byId, state.effectsById);
  return state;
}

export function registerIplSections(loader) {
  loader.registerSection('inst', {
    parseLine: ({ loader: activeLoader, state, tokens, line }) => {
      if (tokens.length < 10) return;

      const id = Number.parseInt(tokens[0], 10);
      const modelName = String(tokens[1] || '').toLowerCase();
      const interior = Number.parseInt(tokens[2], 10);
      const px = Number.parseFloat(tokens[3]);
      const py = Number.parseFloat(tokens[4]);
      const pz = Number.parseFloat(tokens[5]);
      const transform = parseRotationAndLod(tokens, activeLoader.gameVersion);

      if (!transform) return;
      if (!Number.isFinite(id) || !modelName) return;
      if (![px, py, pz].every(Number.isFinite)) return;

      state.placements.push({
        id,
        modelName,
        interior: Number.isFinite(interior) ? interior : 0,
        position: { x: px, y: py, z: pz },
        rotation: transform.rotation,
        lod: transform.lod,
        raw: line,
      });
    },
  });

  return loader;
}

export function createIplSectionLoader(options = {}) {
  return registerIplSections(new SectionLoader(options));
}

export function parseIpl(content, options = {}) {
  const state = {
    placements: [],
  };
  createIplSectionLoader(options).parse(content, state);
  return state.placements;
}
