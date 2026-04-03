import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import IFPLoader from '../../IFPLoader.js';
import { DFFLoader } from '../../DFFLoader.js';
import { TXDLoader } from '../../TXDLoader.js';
import { normalizeTextureDictionary } from '../../adapters/three/ThreeMaterialAdapter.js';
import { inspectSkeletonHierarchy } from '../skeleton/SkeletonInspector.js';
import {
  createIfpAnimationClip,
  rootMotionToThreeOffset,
  sampleRootMotion,
} from '../ifp/IfpClipFactory.js';
import { gtaPositionToThree } from '../../utils/gtaTransforms.js';
import { CutsceneAttachmentRuntime } from './CutsceneAttachmentRuntime.js';

function createEmptyState() {
  return {
    ifpArchive: null,
    actors: [],
    warnings: [],
    hasWorldContext: false,
    timeMs: 0,
  };
}

function normalizeLookupName(value = '') {
  return String(value || '').trim().toLowerCase();
}

function cloneTemplate(template) {
  return SkeletonUtils.clone(template);
}

function stripExtension(value = '') {
  const normalized = String(value || '').trim().replaceAll('\\', '/').split('/').pop() || '';
  const index = normalized.lastIndexOf('.');
  return index >= 0 ? normalized.slice(0, index) : normalized;
}

function findActorMotionEntry(definition, actor) {
  const motionEntries = Array.isArray(definition?.motionEntries) ? definition.motionEntries : [];
  const actorName = normalizeLookupName(actor?.animName || actor?.modelName || '');
  if (!actorName) return null;
  return motionEntries.find((entry) => normalizeLookupName(entry?.actorName || '') === actorName) || null;
}

function mapCutsceneTimeToActorTime(definition, actor, timeSeconds) {
  const clipDuration = Number(actor?.clip?.duration) || Number(actor?.clipBundle?.clip?.duration) || 0;
  if (clipDuration > 0) return THREE.MathUtils.clamp(timeSeconds, 0, clipDuration);
  return Math.max(0, timeSeconds);
}

function findPackageAssetRecord(fileIndex, name, extension) {
  if (!fileIndex) return null;
  const baseName = stripExtension(name);
  if (!baseName) return null;
  return fileIndex.findByPathHint(`${baseName}.${extension}`) || fileIndex.findByBasename(`${baseName}.${extension}`);
}

function applyActorPose(actor, actorTimeSeconds = 0) {
  if (!actor?.root) return;
  actor.mixer?.setTime?.(Math.max(0, Number(actorTimeSeconds) || 0));
  const attachment = actor.attachmentRuntime?.get?.(actor.root) || null;
  actor.attachment = attachment;
  const rootMotion = actor.clipBundle?.rootMotion
    ? rootMotionToThreeOffset(sampleRootMotion(actor.clipBundle.rootMotion, actorTimeSeconds))
    : new THREE.Vector3(0, 0, 0);
  if (attachment) {
    actor.root.position.copy(rootMotion);
  } else {
    actor.root.position.copy(actor.baseOffset).add(rootMotion);
  }
  actor.root.updateMatrixWorld(true);
}

export class CutsceneActorRuntime {
  constructor(options = {}) {
    this.ifpLoader = options.ifpLoader || new IFPLoader();
    this.sceneRoot = options.sceneRoot || null;
    this.rendererSession = options.rendererSession || null;
    this.getWorldContext = typeof options.getWorldContext === 'function' ? options.getWorldContext : () => null;
    this.getActiveBackend = typeof options.getActiveBackend === 'function' ? options.getActiveBackend : () => 'WebGL';
    this.getWorldGameVersion = typeof options.getWorldGameVersion === 'function' ? options.getWorldGameVersion : () => 'VCS';
    this.getTimecycleCurrent = typeof options.getTimecycleCurrent === 'function' ? options.getTimecycleCurrent : () => null;
    this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
    this.root = new THREE.Group();
    this.root.name = 'CutsceneActorsRoot';
    this.root.visible = false;
    this.debugSkeletonsVisible = options.debugSkeletonsVisible ?? true;
    this.sceneRoot?.add?.(this.root);
    this.attachmentRuntime = new CutsceneAttachmentRuntime({ sceneRoot: this.root });
    this.packageTextureCache = new Map();
    this.packageModelCache = new Map();
    this.state = createEmptyState();
    this.definition = null;
  }

  setSceneRoot(sceneRoot) {
    if (this.sceneRoot?.remove && this.root.parent === this.sceneRoot) {
      this.sceneRoot.remove(this.root);
    }
    this.sceneRoot = sceneRoot || null;
    this.attachmentRuntime.setSceneRoot(this.root);
    this.sceneRoot?.add?.(this.root);
  }

