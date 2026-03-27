import * as THREE from 'three';

const CAM_MAGIC = 'MAC\0';
const CAM_HEADER_SIZE = 0x30;
const CAM_BLOCK_COUNT = 4;
const SECTION_NAMES = Object.freeze([
  'fov',
  'roll',
  'cameraPosition',
  'cameraTarget',
]);

function readFloat32(view, offset) {
  return view.getFloat32(offset, true);
}

function readUint32(view, offset) {
  return view.getUint32(offset, true);
}

function readAscii(bytes, offset, length) {
  return new TextDecoder('ascii').decode(bytes.subarray(offset, offset + length));
}

function toScalarKey(time, lane1, lane2, lane3) {
  return {
    time,
    lanes: [lane1, lane2, lane3],
    value: lane1,
  };
}

function toVec3Key(time, lane1, lane2, lane3) {
  return {
    time,
    lane1: lane1.clone(),
    lane2: lane2.clone(),
    lane3: lane3.clone(),
    value: lane1.clone(),
  };
}

function parseScalarBlock(view, offset, nextOffset) {
  const count = Math.max(0, Math.round(readFloat32(view, offset)));
  let position = offset + 4;
  const keys = [];
  for (let index = 0; index < count; index += 1) {
    if ((position + 16) > view.byteLength) {
      throw new Error(`Scalar block overflow at 0x${position.toString(16)}`);
    }
    keys.push(toScalarKey(
      readFloat32(view, position + 0),
      readFloat32(view, position + 4),
      readFloat32(view, position + 8),
      readFloat32(view, position + 12),
    ));
    position += 16;
  }
  if ((position + 4) > view.byteLength) {
    throw new Error(`Scalar block terminator overflow at 0x${position.toString(16)}`);
  }
  const terminator = readFloat32(view, position);
  position += 4;
  return {
    kind: 'scalar',
    count,
    offset,
    nextOffset,
    endOffset: position,
    terminator,
    keys,
  };
}

function parseVec3Block(view, offset, nextOffset) {
  const count = Math.max(0, Math.round(readFloat32(view, offset)));
  let position = offset + 4;
  const keys = [];
  for (let index = 0; index < count; index += 1) {
    if ((position + 40) > view.byteLength) {
      throw new Error(`Vec3 block overflow at 0x${position.toString(16)}`);
    }
    const lane1 = new THREE.Vector3(
      readFloat32(view, position + 4),
      readFloat32(view, position + 8),
      readFloat32(view, position + 12),
    );
    const lane2 = new THREE.Vector3(
      readFloat32(view, position + 16),
      readFloat32(view, position + 20),
      readFloat32(view, position + 24),
    );
    const lane3 = new THREE.Vector3(
      readFloat32(view, position + 28),
      readFloat32(view, position + 32),
      readFloat32(view, position + 36),
    );
    keys.push(toVec3Key(
      readFloat32(view, position + 0),
      lane1,
      lane2,
      lane3,
    ));
    position += 40;
  }
  if ((position + 4) > view.byteLength) {
    throw new Error(`Vec3 block terminator overflow at 0x${position.toString(16)}`);
  }
  const terminator = readFloat32(view, position);
  position += 4;
  return {
    kind: 'vec3',
    count,
    offset,
    nextOffset,
    endOffset: position,
    terminator,
    keys,
  };
}

