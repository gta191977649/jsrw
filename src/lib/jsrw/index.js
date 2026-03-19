export { DFFLoader } from './DFFLoader.js';
export { TXDLoader } from './TXDLoader.js';

export { DffParser } from './formats/dff/DffParser.js';
export { TxdParser } from './formats/txd/TxdParser.js';

export {
  RW_ALPHA_REF_DEFAULT,
  cloneRwMaterialDescriptor as cloneRWMaterialDescriptor,
  cloneRwMaterialDescriptor,
} from './core/material/RwMaterialDescriptor.js';

export {
  RW_PIPELINE_CATEGORY,
  RW_PIPELINE_GAME,
  RW_PIPELINE_PLATFORM,
  RW_PIPELINE_SELECTION_DEFAULT,
  RW_PIPELINE_SELECTION_DEFAULTS,
} from './core/pipeline/constants.js';

export {
  cloneRWPipelineSelection,
  cloneRWPipelineSelections,
  getRWPipelineCategoryOptions,
  getRWPipelineGameOptions,
  getRWPipelinePlatformOptions,
  resolveRWPipelineSelection,
  resolveRWPipelineSelections,
} from './core/pipeline/selection.js';

export { RWPipelineRegistry } from './core/pipeline/registry.js';
export { RWPipelineController } from './core/pipeline/controller.js';

export {
  applyDisableVertexColor,
  buildRWMaterialDescriptor,
  createRWMaterial,
  createThreeMaterialFromRW,
  getRWMaterialDescriptor,
  normalizeTextureDictionary,
  prepareTobjInstanceMaterials,
  setRWMaterialDescriptor,
  syncThreeMaterialFromRW,
  toRWMaterial,
  tuneTransparentMaterial,
} from './adapters/three/ThreeMaterialAdapter.js';
export {
  RW_IDE_FLAG,
  applyRwIdeFlagsToInstance,
  decodeRwIdeFlags,
  hasRwIdeFlag,
} from './adapters/three/RwIdeFlagsAdapter.js';

export { ThreeTextureFactory } from './adapters/three/ThreeTextureFactory.js';
export { ThreeDffFactory } from './adapters/three/ThreeDffFactory.js';

export { RenderBackend } from './backends/common/RenderBackend.js';
export { createRenderCapabilities } from './backends/common/RenderCapabilities.js';
export { WebGLRenderBackend } from './backends/webgl/WebGLRenderBackend.js';
export { WebGPURenderBackend } from './backends/webgpu/WebGPURenderBackend.js';

export {
  createBasicMaterialFromDescriptor,
  createDefaultRWPipelineRegistry,
  createRWPipelineMaterialForProfile,
  getDefaultRWPipelineRegistry,
} from './renderer/world/createDefaultPipelineRegistry.js';
export * from './renderer/world/sky/index.js';
export { PostFxRuntime } from './renderer/postfx/PostFxRuntime.js';
export { RWPostFxPipeline } from './renderer/postfx/RWPostFxPipeline.js';
export { CoronaRuntime } from './renderer/corona/CoronaRuntime.js';
export { RWCoronaPipeline } from './renderer/corona/RWCoronaPipeline.js';
export {
  buildTrafficLightCoronaEmitters,
  isTrafficLightModelName,
  resolveTrafficLightPhase,
} from './renderer/corona/TrafficLights.js';
export { WaterRuntime } from './renderer/water/WaterRuntime.js';
export { RWWaterPipeline } from './renderer/water/RWWaterPipeline.js';

export { JsrwRendererSession } from './integration/JsrwRendererSession.js';
export { createJsrwRenderer } from './integration/createJsrwRenderer.js';
export { RWRenderQueue } from './integration/three/RWRenderQueue.js';
