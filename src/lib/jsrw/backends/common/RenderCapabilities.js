export function createRenderCapabilities(overrides = {}) {
  return Object.freeze({
    supportsPatchedMaterials: false,
    supportsReadback: false,
    supportsPostFxHistory: false,
    supportsDebugTargets: false,
    supportsCustomBlendConstants: false,
    supportsHalfFloatTargets: false,
    ...overrides,
  });
}