export function parseVcsCamFile(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    throw new Error('VCS cutscene CAM parser expects an ArrayBuffer');
  }
  if (arrayBuffer.byteLength < CAM_HEADER_SIZE) {
    throw new Error(`CAM file too small: ${arrayBuffer.byteLength} bytes`);
  }

  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const magic = readAscii(bytes, 0, 4);
  if (magic !== CAM_MAGIC) {
    throw new Error(`Invalid CAM magic: ${JSON.stringify(magic)}`);
  }

  const logicalSize = readUint32(view, 0x08);
  const logicalEnd = readUint32(view, 0x0C);
  const logicalEndDuplicate = readUint32(view, 0x10);
  const relocCount = readUint32(view, 0x14);
  const sectionOffsets = Array.from({ length: CAM_BLOCK_COUNT }, (_, index) => readUint32(view, 0x20 + (index * 4)));

  if (sectionOffsets.some((offset) => !Number.isFinite(offset) || offset < CAM_HEADER_SIZE || offset >= arrayBuffer.byteLength)) {
    throw new Error('CAM block offsets are invalid');
  }
  if (logicalEnd > arrayBuffer.byteLength || logicalSize > arrayBuffer.byteLength) {
    throw new Error('CAM logical bounds exceed physical file size');
  }

  const sections = [];
  for (let index = 0; index < CAM_BLOCK_COUNT; index += 1) {
    const offset = sectionOffsets[index];
    const nextOffset = index + 1 < CAM_BLOCK_COUNT ? sectionOffsets[index + 1] : logicalEnd;
    if (nextOffset <= offset) {
      throw new Error(`CAM block order is invalid at section ${index}`);
    }
    const parsed = index < 2
      ? parseScalarBlock(view, offset, nextOffset)
      : parseVec3Block(view, offset, nextOffset);
    parsed.name = SECTION_NAMES[index];
    sections.push(parsed);
  }

  const relocEntries = [];
  const relocStart = logicalEnd;
  for (let index = 0; index < relocCount; index += 1) {
    const entryOffset = relocStart + (index * 4);
    if ((entryOffset + 4) > arrayBuffer.byteLength) break;
    relocEntries.push(readUint32(view, entryOffset));
  }

  const durationSeconds = Math.max(
    0,
    ...sections.map((section) => Number(section.keys.at(-1)?.time) || 0),
  );

  return {
    magic: magic.slice(0, 3),
    physicalSize: arrayBuffer.byteLength,
    logicalSize,
    logicalEnd,
    logicalEndDuplicate,
    relocCount,
    relocEntries,
    sectionOffsets,
    sections,
    tracks: {
      fov: sections[0].keys,
      roll: sections[1].keys,
      cameraPosition: sections[2].keys,
      cameraTarget: sections[3].keys,
    },
    durationSeconds,
    durationMs: Math.max(0, Math.round(durationSeconds * 1000)),
  };
}

export function parseVcsCutText(text) {
  const raw = String(text || '').replaceAll('\0', '');
  const firstSectionIndex = raw.search(/(?:info|model|text|uncompress|motion)\r?\n/i);
  const parseText = firstSectionIndex >= 0 ? raw.slice(firstSectionIndex) : raw;
  const lines = parseText.split(/\r?\n/);
  const metadata = {
    rawText: parseText,
    offset: new THREE.Vector3(0, 0, 0),
    hasOffset: false,
    subtitles: [],
    models: [],
    motionEntries: [],
    motionRangeFrames: null,
    motionRangeSeconds: null,
    motionQuick: false,
    motionYUp: false,
  };

  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^(info|model|text|uncompress|motion)$/i.test(trimmed)) {
      currentSection = trimmed.toLowerCase();
      continue;
    }
    if (/^end$/i.test(trimmed)) {
      currentSection = '';
      continue;
    }

    if (currentSection === 'info') {
      const match = trimmed.match(/^offset\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/i);
      if (!match) continue;
      metadata.offset.set(
        Number.parseFloat(match[1]),
        Number.parseFloat(match[2]),
        Number.parseFloat(match[3]),
      );
      metadata.hasOffset = metadata.offset.toArray().every((value) => Number.isFinite(value));
      if (!metadata.hasOffset) {
        metadata.offset.set(0, 0, 0);
      }
      continue;
    }

    if (currentSection === 'text') {
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+\{\s*(.*?)\s*\}$/u);
      if (!match) continue;
      const startMs = Number.parseInt(match[1], 10);
      const endMs = Number.parseInt(match[2], 10);
      const label = match[3];
      const rawSubtitle = match[4];
      const speakerMatch = rawSubtitle.match(/^:([^\]]+)\](.*)$/u);
      const speaker = speakerMatch ? speakerMatch[1] : '';
      const subtitleText = String(speakerMatch ? speakerMatch[2] : rawSubtitle).trim();
      metadata.subtitles.push({
        id: `${label}:${startMs}:${endMs}`,
        startMs,
        endMs,
        label,
        speaker,
        rawText: rawSubtitle,
        text: subtitleText,
      });
      continue;
    }

    if (currentSection === 'model') {
      const parts = trimmed.split(',').map((value) => String(value || '').trim()).filter(Boolean);
      if (parts.length < 3) continue;
      metadata.models.push({
        slot: Number.parseInt(parts[0], 10) || 0,
        modelName: parts[1],
        animName: parts[2],
        rawLine: trimmed,
      });
      continue;
    }

    if (currentSection === 'motion') {
      const rangeMatch = trimmed.match(/^range\s+on\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/i);
      if (rangeMatch) {
        const startFrame = Number.parseFloat(rangeMatch[1]);
        const endFrame = Number.parseFloat(rangeMatch[2]);
        if (Number.isFinite(startFrame) && Number.isFinite(endFrame)) {
          metadata.motionRangeFrames = {
            start: startFrame,
            end: endFrame,
          };
          metadata.motionRangeSeconds = {
            start: startFrame / 60,
            end: endFrame / 60,
          };
        }
        continue;
      }
      if (/^quick\s+on$/i.test(trimmed)) {
        metadata.motionQuick = true;
        continue;
      }
      if (/^yup\s+on$/i.test(trimmed)) {
        metadata.motionYUp = true;
        continue;
      }
      const actorMotionMatch = trimmed.match(/^([^:]+):([^,]+),([01])$/i);
      if (actorMotionMatch) {
        metadata.motionEntries.push({
          rawLine: trimmed,
          actorName: actorMotionMatch[1].trim(),
          targetName: actorMotionMatch[2].trim(),
          enabled: actorMotionMatch[3] === '1',
          parts: [
            actorMotionMatch[1].trim(),
            actorMotionMatch[2].trim(),
            actorMotionMatch[3].trim(),
          ],
        });
        continue;
      }
      const parts = trimmed.split(',').map((value) => String(value || '').trim()).filter(Boolean);
      metadata.motionEntries.push({
        rawLine: trimmed,
        parts,
      });
    }
  }

  return metadata;
}

