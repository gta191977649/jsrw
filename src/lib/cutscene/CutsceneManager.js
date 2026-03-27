import { CutsceneCameraPlayer } from './CutsceneCameraPlayer.js';
import { CutsceneAudioPlayer } from './CutsceneAudioPlayer.js';
import { CutsceneLibrary } from './CutsceneLibrary.js';
import { parseVcsCutsceneDefinition } from './VcsCutsceneParser.js';
import { CutsceneActorRuntime } from '../jsrw/animation/runtime/CutsceneActorRuntime.js';

function createEmptyStatus() {
  return {
    sourceLabel: '',
    selectedName: '',
    availableNames: [],
    loadedDefinition: null,
    playing: false,
    loop: false,
    timeMs: 0,
    durationMs: 0,
    lastError: '',
    debugSample: null,
    subtitleCue: null,
    actorRuntime: {
      actors: [],
      warnings: [],
      attachments: [],
      hasWorldContext: false,
      ifpArchiveName: '',
      ifpVersion: '',
      loadedActorCount: 0,
    },
    audioRuntime: {
      fileName: '',
      hasAudio: false,
      ready: false,
      playing: false,
      loop: false,
      durationSeconds: 0,
      lastError: '',
    },
  };
}

function findActiveSubtitle(subtitles = [], timeMs = 0) {
  if (!Array.isArray(subtitles) || subtitles.length === 0) return null;
  const currentTimeMs = Math.max(0, Number(timeMs) || 0);
  return subtitles.find((entry) => currentTimeMs >= entry.startMs && currentTimeMs < entry.endMs) || null;
}

export class CutsceneManager {
  constructor(options = {}) {
    this.library = options.library || new CutsceneLibrary();
    this.player = options.player || new CutsceneCameraPlayer();
    this.actorRuntime = options.actorRuntime || new CutsceneActorRuntime();
    this.audioPlayer = options.audioPlayer || new CutsceneAudioPlayer();
    this.status = createEmptyStatus();
  }

  initialise() {
    this.player.clear();
    this.actorRuntime.clear();
    this.audioPlayer.clear();
    this.status = createEmptyStatus();
  }

  setSceneRoot(sceneRoot) {
    this.actorRuntime.setSceneRoot(sceneRoot);
  }

  setRendererSession(rendererSession) {
    this.actorRuntime.setRendererSession(rendererSession);
  }

  setWorldContextGetter(getWorldContext) {
    this.actorRuntime.setWorldContextGetter(getWorldContext);
  }

  setLogger(logger) {
    this.actorRuntime.setLogger(logger);
    this.audioPlayer.setLogger(logger);
  }

  setRuntimeContextGetters(options = {}) {
    this.actorRuntime.setRuntimeContextGetters(options);
  }

  setVisible(visible) {
    this.actorRuntime.setVisible(visible);
  }

  setDebugSkeletonsVisible(visible) {
    this.actorRuntime.setDebugSkeletonsVisible(visible);
    this.status.actorRuntime = this.actorRuntime.getDebugState();
  }

  getStatus() {
    return {
      ...this.status,
      availableNames: [...this.status.availableNames],
      actorRuntime: {
        ...(this.status.actorRuntime || {}),
        actors: Array.isArray(this.status.actorRuntime?.actors)
          ? this.status.actorRuntime.actors.map((entry) => ({
            ...entry,
            warnings: [...(entry.warnings || [])],
            attachmentTargets: Array.isArray(entry.attachmentTargets)
              ? entry.attachmentTargets.map((target) => ({ ...target }))
              : [],
          }))
          : [],
        warnings: [...(this.status.actorRuntime?.warnings || [])],
        attachments: [...(this.status.actorRuntime?.attachments || [])],
      },
    };
  }

  async loadFolderFiles(files, options = {}) {
    const result = await this.library.loadFolderFiles(files, options);
    this.status.sourceLabel = result.sourceLabel;
    this.status.availableNames = result.names;
    this.status.lastError = '';
    if (!result.names.includes(this.status.selectedName)) {
      this.status.selectedName = result.names[0] || '';
    }
    return result;
  }

  async loadZipFile(file) {
    const result = await this.library.loadZipFile(file);
    this.status.sourceLabel = result.sourceLabel;
    this.status.availableNames = result.names;
    this.status.lastError = '';
    this.status.selectedName = result.names[0] || '';
    return result;
  }

  async loadCutsceneData(name) {
    const resolvedName = String(name || this.status.selectedName || '').trim();
    if (!resolvedName) {
      throw new Error('No cutscene selected');
    }
    const raw = await this.library.readCutsceneFiles(resolvedName);
    const definition = parseVcsCutsceneDefinition(raw);
    this.status.selectedName = definition.name;
    this.status.availableNames = this.library.listCutsceneNames();
    this.status.loadedDefinition = definition;
    this.status.durationMs = definition.durationMs;
    this.status.timeMs = 0;
    this.status.subtitleCue = findActiveSubtitle(definition.metadata?.subtitles, 0);
    this.status.lastError = '';
    this.player.loadDefinition(definition);
    this.player.setLoop(this.status.loop);
    await this.audioPlayer.loadFromFile(raw.mp3File);
    this.audioPlayer.setLoop(this.status.loop);
    this.status.actorRuntime = await this.actorRuntime.load(definition, {
      ifpBuffer: raw.ifpBuffer,
      packageFileIndex: raw.fileIndex,
    });
    this.status.audioRuntime = this.audioPlayer.getDebugState();
    return definition;
  }

