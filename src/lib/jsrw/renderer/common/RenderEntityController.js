import {
  DISTANCE_FADE_DEFAULTS,
  resolveDistanceFadeConfig,
  approachValue,
  computeDistanceFadeAlpha,
  isDistanceWithinFadeWindow,
} from '../../../renderDistanceFade.js';

function getEntryVisibilityAlpha(entry) {
  return Math.max(Number(entry?.fadeAlpha) || 0, Number(entry?.streamAlpha) || 0);
}

export class RenderEntityController {
  static getEpsilon(config = null) {
    return resolveDistanceFadeConfig(config).epsilon;
  }

  static isWithinDrawDistance(distance, drawDistance, config = null) {
    return isDistanceWithinFadeWindow(distance, drawDistance, config);
  }

  static isActive(entry, config = null) {
    return getEntryVisibilityAlpha(entry) > RenderEntityController.getEpsilon(config);
  }

  static selectClosest(candidates, budget, config = null) {
    const epsilon = RenderEntityController.getEpsilon(config);
    const sorted = Array.isArray(candidates)
      ? [...candidates].sort((a, b) => (Number(a?.distance) || 0) - (Number(b?.distance) || 0))
      : [];
    let remaining = Math.max(0, Math.floor(Number(budget) || 0));
    const selectedEntries = new Set();
    for (const item of sorted) {
      if (getEntryVisibilityAlpha(item?.entry) > epsilon) {
        selectedEntries.add(item.entry);
        continue;
      }
      if (item?.wantsShow && remaining > 0) {
        selectedEntries.add(item.entry);
        remaining -= 1;
      }
    }
    return selectedEntries;
  }

  static updateFade(entry, options = {}) {
    const fadeConfig = resolveDistanceFadeConfig(options.config || DISTANCE_FADE_DEFAULTS);
    const targetVisible = options.targetVisible === true;
    const distance = Number(options.distance) || 0;
    const drawDistance = Number(options.drawDistance) || 0;
    const dt = Math.max(0, Number(options.dt) || 0);
    const extraAlpha = Math.max(0, Number.isFinite(Number(options.extraAlpha)) ? Number(options.extraAlpha) : 1);

    entry.streamAlpha = approachValue(Number(entry.streamAlpha) || 0, targetVisible ? 1 : 0, dt * fadeConfig.streamAlphaPerSecond);
    entry.fadeAlpha = Math.max(
      0,
      Math.min(1, entry.streamAlpha * computeDistanceFadeAlpha(distance, drawDistance, fadeConfig) * extraAlpha),
    );
    return entry.fadeAlpha;
  }
}

export default RenderEntityController;