export function parseVcsCutsceneDefinition(input = {}) {
  const cam = parseVcsCamFile(input.camBuffer);
  const cut = parseVcsCutText(input.cutText || '');
  const ifpName = String(input.ifpRecord?.basename || input.ifpRecord?.normalizedPath || input.name || '')
    .replace(/\.[^.]+$/u, '')
    .trim();
  return {
    name: String(input.name || '').trim(),
    durationMs: cam.durationMs,
    durationSeconds: cam.durationSeconds,
    tracks: cam.tracks,
    offset: cut.offset.clone(),
    models: cut.models.map((entry) => ({ ...entry })),
    motionEntries: cut.motionEntries.map((entry) => ({ ...entry, parts: [...entry.parts] })),
    motionRangeFrames: cut.motionRangeFrames ? { ...cut.motionRangeFrames } : null,
    motionRangeSeconds: cut.motionRangeSeconds ? { ...cut.motionRangeSeconds } : null,
    motionQuick: cut.motionQuick,
    motionYUp: cut.motionYUp,
    ifpName,
    assetWarnings: [],
    metadata: {
      cutsceneName: String(input.name || '').trim(),
      hasCutFile: Boolean(input.cutText),
      hasIfpFile: Boolean(input.ifpRecord),
      cutRawText: cut.rawText,
      subtitles: cut.subtitles,
      models: cut.models.map((entry) => ({ ...entry })),
      motionEntries: cut.motionEntries.map((entry) => ({ ...entry, parts: [...entry.parts] })),
      motionRangeFrames: cut.motionRangeFrames ? { ...cut.motionRangeFrames } : null,
      motionRangeSeconds: cut.motionRangeSeconds ? { ...cut.motionRangeSeconds } : null,
      motionQuick: cut.motionQuick,
      motionYUp: cut.motionYUp,
      camMeta: {
        magic: cam.magic,
        physicalSize: cam.physicalSize,
        logicalSize: cam.logicalSize,
        logicalEnd: cam.logicalEnd,
        relocEntries: [...cam.relocEntries],
        sectionOffsets: [...cam.sectionOffsets],
      },
    },
    source: {
      camPath: String(input.camRecord?.resolvedPath || input.camRecord?.path || ''),
      cutPath: String(input.cutRecord?.resolvedPath || input.cutRecord?.path || ''),
      ifpPath: String(input.ifpRecord?.resolvedPath || input.ifpRecord?.path || ''),
    },
  };
}