  setRendererSession(rendererSession) {
    this.rendererSession = rendererSession || null;
  }

  setWorldContextGetter(getter) {
    this.getWorldContext = typeof getter === 'function' ? getter : () => null;
  }

  setLogger(logger) {
    this.onLog = typeof logger === 'function' ? logger : null;
  }

  setRuntimeContextGetters(options = {}) {
    if (typeof options.getActiveBackend === 'function') this.getActiveBackend = options.getActiveBackend;
    if (typeof options.getWorldGameVersion === 'function') this.getWorldGameVersion = options.getWorldGameVersion;
    if (typeof options.getTimecycleCurrent === 'function') this.getTimecycleCurrent = options.getTimecycleCurrent;
  }

  setVisible(visible) {
    this.root.visible = Boolean(visible);
    for (const actor of this.state.actors) {
      if (actor.skeletonHelper?.isSkeletonHelper) {
        actor.skeletonHelper.visible = this.debugSkeletonsVisible && this.root.visible;
      }
    }
  }

  setDebugSkeletonsVisible(visible) {
    this.debugSkeletonsVisible = Boolean(visible);
    for (const actor of this.state.actors) {
      if (actor.skeletonHelper?.isSkeletonHelper) {
        actor.skeletonHelper.visible = this.debugSkeletonsVisible && this.root.visible;
      }
    }
  }

  log(level, message) {
    this.onLog?.(level, message);
  }

  pushWarning(message) {
    const text = String(message || '').trim();
    if (!text) return;
    this.state.warnings.push(text);
    this.log('warn', text);
  }

  clear() {
    const wasVisible = this.root.visible;
    this.attachmentRuntime.clear();
    for (const actor of this.state.actors) {
      actor.action?.stop?.();
      actor.mixer?.stopAllAction?.();
      actor.skeletonHelper?.parent?.remove?.(actor.skeletonHelper);
      actor.root?.parent?.remove?.(actor.root);
      this.rendererSession?.getRenderQueue?.()?.markDirty?.();
    }
    this.root.clear();
    this.root.visible = wasVisible;
    this.packageTextureCache.clear();
    this.packageModelCache.clear();
    this.definition = null;
    this.state = createEmptyState();
  }

  async load(definition, options = {}) {
    this.clear();
    this.definition = definition || null;
    const packageFileIndex = options.packageFileIndex || null;
    this.state.hasWorldContext = Boolean(this.getWorldContext?.());
    this.log(
      'info',
      `Cutscene actor load start: ${definition?.name || 'unnamed'} models=${definition?.models?.length || 0} motion=${definition?.motionEntries?.length || 0}`,
    );

    if (options.ifpBuffer instanceof ArrayBuffer) {
      try {
        this.state.ifpArchive = this.ifpLoader.parse(options.ifpBuffer);
        this.log(
          'info',
          `IFP loaded: ${this.state.ifpArchive.name || definition?.ifpName || 'unnamed'} version=${this.state.ifpArchive.version} animations=${this.state.ifpArchive.animations.length}`,
        );
      } catch (error) {
        this.pushWarning(`IFP parse failed: ${error.message || error}`);
      }
    } else if (definition?.metadata?.hasIfpFile) {
      this.pushWarning(`IFP file declared for ${definition?.name || 'cutscene'} but buffer is missing`);
    }

    const models = Array.isArray(definition?.models) ? definition.models : [];
    if (models.length === 0) {
      this.log('info', `Cutscene ${definition?.name || 'unnamed'} has no actor model entries`);
      return this.getDebugState();
    }

    const worldContext = this.getWorldContext?.() || null;
    if (!worldContext?.modelResolver && !packageFileIndex) {
      this.pushWarning('Cutscene actors disabled: no world/IMG context is mounted and the cutscene package has no local model files');
      this.state.actors = models.map((entry, index) => this.createActorEntry(entry, index, {
        loadStatus: 'skipped-no-assets',
      }));
      return this.getDebugState();
    }

    for (let index = 0; index < models.length; index += 1) {
      const modelEntry = models[index];
      const actor = await this.loadActor(modelEntry, index, worldContext, packageFileIndex);
      this.state.actors.push(actor);
    }

    this.log(
      'info',
      `Cutscene actor load complete: loaded=${this.state.actors.filter((entry) => entry.loadStatus === 'loaded').length}/${this.state.actors.length}`,
    );

    return this.getDebugState();
  }

