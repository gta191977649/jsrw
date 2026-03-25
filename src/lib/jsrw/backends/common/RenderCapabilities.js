export function createRenderCapabilities(overrides = {}) {
  return Object.freeze({
    supportsPatchedMaterials: false,
    supportsNodeMaterials: false,
    supportsRenderTargets: false,
    supportsHistoryBuffers: false,
    supportsReadback: false,
    supportsPostFxHistory: false,
    supportsDebugTargets: false,
    supportsCustomBlendConstants: false,
    supportsHalfFloatTargets: false,
    ...overrides,
  });
}
