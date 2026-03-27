function clampTimeSeconds(value) {
  return Math.max(0, Number(value) || 0);
}

export class CutsceneAudioPlayer {
  constructor(options = {}) {
    this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
    this.resetState();
  }

  resetState() {
    this.audio = null;
    this.objectUrl = '';
    this.fileName = '';
    this.ready = false;
    this.playing = false;
    this.loop = false;
    this.durationSeconds = 0;
    this.lastError = '';
  }

  setLogger(logger) {
    this.onLog = typeof logger === 'function' ? logger : null;
  }

  log(level, message) {
    this.onLog?.(level, message);
  }

  attachAudio(audio) {
    if (!audio) return;
    audio.preload = 'auto';
    audio.loop = this.loop;
    audio.addEventListener('loadedmetadata', () => {
      this.ready = true;
      this.durationSeconds = Number(audio.duration) || 0;
      this.log('info', `Cutscene voice ready: ${this.fileName || 'audio'} duration=${this.durationSeconds.toFixed(3)}s`);
    });
    audio.addEventListener('error', () => {
      this.lastError = `Failed to load cutscene voice: ${this.fileName || 'audio'}`;
      this.log('warn', this.lastError);
    });
    audio.addEventListener('ended', () => {
      this.playing = false;
    });
  }

  clear() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio.load?.();
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }
    this.resetState();
  }

  async loadFromFile(file) {
    this.clear();
    if (!file) return this.getDebugState();
    this.fileName = String(file.name || '').trim();
    this.objectUrl = URL.createObjectURL(file);
    this.audio = new Audio(this.objectUrl);
    this.attachAudio(this.audio);
    this.log('info', `Cutscene voice loaded: ${this.fileName || 'unnamed.mp3'}`);
    return this.getDebugState();
  }

  setLoop(loop) {
    this.loop = Boolean(loop);
    if (this.audio) this.audio.loop = this.loop;
  }

  seek(timeMs = 0) {
    if (!this.audio) return;
    const nextTimeSeconds = clampTimeSeconds((Number(timeMs) || 0) / 1000);
    const maxTimeSeconds = this.durationSeconds > 0
      ? Math.max(0, this.durationSeconds - 0.001)
      : nextTimeSeconds;
    this.audio.currentTime = Math.min(nextTimeSeconds, maxTimeSeconds);
  }

  async play(timeMs = 0) {
    if (!this.audio) return;
    this.seek(timeMs);
    try {
      await this.audio.play();
      this.playing = true;
    } catch (error) {
      this.playing = false;
      this.lastError = `Cutscene voice play failed: ${error?.message || error}`;
      this.log('warn', this.lastError);
    }
  }

  pause() {
    if (!this.audio) return;
    this.audio.pause();
    this.playing = false;
  }

  stop() {
    if (!this.audio) return;
    this.audio.pause();
    this.audio.currentTime = 0;
    this.playing = false;
  }

  sync(timeMs = 0, playing = false) {
    if (!this.audio) return;
    const targetTimeSeconds = clampTimeSeconds((Number(timeMs) || 0) / 1000);
    const currentTimeSeconds = clampTimeSeconds(this.audio.currentTime);
    if (Math.abs(currentTimeSeconds - targetTimeSeconds) > 0.1) {
      this.seek(timeMs);
    }
    if (playing && this.audio.paused) {
      void this.play(timeMs);
    } else if (!playing && !this.audio.paused) {
      this.pause();
    }
    this.playing = !this.audio.paused;
  }

  getDebugState() {
    return {
      fileName: this.fileName,
      hasAudio: Boolean(this.audio),
      ready: this.ready,
      playing: this.playing,
      loop: this.loop,
      durationSeconds: this.durationSeconds,
      lastError: this.lastError,
    };
  }
}
