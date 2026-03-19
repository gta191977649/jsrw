const COMMENT_RE = /(#|;|\/\/).*$/g;

function cleanLine(line) {
  return line.replace(COMMENT_RE, '').trim();
}

export function normalizePath(input) {
  return input.trim().replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function parseCsvLine(line) {
  return line
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseIde(content) {
  const byId = new Map();
  const byModel = new Map();

  let section = '';

  for (const raw of content.split(/\r?\n/)) {
    const line = cleanLine(raw);
    if (!line) continue;

    const lower = line.toLowerCase();
    if (lower === 'objs' || lower === 'tobj' || lower === 'tobjs') {
      section = lower === 'tobj' ? 'tobjs' : lower;
      continue;
    }

    if (lower === 'end') {
      section = '';
      continue;
    }

    if (section !== 'objs' && section !== 'tobjs') continue;

    const tokens = parseCsvLine(line);
    if (tokens.length < 3) continue;

    const id = Number.parseInt(tokens[0], 10);
    const modelName = tokens[1].toLowerCase();
    const txdName = tokens[2].toLowerCase();

    if (!Number.isFinite(id) || !modelName || !txdName) continue;

    const countToken = Number.parseInt(tokens[3], 10);
    const drawCount = Number.isFinite(countToken) && countToken > 0 ? countToken : 1;
    const drawValues = [];
    for (let i = 0; i < drawCount; i += 1) {
      const drawToken = tokens[4 + i];
      const drawValue = Number.parseFloat(drawToken);
      if (Number.isFinite(drawValue)) drawValues.push(drawValue);
    }
    const drawDistance = drawValues.length > 0 ? Math.max(...drawValues) : null;

    const parsedFlags = Number.parseInt(tokens[tokens.length - 1], 10);
    const flags = Number.isFinite(parsedFlags) ? parsedFlags : 0;

    const value = {
      id,
      modelName,
      txdName,
      drawDistance,
      flags,
      section,
      raw: line,
    };

    byId.set(id, value);
    byModel.set(modelName, value);
  }

  return { byId, byModel };
}

function parseRotationAndLod(tokens, gameVersion) {
  const version = gameVersion.toUpperCase();
  const isQuaternionLike = (x, y, z, w) => {
    if (![x, y, z, w].every(Number.isFinite)) return false;
    // Typical GTA IPL quaternion component range is [-1, 1].
    // Keep a small tolerance for noisy exports.
    if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z), Math.abs(w)) > 1.2) return false;
    const normSq = (x * x) + (y * y) + (z * z) + (w * w);
    // Allow denormalized values; final normalization is done at runtime.
    return normSq > 0.2 && normSq < 1.8;
  };

  // SA layout:
  // [id, model, interior, px, py, pz, rx, ry, rz, rw, lod]
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

  // VCS exported layout (common):
  // [id, model, interior, px, py, pz, sx, sy, sz, rx, ry, rz, rw, lod?]
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

  // Keep selected game version as primary, but gracefully fallback per line
  // if a record clearly does not match the expected quaternion pattern.
  if (version === 'SA') return trySa() ?? tryVcs();
  if (version === 'VCS') return tryVcs() ?? trySa();
  return tryVcs() ?? trySa();
}

export function parseIpl(content, options = {}) {
  const gameVersion = (options.gameVersion || 'VCS').toUpperCase();
  const placements = [];
  let section = '';

  for (const raw of content.split(/\r?\n/)) {
    const line = cleanLine(raw);
    if (!line) continue;

    const lower = line.toLowerCase();
    if (lower === 'inst') {
      section = lower;
      continue;
    }

    if (lower === 'end') {
      section = '';
      continue;
    }

    if (section !== 'inst') continue;

    const tokens = parseCsvLine(line);
    if (tokens.length < 10) continue;

    const id = Number.parseInt(tokens[0], 10);
    const modelName = tokens[1].toLowerCase();
    const interior = Number.parseInt(tokens[2], 10);

    const px = Number.parseFloat(tokens[3]);
    const py = Number.parseFloat(tokens[4]);
    const pz = Number.parseFloat(tokens[5]);

    const transform = parseRotationAndLod(tokens, gameVersion);
    if (!transform) continue;

    if (!Number.isFinite(id) || !modelName) continue;
    if (![px, py, pz].every(Number.isFinite)) continue;

    placements.push({
      id,
      modelName,
      interior: Number.isFinite(interior) ? interior : 0,
      position: { x: px, y: py, z: pz },
      rotation: transform.rotation,
      lod: transform.lod,
      raw: line,
    });
  }

  return placements;
}
