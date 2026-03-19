import { resolveRWPipelineSelection } from './selection.js';

export class RWPipelineRegistry {
  constructor() {
    this.profiles = new Map();
  }

  register(profile) {
    if (!profile?.id) {
      throw new Error('RWPipelineRegistry: profile.id is required');
    }
    this.profiles.set(profile.id, {
      ...profile,
      backends: {
        ...(profile.backends || {}),
      },
    });
    return profile;
  }

  list() {
    return [...this.profiles.values()];
  }

  get(profileId) {
    return this.profiles.get(profileId) || null;
  }

  resolve(selection) {
    const normalized = resolveRWPipelineSelection(selection, selection?.worldGameVersion);
    if (!normalized.enabled) return null;
    for (const profile of this.profiles.values()) {
      if (
        profile.game === normalized.game
        && profile.category === normalized.category
        && profile.platform === normalized.platform
      ) {
        return profile;
      }
    }
    return null;
  }

  resolveBackendImplementation(profile, backendId) {
    if (!profile) return null;
    const implementations = profile.backends || {};
    return implementations[String(backendId || '').toUpperCase()] || implementations.DEFAULT || null;
  }
}