  async setupCutsceneToStart(camera, name = '') {
    if (name || !this.status.loadedDefinition) {
      await this.loadCutsceneData(name || this.status.selectedName);
    }
    this.player.seek(0);
    this.player.pause();
    this.status.timeMs = 0;
    this.status.playing = false;
    this.status.debugSample = this.player.sampleToCamera(camera, 0);
    this.status.subtitleCue = findActiveSubtitle(this.status.loadedDefinition?.metadata?.subtitles, 0);
    this.status.actorRuntime = this.actorRuntime.setupToStart();
    this.audioPlayer.stop();
    this.status.audioRuntime = this.audioPlayer.getDebugState();
    return this.status.debugSample;
  }

  play() {
    this.player.play();
    this.status.playing = true;
    void this.audioPlayer.play(this.status.timeMs);
    this.status.audioRuntime = this.audioPlayer.getDebugState();
  }

  pause() {
    this.player.pause();
    this.status.playing = false;
    this.audioPlayer.pause();
    this.status.audioRuntime = this.audioPlayer.getDebugState();
  }

  finishCutscene(camera) {
    const durationMs = this.player.getDurationMs();
    this.player.seek(durationMs);
    this.player.pause();
    this.status.playing = false;
    this.status.timeMs = durationMs;
    this.status.debugSample = this.player.sampleToCamera(camera, durationMs);
    this.status.subtitleCue = findActiveSubtitle(this.status.loadedDefinition?.metadata?.subtitles, durationMs);
    this.status.actorRuntime = this.actorRuntime.seek(durationMs);
    this.audioPlayer.pause();
    this.audioPlayer.seek(durationMs);
    this.status.audioRuntime = this.audioPlayer.getDebugState();
    return this.status.debugSample;
  }

  stop(camera) {
    this.player.stop();
    this.status.playing = false;
    this.status.timeMs = 0;
    this.status.debugSample = this.player.sampleToCamera(camera, 0);
    this.status.subtitleCue = findActiveSubtitle(this.status.loadedDefinition?.metadata?.subtitles, 0);
    this.status.actorRuntime = this.actorRuntime.seek(0);
    this.audioPlayer.stop();
    this.status.audioRuntime = this.audioPlayer.getDebugState();
    return this.status.debugSample;
  }

  seek(timeMs, camera) {
    this.player.seek(timeMs);
    this.status.timeMs = this.player.timeMs;
    this.status.debugSample = this.player.sampleToCamera(camera, this.status.timeMs);
    this.status.subtitleCue = findActiveSubtitle(this.status.loadedDefinition?.metadata?.subtitles, this.status.timeMs);
    this.status.actorRuntime = this.actorRuntime.seek(this.status.timeMs);
    this.audioPlayer.seek(this.status.timeMs);
    this.status.audioRuntime = this.audioPlayer.getDebugState();
    return this.status.debugSample;
  }

  setLoop(loop) {
    this.status.loop = Boolean(loop);
    this.player.setLoop(this.status.loop);
    this.audioPlayer.setLoop(this.status.loop);
    this.status.audioRuntime = this.audioPlayer.getDebugState();
  }

  update(dtSeconds, camera) {
    const sample = this.player.update(dtSeconds, camera);
    this.status.playing = this.player.playing;
    this.status.timeMs = this.player.timeMs;
    this.status.durationMs = this.player.getDurationMs();
    this.status.debugSample = sample;
    this.status.subtitleCue = findActiveSubtitle(this.status.loadedDefinition?.metadata?.subtitles, this.status.timeMs);
    this.status.actorRuntime = this.actorRuntime.update(this.status.timeMs);
    this.audioPlayer.sync(this.status.timeMs, this.status.playing);
    this.status.audioRuntime = this.audioPlayer.getDebugState();
    return sample;
  }

  attachActorToActor(options = {}) {
    this.status.actorRuntime = this.actorRuntime.attachActorToActor(options);
    return this.status.actorRuntime;
  }

  detachActor(name = '') {
    this.status.actorRuntime = this.actorRuntime.detachActor(name);
    return this.status.actorRuntime;
  }

  deleteCutsceneData() {
    this.player.clear();
    this.actorRuntime.clear();
    this.audioPlayer.clear();
    this.status.loadedDefinition = null;
    this.status.playing = false;
    this.status.timeMs = 0;
    this.status.durationMs = 0;
    this.status.debugSample = null;
    this.status.subtitleCue = null;
    this.status.actorRuntime = createEmptyStatus().actorRuntime;
    this.status.audioRuntime = createEmptyStatus().audioRuntime;
  }
}