  createActorEntry(modelEntry, index, extra = {}) {
    const baseName = String(modelEntry?.modelName || `actor_${index}`).trim();
    return {
      index,
      name: `${baseName}#${index}`,
      modelName: baseName,
      animName: String(modelEntry?.animName || '').trim(),
      slot: Number(modelEntry?.slot) || 0,
      root: null,
      instance: null,
      skeletonInfo: null,
      mixer: null,
      action: null,
      clip: null,
      clipBundle: null,
      skeletonHelper: null,
      modelSource: '',
      txdSource: '',
      warnings: [],
      loadStatus: 'pending',
      attachment: null,
      motionEntry: null,
      ...extra,
    };
  }

  async loadPackageTextureDictionary(modelName, packageFileIndex) {
    const key = stripExtension(modelName).toLowerCase();
    if (!key) return null;
    if (this.packageTextureCache.has(key)) {
      return this.packageTextureCache.get(key);
    }
    const txdRecord = findPackageAssetRecord(packageFileIndex, modelName, 'txd');
    if (!txdRecord?.file) {
      this.packageTextureCache.set(key, null);
      return null;
    }
    const loader = new TXDLoader();
    const dict = normalizeTextureDictionary(loader.parse(await txdRecord.file.arrayBuffer()));
    const result = {
      record: txdRecord,
      textureDictionary: dict,
    };
    this.packageTextureCache.set(key, result);
    return result;
  }

  async resolvePackageModel(modelName, packageFileIndex, worldContext) {
    const key = stripExtension(modelName).toLowerCase();
    if (!key || !packageFileIndex) return null;
    if (this.packageModelCache.has(key)) {
      return this.packageModelCache.get(key);
    }
    const dffRecord = findPackageAssetRecord(packageFileIndex, modelName, 'dff');
    if (!dffRecord?.file) {
      this.packageModelCache.set(key, null);
      return null;
    }
    const packageTexture = await this.loadPackageTextureDictionary(modelName, packageFileIndex);
    const fallbackTextureDictionary = packageTexture?.textureDictionary
      || await worldContext?.textureResolver?.resolveTextureDictionary?.(modelName)
      || null;
    const loader = new DFFLoader();
    if (fallbackTextureDictionary) loader.setTextureDictionary(fallbackTextureDictionary);
    const template = loader.parse(await dffRecord.file.arrayBuffer());
    const resolved = {
      modelName: stripExtension(modelName),
      txdName: stripExtension(modelName),
      dffSource: dffRecord.normalizedPath || dffRecord.path || dffRecord.file?.name || '',
      txdSource: packageTexture?.record?.normalizedPath
        || packageTexture?.record?.path
        || worldContext?.textureResolver?.getSource?.(modelName)
        || '',
      textureDictionary: fallbackTextureDictionary,
      template,
      sourceKind: 'cutscene-package',
    };
    this.packageModelCache.set(key, resolved);
    return resolved;
  }

