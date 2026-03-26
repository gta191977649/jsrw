export function createEntityRenderSide(options = {}) {
  const {
    object3D = null,
    handles = [],
    drawDistance = null,
    isTobj = false,
    objectDetail = null,
    placementMatrix = null,
    ideFlags = 0,
    template = null,
  } = options;
  const firstHandle = Array.isArray(handles) && handles.length > 0 ? handles[0] : null;
  const resolvedPlacementMatrix = placementMatrix || object3D?.userData?.placementMatrix || firstHandle?.placementMatrix || null;

  return {
    hasRenderable: Boolean(object3D || firstHandle),
    streamAlpha: 0,
    fadeAlpha: 0,
    currentOpacity: 0,
    renderObject: object3D || null,
    handles: Array.isArray(handles) ? handles : [],
    fadeBindings: null,
    proxyRoot: null,
    template: template || object3D?.userData?.fadeTemplate || firstHandle?.selectionTemplate || null,
    placementMatrix: resolvedPlacementMatrix?.clone?.() || null,
    ideFlags: object3D?.userData?.rwIdeFlags ?? firstHandle?.ideFlags ?? ideFlags,
    isTobj: Boolean(object3D?.userData?.isTobj ?? firstHandle?.isTobj ?? isTobj),
    objectDetail: object3D?.userData?.objectDetail || firstHandle?.objectDetail || objectDetail || null,
    drawDistance: Number.isFinite(drawDistance) ? drawDistance : null,
  };
}

export class CEntity {
  constructor(options = {}) {
    this.kind = 'CEntity';
    this.isTobj = Boolean(options.isTobj);
    this.anchor = options.anchor || null;
    this.mode = options.mode || 'hidden';
    this.chunkKey = options.chunkKey || null;
    this.isBigBuilding = options.isBigBuilding === true;
    this.boundsMin = options.boundsMin || null;
    this.boundsMax = options.boundsMax || null;
    this.boundingBox = options.boundingBox || null;
    this.boundingSphere = options.boundingSphere || null;

    this.sides = {
      near: options.nearState || createEntityRenderSide(),
      lod: options.lodState || createEntityRenderSide(),
    };
    this.renderStrategy = options.renderStrategy
      || (
        ((this.sides.near.handles?.length || 0) > 0 || (this.sides.lod.handles?.length || 0) > 0)
          ? 'split'
          : 'single'
      );
    this.activeSide = this.hasRenderable('near') ? 'near' : (this.hasRenderable('lod') ? 'lod' : null);
    this.transition = null;

    // Legacy compatibility for the rest of the codebase while the renderer
    // moves over to entity-driven accessors.
    this.nearState = this.sides.near;
    this.lodState = this.sides.lod;
    this.nearObj = this.sides.near.renderObject;
    this.lodObj = this.sides.lod.renderObject;
    this.nearHandles = this.sides.near.handles;
    this.lodHandles = this.sides.lod.handles;
    this.nearDrawDistance = this.sides.near.drawDistance;
    this.lodDrawDistance = this.sides.lod.drawDistance;
  }

  getRenderSideState(side) {
    return this.sides[side] || null;
  }

  getRenderObject(side) {
    return this.getRenderSideState(side)?.renderObject || null;
  }

  getRenderHandles(side) {
    return this.getRenderSideState(side)?.handles || [];
  }

  getDrawDistance(side) {
    return this.getRenderSideState(side)?.drawDistance ?? null;
  }

  hasRenderable(side) {
    const state = this.getRenderSideState(side);
    return Boolean(state?.hasRenderable)
      || Boolean(state?.renderObject)
      || (Array.isArray(state?.handles) && state.handles.length > 0);
  }

  usesSingleRwPath() {
    return this.renderStrategy === 'single';
  }

  getActiveSide() {
    return this.activeSide;
  }

  setActiveSide(side) {
    this.activeSide = side === 'lod' ? 'lod' : (side === 'near' ? 'near' : null);
  }

  getTransition() {
    return this.transition;
  }

  setTransition(transition) {
    this.transition = transition || null;
  }

  setSideOpacity(side, opacity) {
    const state = this.getRenderSideState(side);
    if (!state) return;
    state.currentOpacity = opacity;
  }

  getSideOpacity(side) {
    return this.getRenderSideState(side)?.currentOpacity ?? 0;
  }

  setMode(mode) {
    this.mode = mode;
  }
}

export function createCEntity(options = {}) {
  return new CEntity(options);
}

export default CEntity;
