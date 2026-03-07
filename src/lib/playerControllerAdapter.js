import * as THREE from 'three';

class LocalFallbackController {
  constructor(options) {
    this.camera = options.camera;
    this.getMoveState = options.getMoveState;
    this.getLookState = options.getLookState;
    this.worldUp = options.worldUp || new THREE.Vector3(0, 1, 0);
  }

  enable() {}

  disable() {}

  update(dt) {
    const move = this.getMoveState();
    const look = this.getLookState();
    const inputX = (move.right ? 1 : 0) - (move.left ? 1 : 0);
    const inputY = (move.forward ? 1 : 0) - (move.back ? 1 : 0);
    const inputZ = (move.up ? 1 : 0) - (move.down ? 1 : 0);
    if (!inputX && !inputY && !inputZ) return;

    const cp = Math.cos(look.pitch);
    const forward = new THREE.Vector3(
      Math.sin(look.yaw) * cp,
      Math.sin(look.pitch),
      Math.cos(look.yaw) * cp,
    ).normalize();
    const right = new THREE.Vector3().crossVectors(this.worldUp, forward).normalize().negate();
    const velocity = move.boost ? 800 : 250;

    const delta = new THREE.Vector3();
    delta.addScaledVector(forward, inputY);
    delta.addScaledVector(right, inputX);
    delta.y += inputZ;
    if (delta.lengthSq() === 0) return;
    delta.normalize().multiplyScalar(velocity * dt);
    this.camera.position.add(delta);
  }

  destroy() {}
}

export class PlayerControllerAdapter {
  constructor(options) {
    this.options = options;
    this.controller = null;
    this.externalFactory = null;
    this.lastError = null;
    this.mode = 'none';
    this.enabled = false;
  }

  async _loadExternalFactory() {
    if (this.externalFactory) return this.externalFactory;
    if (typeof this.options.externalFactory === 'function') {
      this.externalFactory = this.options.externalFactory;
      return this.externalFactory;
    }

    try {
      const spec = 'three-player-controller';
      const mod = await import(/* @vite-ignore */ spec);
      const candidate = mod?.playerController || mod?.default || mod?.playerController?.default;
      if (typeof candidate !== 'function') return null;
      this.externalFactory = candidate;
      return candidate;
    } catch (error) {
      this.lastError = error;
      return null;
    }
  }

  async _createExternalController() {
    const factory = await this._loadExternalFactory();
    if (!factory) return null;
    const controller = factory();
    if (!controller || typeof controller.init !== 'function' || typeof controller.update !== 'function') {
      this.lastError = new Error('Invalid controller object returned by factory');
      return null;
    }

    const spawn = typeof this.options.getSpawnPosition === 'function'
      ? this.options.getSpawnPosition()
      : this.options.camera.position.clone();
    const initPos = spawn instanceof THREE.Vector3 ? spawn.clone() : this.options.camera.position.clone();
    const defaultModel = {
      url: '/glb/person.glb',
      scale: 0.001,
      idleAnim: 'idle1',
      walkAnim: 'walk',
      runAnim: 'run',
      jumpAnim: 'jump',
      flyAnim: 'flying',
      flyIdleAnim: 'flyidle',
      enterCarAnim: 'enterCar',
      exitCarAnim: 'exitCar',
      headObjName: 'mixamorigHead',
      rotateY: Math.PI,
    };
    const playerModel = {
      ...defaultModel,
      ...(this.options.playerModel || {}),
    };
    const minCamDistance = Number.isFinite(this.options.minCamDistance) ? this.options.minCamDistance : 50;
    const maxCamDistance = Number.isFinite(this.options.maxCamDistance) ? this.options.maxCamDistance : 250;
    const thirdMouseMode = Number.isFinite(this.options.thirdMouseMode) ? this.options.thirdMouseMode : 1;

    try {
      await controller.init({
        scene: this.options.scene,
        camera: this.options.camera,
        controls: this.options.controls,
        initPos,
        playerModel,
        isShowMobileControls: false,
        enableZoom: true,
        minCamDistance,
        maxCamDistance,
        thirdMouseMode,
      });
    } catch (error) {
      this.lastError = error;
      throw error;
    }
    return controller;
  }

  async setEnabled(nextEnabled) {
    this.enabled = Boolean(nextEnabled);
    this.lastError = null;

    if (!this.enabled) {
      if (this.controller && typeof this.controller.destroy === 'function') {
        this.controller.destroy();
      }
      this.controller = null;
      if (this.options.controls) this.options.controls.enabled = false;
      return this.mode;
    }

    if (this.controller && this.mode === 'external') {
      if (this.options.controls) this.options.controls.enabled = true;
      return this.mode;
    }

    let external = null;
    try {
      external = await this._createExternalController();
    } catch {
      external = null;
    }
    if (external) {
      this.controller = external;
      this.mode = 'external';
      if (this.options.controls) this.options.controls.enabled = true;
      return this.mode;
    }

    if (!this.options.allowFallback) {
      this.enabled = false;
      const detail = this.lastError instanceof Error ? this.lastError.message : String(this.lastError || 'unknown');
      throw new Error(`three-player-controller init failed: ${detail}`);
    }

    this.controller = new LocalFallbackController(this.options);
    this.mode = 'fallback';
    return this.mode;
  }

  update(dt) {
    if (!this.enabled || !this.controller) return;
    if (typeof this.controller.update === 'function') {
      this.controller.update(dt);
    }
  }

  destroy() {
    if (this.controller && typeof this.controller.destroy === 'function') {
      this.controller.destroy();
    }
    if (this.options.controls) this.options.controls.enabled = false;
    this.controller = null;
    this.enabled = false;
    this.mode = 'none';
  }
}