  async loadActor(modelEntry, index, worldContext, packageFileIndex = null) {
    const actor = this.createActorEntry(modelEntry, index);
    this.log('info', `Resolve actor: model=${actor.modelName} anim=${actor.animName || actor.modelName} slot=${actor.slot}`);
    const actorRoot = new THREE.Group();
    actorRoot.name = actor.name;
    this.root.add(actorRoot);
    actor.root = actorRoot;
      actor.motionEntry = findActorMotionEntry(this.definition, actor);
    actor.baseOffset = gtaPositionToThree(
      this.definition?.offset?.x || 0,
      this.definition?.offset?.y || 0,
      this.definition?.offset?.z || 0,
    );
    actor.attachmentRuntime = this.attachmentRuntime;

    let resolvedModel = null;
    try {
      resolvedModel = await this.resolvePackageModel(actor.modelName, packageFileIndex, worldContext);
      if (resolvedModel) {
        this.log('info', `Actor model resolved from cutscene package: ${actor.modelName}`);
      } else if (worldContext?.modelResolver) {
        resolvedModel = await worldContext.modelResolver.resolve(actor.modelName, actor.modelName);
      }
    } catch (error) {
      const message = `Cutscene actor skipped: ${actor.modelName}.dff not found (${error.message || error})`;
      actor.loadStatus = 'missing-model';
      actor.warnings.push(message);
      this.pushWarning(message);
      return actor;
    }
    if (!resolvedModel?.template) {
      const message = `Cutscene actor skipped: ${actor.modelName}.dff not found in cutscene package or mounted IMG`;
      actor.loadStatus = 'missing-model';
      actor.warnings.push(message);
      this.pushWarning(message);
      return actor;
    }

    actor.modelSource = resolvedModel?.dffSource || '';
    actor.txdSource = resolvedModel?.txdSource || '';
    this.log(
      'info',
      `Actor model resolved: ${actor.modelName} dff=${actor.modelSource || 'n/a'} txd=${actor.txdSource || 'n/a'}`,
    );

    try {
      const instance = cloneTemplate(resolvedModel.template);
      instance.name = `${actor.modelName}_instance`;
      actorRoot.add(instance);
      actor.instance = instance;
      instance.traverse((node) => {
        if (!node?.isMesh) return;
        node.frustumCulled = false;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (!material) continue;
          material.needsUpdate = true;
        }
      });
      actor.skeletonInfo = inspectSkeletonHierarchy(instance);
      if ((actor.skeletonInfo?.meshCount || 0) <= 0) {
        const message = `Cutscene actor ${actor.modelName} has no renderable geometry in DFF (${actor.modelSource || 'unknown source'})`;
        actor.loadStatus = 'empty-model';
        actor.warnings.push(message);
        this.pushWarning(message);
        return actor;
      }
      if (actor.skeletonInfo?.skinnedMeshCount > 0) {
        const skeletonHelper = new THREE.SkeletonHelper(instance);
        skeletonHelper.name = `${actor.name}_skeletonHelper`;
        skeletonHelper.material.depthTest = false;
        skeletonHelper.material.transparent = true;
        skeletonHelper.material.opacity = 0.9;
        skeletonHelper.material.toneMapped = false;
        skeletonHelper.renderOrder = 9999;
        skeletonHelper.visible = this.debugSkeletonsVisible && this.root.visible;
        actorRoot.add(skeletonHelper);
        actor.skeletonHelper = skeletonHelper;
      }

      const animation = this.findAnimation(actor.animName || actor.modelName);
      if (animation) {
        const clipBundle = createIfpAnimationClip(animation, actor.skeletonInfo);
        actor.clipBundle = clipBundle;
        actor.clip = clipBundle?.clip || null;
        if (actor.clip) {
          actor.mixer = new THREE.AnimationMixer(instance);
          actor.action = actor.mixer.clipAction(actor.clip);
          actor.action.setLoop(THREE.LoopOnce, 1);
          actor.action.clampWhenFinished = true;
          actor.action.play();
          this.log(
            'info',
            `Actor animation bound: ${actor.modelName} clip=${actor.clip.name} tracks=${clipBundle.matchedTrackCount} rootMotion=${clipBundle.rootMotion ? 'yes' : 'no'}`,
          );
        } else {
          const message = `Cutscene actor ${actor.modelName} matched no IFP skeleton tracks`;
          actor.warnings.push(message);
          this.pushWarning(message);
        }
      } else if (this.state.ifpArchive) {
        const message = `Cutscene actor ${actor.modelName} missing clip ${actor.animName || actor.modelName}`;
        actor.warnings.push(message);
        this.pushWarning(message);
      } else if (this.definition?.metadata?.hasIfpFile) {
        const message = `Cutscene actor ${actor.modelName} has no parsed IFP archive`;
        actor.warnings.push(message);
        this.pushWarning(message);
      }

      actor.loadStatus = 'loaded';
      this.log(
        'info',
        `Actor ready: ${actor.modelName} skinned=${actor.skeletonInfo?.skinnedMeshCount > 0 ? 'yes' : 'no'} bones=${actor.skeletonInfo?.boneCount || 0} frames=${actor.skeletonInfo?.frameCount || 0}`,
      );
      this.rendererSession?.getRenderQueue?.()?.markDirty?.();
      return actor;
    } catch (error) {
      const message = `Cutscene actor ${actor.modelName} failed to instantiate (${error.message || error})`;
      actor.loadStatus = 'failed';
      actor.warnings.push(message);
      this.pushWarning(message);
      return actor;
    }
  }

  findAnimation(name) {
    const normalizedName = normalizeLookupName(name);
    if (!normalizedName || !this.state.ifpArchive?.animations?.length) return null;
    return this.state.ifpArchive.animations.find((entry) => normalizeLookupName(entry.name) === normalizedName) || null;
  }

  setupToStart() {
    this.seek(0);
  }

  seek(timeMs = 0) {
    const timeSeconds = Math.max(0, (Number(timeMs) || 0) / 1000);
    for (const actor of this.state.actors) {
      if (!actor.root) continue;
      const actorTimeSeconds = mapCutsceneTimeToActorTime(this.definition, actor, timeSeconds);
      applyActorPose(actor, actorTimeSeconds);
    }
    this.state.timeMs = Math.max(0, Number(timeMs) || 0);
    return this.getDebugState();
  }

  update(timeMs = 0) {
    const nextTimeMs = Math.max(0, Number(timeMs) || 0);
    const previousTimeMs = Math.max(0, Number(this.state.timeMs) || 0);
    const dtSeconds = Math.max(0, nextTimeMs - previousTimeMs) / 1000;

    if (dtSeconds <= 0 || dtSeconds > 0.5) {
      return this.seek(nextTimeMs);
    }

    const timeSeconds = nextTimeMs / 1000;
    for (const actor of this.state.actors) {
      if (!actor.root) continue;
      const actorTimeSeconds = mapCutsceneTimeToActorTime(this.definition, actor, timeSeconds);
      applyActorPose(actor, actorTimeSeconds);
    }
    this.state.timeMs = nextTimeMs;
    return this.getDebugState();
  }

  attachActorToActor({
    childName = '',
    parentName = '',
    targetType = 'bone',
    targetName = '',
    snapToTarget = true,
  } = {}) {
    const childActor = this.findActor(childName);
    const parentActor = this.findActor(parentName);
    if (!childActor?.root) throw new Error(`Attach child not found: ${childName}`);
    if (!parentActor?.root) throw new Error(`Attach parent not found: ${parentName}`);
    if (childActor === parentActor) throw new Error('Child and parent actors must be different');
    const attachment = targetType === 'frame'
      ? this.attachmentRuntime.attachObjectToFrame(childActor.root, parentActor, targetName, { keepWorldTransform: !snapToTarget })
      : this.attachmentRuntime.attachObjectToBone(childActor.root, parentActor, targetName, { keepWorldTransform: !snapToTarget });
    childActor.attachment = attachment;
    this.log('info', `Actor attached: ${childActor.name} -> ${parentActor.name} ${targetType}:${targetName}`);
    return this.getDebugState();
  }

  detachActor(childName = '') {
    const childActor = this.findActor(childName);
    if (!childActor?.root) throw new Error(`Detach child not found: ${childName}`);
    this.attachmentRuntime.detach(childActor.root);
    childActor.attachment = null;
    this.log('info', `Actor detached: ${childActor.name}`);
    return this.getDebugState();
  }

  findActor(name = '') {
    const normalized = normalizeLookupName(name);
    if (!normalized) return null;
    return this.state.actors.find((entry) => normalizeLookupName(entry.name) === normalized || normalizeLookupName(entry.modelName) === normalized) || null;
  }

  getDebugState() {
    const sanitizeAttachment = (attachment) => (attachment
      ? {
        parentName: attachment.parentName,
        targetType: attachment.targetType,
        targetName: attachment.targetName,
        targetNodeId: attachment.targetNodeId,
      }
      : null);
    return {
      hasWorldContext: this.state.hasWorldContext,
      debugSkeletonsVisible: this.debugSkeletonsVisible,
      ifpArchiveName: this.state.ifpArchive?.name || '',
      ifpVersion: this.state.ifpArchive?.version || '',
      warnings: [...this.state.warnings],
      attachments: this.attachmentRuntime.list().map((entry) => sanitizeAttachment(entry)),
      loadedActorCount: this.state.actors.filter((entry) => entry.loadStatus === 'loaded').length,
      actors: this.state.actors.map((entry) => ({
        name: entry.name,
        modelName: entry.modelName,
        animName: entry.animName,
        slot: entry.slot,
        loadStatus: entry.loadStatus,
        modelSource: entry.modelSource,
        txdSource: entry.txdSource,
        clipName: entry.clip?.name || '',
        clipDurationSeconds: Number(entry.clip?.duration) || 0,
        matchedTrackCount: Number(entry.clipBundle?.matchedTrackCount) || 0,
        hasRootMotion: Boolean(entry.clipBundle?.rootMotion),
        motionEntry: entry.motionEntry ? { ...entry.motionEntry } : null,
        skinned: Number(entry.skeletonInfo?.skinnedMeshCount) > 0,
        skeletonCount: Number(entry.skeletonInfo?.skeletonCount) || 0,
        boneCount: Number(entry.skeletonInfo?.boneCount) || 0,
        frameCount: Number(entry.skeletonInfo?.frameCount) || 0,
        meshCount: Number(entry.skeletonInfo?.meshCount) || 0,
        hasSkeletonHelper: Boolean(entry.skeletonHelper),
        attachment: sanitizeAttachment(entry.attachment),
        attachmentTargets: Array.isArray(entry.skeletonInfo?.attachmentTargets)
          ? entry.skeletonInfo.attachmentTargets.map((target) => ({ ...target }))
          : [],
        warnings: [...entry.warnings],
      })),
    };
  }
}
