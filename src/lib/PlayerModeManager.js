export const APP_MODE_EDITOR = 'Editor';
export const APP_MODE_TEST = 'Test';
export const APP_MODE_CUTSCENE = 'Cutscene';

export class PlayerModeManager {
  constructor(options) {
    this.playerController = options.playerController;
    this.getMode = options.getMode;
    this.setMode = options.setMode;
    this.onModeStatus = options.onModeStatus;
    this.onModeError = options.onModeError;
    this.onModeLog = options.onModeLog;
    this.onExitTestMode = options.onExitTestMode;
  }

  isTestMode() {
    return this.getMode() === APP_MODE_TEST;
  }

  isCutsceneMode() {
    return this.getMode() === APP_MODE_CUTSCENE;
  }

  isEditorMode() {
    return this.getMode() === APP_MODE_EDITOR;
  }

  async switchMode(nextModeRaw) {
    const nextMode = nextModeRaw === APP_MODE_TEST
      ? APP_MODE_TEST
      : (nextModeRaw === APP_MODE_CUTSCENE ? APP_MODE_CUTSCENE : APP_MODE_EDITOR);
    const prevMode = this.getMode();
    if (nextMode === prevMode) return;

    this.setMode(nextMode);
    const enableTest = nextMode === APP_MODE_TEST;

    try {
      const controllerMode = await this.playerController.setEnabled(enableTest);
      if (!enableTest && typeof this.onExitTestMode === 'function') {
        this.onExitTestMode();
      }
      if (typeof this.onModeLog === 'function') {
        this.onModeLog(prevMode, nextMode, controllerMode);
      }
      if (typeof this.onModeStatus === 'function') {
        this.onModeStatus(nextMode, controllerMode, enableTest, prevMode);
      }
    } catch (error) {
      this.setMode(APP_MODE_EDITOR);
      await Promise.resolve(this.playerController.setEnabled(false)).catch(() => {});
      if (typeof this.onExitTestMode === 'function') {
        this.onExitTestMode();
      }
      if (typeof this.onModeError === 'function') {
        this.onModeError(error);
      }
      throw error;
    }
  }

  update(dt) {
    if (this.isTestMode()) {
      this.playerController.update(dt);
    }
  }

  destroy() {
    this.playerController.destroy();
  }
}
