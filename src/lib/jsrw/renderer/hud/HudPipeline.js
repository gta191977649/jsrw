import * as THREE from 'three';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import { Font } from 'three/examples/jsm/loaders/FontLoader.js';
import { TTFLoader } from 'three/examples/jsm/loaders/TTFLoader.js';

const SUBTITLE_PASS_SCALE = 0.5;
const CUTSCENE_BORDER_PERCENT = 0.30;

function createSubtitleMaterial(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function measureTextWidth(font, text, size) {
  const geometry = new TextGeometry(text || ' ', {
    font,
    size,
    depth: 0,
    curveSegments: 3,
    bevelEnabled: false,
  });
  geometry.computeBoundingBox();
  const width = geometry.boundingBox
    ? geometry.boundingBox.max.x - geometry.boundingBox.min.x
    : 0;
  geometry.dispose();
  return width;
}

function wrapSubtitleText(font, text, size, maxWidth) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [''];
  const lines = [];
  let currentLine = tokens[0];
  for (let index = 1; index < tokens.length; index += 1) {
    const nextCandidate = `${currentLine} ${tokens[index]}`;
    if (measureTextWidth(font, nextCandidate, size) <= maxWidth) {
      currentLine = nextCandidate;
    } else {
      lines.push(currentLine);
      currentLine = tokens[index];
    }
  }
  lines.push(currentLine);
  return lines;
}

function snap(value) {
  return Math.round(Number(value) || 0);
}

export class HudPipeline {
  constructor(options = {}) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.camera.position.set(0, 0, 10);
    this.subtitleScene = new THREE.Scene();
    this.subtitleCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.subtitleCamera.position.set(0, 0, 10);
    this.viewport = { width: 1, height: 1 };
    this.gameVersion = 'VCS';
    this.showGameIcon = false;
    this.cutscenePresentation = false;
    this.subtitleCue = null;
    this.font = null;
    this.renderKey = '';
    this.disposed = false;
    this.subtitleRenderTarget = null;

    this.subtitleGroup = new THREE.Group();
    this.subtitleGroup.visible = false;
    this.subtitleScene.add(this.subtitleGroup);
    this.subtitleMeshes = [];
    this.subtitleMaterials = {
      outline: createSubtitleMaterial(0x090909, 1),
      shadow: createSubtitleMaterial(0x000000, 0.78),
      fill: createSubtitleMaterial(0xf2f2f0, 1),
    };
    this.subtitleCompositeMaterial = new THREE.SpriteMaterial({
      map: null,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.subtitleCompositeSprite = new THREE.Sprite(this.subtitleCompositeMaterial);
    this.subtitleCompositeSprite.center.set(0.5, 0.5);
    this.subtitleCompositeSprite.renderOrder = 9998;
    this.scene.add(this.subtitleCompositeSprite);

    this.cutsceneBorderMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.cutsceneBorderGeometry = new THREE.PlaneGeometry(1, 1);
    this.cutsceneTopBorder = new THREE.Mesh(this.cutsceneBorderGeometry, this.cutsceneBorderMaterial);
    this.cutsceneBottomBorder = new THREE.Mesh(this.cutsceneBorderGeometry, this.cutsceneBorderMaterial);
    this.cutsceneTopBorder.renderOrder = 9996;
    this.cutsceneBottomBorder.renderOrder = 9996;
    this.cutsceneTopBorder.visible = false;
    this.cutsceneBottomBorder.visible = false;
    this.scene.add(this.cutsceneTopBorder);
    this.scene.add(this.cutsceneBottomBorder);

    this.iconTextures = options.iconTextures || {};
    this.iconMaterial = new THREE.SpriteMaterial({
      map: this.iconTextures.VCS || null,
      transparent: true,
      alphaTest: 0.01,
      depthTest: false,
      depthWrite: false,
    });
    this.gameIconSprite = new THREE.Sprite(this.iconMaterial);
    this.gameIconSprite.center.set(1, 1);
    this.gameIconSprite.visible = false;
    this.gameIconSprite.renderOrder = 9999;
    this.scene.add(this.gameIconSprite);

    const fontUrl = options.fontUrl || '';
    if (fontUrl) {
      new TTFLoader().load(
        fontUrl,
        (json) => {
          if (this.disposed) return;
          this.font = new Font(json);
          this.rebuildSubtitleMeshes();
        },
        undefined,
        () => {},
      );
    }
  }

  setViewport(width, height) {
    this.viewport.width = Math.max(1, Math.floor(width) || 1);
    this.viewport.height = Math.max(1, Math.floor(height) || 1);
    this.camera.left = -this.viewport.width * 0.5;
    this.camera.right = this.viewport.width * 0.5;
    this.camera.top = this.viewport.height * 0.5;
    this.camera.bottom = -this.viewport.height * 0.5;
    this.camera.updateProjectionMatrix();
    this.subtitleCamera.left = this.camera.left;
    this.subtitleCamera.right = this.camera.right;
    this.subtitleCamera.top = this.camera.top;
    this.subtitleCamera.bottom = this.camera.bottom;
    this.subtitleCamera.updateProjectionMatrix();
    this.ensureSubtitleRenderTarget();
    this.subtitleCompositeSprite.position.set(0, 0, 0);
    this.subtitleCompositeSprite.scale.set(this.viewport.width, this.viewport.height, 1);
    this.updateCutsceneBorders();
    this.rebuildSubtitleMeshes();
  }

  setIconTextures(iconTextures = {}) {
    this.iconTextures = iconTextures;
    this.updateGameIcon();
  }

  setGameVersion(gameVersion) {
    this.gameVersion = String(gameVersion || 'VCS').toUpperCase() === 'SA' ? 'SA' : 'VCS';
    this.updateGameIcon();
  }

  setShowGameIcon(showGameIcon) {
    this.showGameIcon = Boolean(showGameIcon);
    this.updateGameIcon();
  }

  setSubtitleCue(cue) {
    const nextCue = cue
      ? {
        id: cue.id,
        text: cue.text,
        speaker: cue.speaker || '',
      }
      : null;
    if (
      this.subtitleCue?.id === nextCue?.id
      && this.subtitleCue?.text === nextCue?.text
      && this.subtitleCue?.speaker === nextCue?.speaker
    ) {
      return;
    }
    this.subtitleCue = nextCue;
    this.rebuildSubtitleMeshes();
  }

  setCutscenePresentation(enabled) {
    const nextValue = Boolean(enabled);
    if (this.cutscenePresentation === nextValue) return;
    this.cutscenePresentation = nextValue;
    this.updateCutsceneBorders();
    this.rebuildSubtitleMeshes();
  }

  getCutsceneBorderHeight() {
    return this.cutscenePresentation
      ? (this.viewport.height * 0.5) * CUTSCENE_BORDER_PERCENT
      : 0;
  }

  updateCutsceneBorders() {
    const borderHeight = this.getCutsceneBorderHeight();
    const visible = borderHeight > 0.5;
    this.cutsceneTopBorder.visible = visible;
    this.cutsceneBottomBorder.visible = visible;
    if (!visible) return;
    this.cutsceneTopBorder.position.set(0, (this.viewport.height * 0.5) - (borderHeight * 0.5), 0);
    this.cutsceneBottomBorder.position.set(0, (-this.viewport.height * 0.5) + (borderHeight * 0.5), 0);
    this.cutsceneTopBorder.scale.set(this.viewport.width, borderHeight, 1);
    this.cutsceneBottomBorder.scale.set(this.viewport.width, borderHeight, 1);
  }

  updateGameIcon() {
    const activeIcon = this.gameVersion === 'SA' ? 'SA' : 'VCS';
    this.gameIconSprite.material.map = this.iconTextures[activeIcon] || null;
    this.gameIconSprite.visible = this.showGameIcon;
    const iconPx = 80;
    const padXPx = 20;
    const padYPx = 56;
    this.gameIconSprite.position.set(
      (this.viewport.width * 0.5) - padXPx,
      (this.viewport.height * 0.5) - padYPx,
      0,
    );
    this.gameIconSprite.scale.set(iconPx, iconPx, 1);
  }

  ensureSubtitleRenderTarget() {
    const width = Math.max(1, Math.floor(this.viewport.width * SUBTITLE_PASS_SCALE));
    const height = Math.max(1, Math.floor(this.viewport.height * SUBTITLE_PASS_SCALE));
    if (
      this.subtitleRenderTarget
      && this.subtitleRenderTarget.width === width
      && this.subtitleRenderTarget.height === height
    ) {
      return;
    }
    this.subtitleRenderTarget?.dispose?.();
    this.subtitleRenderTarget = new THREE.RenderTarget(width, height, {
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.subtitleRenderTarget.texture.minFilter = THREE.LinearFilter;
    this.subtitleRenderTarget.texture.magFilter = THREE.LinearFilter;
    this.subtitleRenderTarget.texture.generateMipmaps = false;
    this.subtitleCompositeMaterial.map = this.subtitleRenderTarget.texture;
    this.subtitleCompositeMaterial.needsUpdate = true;
  }

  disposeSubtitleMeshes() {
    for (const entry of this.subtitleMeshes) {
      entry?.geometry?.dispose?.();
    }
    this.subtitleMeshes = [];
    this.subtitleGroup.clear();
    this.subtitleGroup.visible = false;
    this.renderKey = '';
  }

  rebuildSubtitleMeshes() {
    const renderKey = JSON.stringify({
      id: this.subtitleCue?.id || '',
      width: this.viewport.width,
      height: this.viewport.height,
      cutscenePresentation: this.cutscenePresentation,
    });
    if (renderKey === this.renderKey) return;
    this.disposeSubtitleMeshes();
    if (!this.font || !this.subtitleCue?.text) return;

    const aspectRatio = this.viewport.width / Math.max(1, this.viewport.height);
    const widthScale = aspectRatio >= 1 ? 0.88 : 0.82;
    const maxWidth = Math.max(320, Math.min(this.viewport.width * widthScale, 1280));
    const fontSize = snap(Math.max(26, Math.min(42, this.viewport.width * 0.034)));
    const lineHeight = snap(fontSize * 1.16);
    const speakerSize = snap(Math.max(13, Math.min(18, fontSize * 0.5)));
    const outlineOffsets = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].map(([x, y]) => ({
      x: snap(x * Math.max(1, fontSize * 0.045)),
      y: snap(y * Math.max(1, fontSize * 0.045)),
    }));
    const shadowOffsets = [
      [1, -1],
      [2, -1],
      [1, -2],
      [2, -2],
    ].map(([x, y]) => ({
      x: snap(x * Math.max(2, fontSize * 0.085)),
      y: snap(y * Math.max(2, fontSize * 0.085)),
    }));
    const lines = wrapSubtitleText(this.font, this.subtitleCue.text, fontSize, maxWidth);
    const totalTextHeight = lines.length * lineHeight;
    const hasSpeaker = Boolean(this.subtitleCue.speaker);
    const speakerGap = hasSpeaker
      ? snap((fontSize * 0.55) + (speakerSize * 0.85) + Math.max(6, fontSize * 0.12))
      : 0;
    const blockHeight = totalTextHeight + speakerGap;
    const cutsceneBottomSafeMargin = this.getCutsceneBorderHeight();
    const subtitleBottom = this.cutscenePresentation
      ? ((-this.viewport.height * 0.5) + cutsceneBottomSafeMargin + Math.max(42, fontSize * 1.2))
      : (-this.viewport.height * 0.33);
    let cursorY = snap(subtitleBottom + (blockHeight * 0.5));
    const fillMeshes = [];

    const buildLayeredLine = (text, size, y, material = this.subtitleMaterials.fill) => {
      const geometry = new TextGeometry(text || ' ', {
        font: this.font,
        size,
        depth: 0,
        curveSegments: 3,
        bevelEnabled: false,
      });
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox;
      const width = bounds ? bounds.max.x - bounds.min.x : 0;
      const height = bounds ? bounds.max.y - bounds.min.y : size;
      geometry.translate(-snap(width * 0.5), -snap(height * 0.5), 0);

      for (const offset of shadowOffsets) {
        const shadow = new THREE.Mesh(geometry.clone(), this.subtitleMaterials.shadow);
        shadow.position.set(offset.x, y + offset.y, -1);
        shadow.renderOrder = 9991;
        this.subtitleGroup.add(shadow);
        this.subtitleMeshes.push(shadow);
      }

      for (const offset of outlineOffsets) {
        const outline = new THREE.Mesh(geometry.clone(), this.subtitleMaterials.outline);
        outline.position.set(offset.x, y + offset.y, -0.5);
        outline.renderOrder = 9990;
        this.subtitleGroup.add(outline);
        this.subtitleMeshes.push(outline);
      }

      const fill = new THREE.Mesh(geometry, material);
      fill.position.set(0, y, 2);
      fill.renderOrder = 10000;
      fillMeshes.push(fill);
    };

    if (hasSpeaker) {
      buildLayeredLine(this.subtitleCue.speaker, speakerSize, cursorY);
      cursorY -= speakerGap;
    }
    for (let index = 0; index < lines.length; index += 1) {
      buildLayeredLine(lines[index], fontSize, snap(cursorY - (index * lineHeight)));
    }
    for (const fill of fillMeshes) {
      this.subtitleGroup.add(fill);
      this.subtitleMeshes.push(fill);
    }
    this.subtitleGroup.visible = true;
    this.renderKey = renderKey;
  }

  render(renderer) {
    if (!renderer) return;
    this.updateGameIcon();
    if (this.subtitleRenderTarget) {
      const previousAutoClear = renderer.autoClear;
      renderer.setRenderTarget(this.subtitleRenderTarget);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(this.subtitleScene, this.subtitleCamera);
      renderer.setRenderTarget(null);
      renderer.autoClear = previousAutoClear;
    }
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.disposeSubtitleMeshes();
    Object.values(this.subtitleMaterials).forEach((material) => material.dispose());
    this.subtitleCompositeMaterial.dispose();
    this.subtitleRenderTarget?.dispose?.();
    this.iconMaterial.dispose();
    this.cutsceneBorderMaterial.dispose();
    this.cutsceneBorderGeometry.dispose();
  }
}

export default HudPipeline;
