export const RW_PIPELINE_GAME = Object.freeze({
  DEFAULT: 'DEFAULT',
  VCS: 'VCS',
  LCS: 'LCS',
  SA: 'SA',
});

export const RW_PIPELINE_CATEGORY = Object.freeze({
  BUILDING: 'building',
  POSTFX: 'postfx',
});

export const RW_PIPELINE_PLATFORM = Object.freeze({
  DEFAULT: 'DEFAULT',
  PS2: 'PS2',
  PSP: 'PSP',
  PC: 'PC',
  VCS: 'VCS',
  LCS: 'LCS',
});

export const RW_PIPELINE_SELECTION_DEFAULT = Object.freeze({
  enabled: false,
  game: RW_PIPELINE_GAME.DEFAULT,
  category: RW_PIPELINE_CATEGORY.BUILDING,
  platform: RW_PIPELINE_PLATFORM.PS2,
});

export const RW_PIPELINE_SELECTION_DEFAULTS = Object.freeze({
  [RW_PIPELINE_CATEGORY.BUILDING]: Object.freeze({
    enabled: false,
    game: RW_PIPELINE_GAME.DEFAULT,
    category: RW_PIPELINE_CATEGORY.BUILDING,
    platform: RW_PIPELINE_PLATFORM.PS2,
  }),
  [RW_PIPELINE_CATEGORY.POSTFX]: Object.freeze({
    enabled: false,
    game: RW_PIPELINE_GAME.DEFAULT,
    category: RW_PIPELINE_CATEGORY.POSTFX,
    platform: RW_PIPELINE_PLATFORM.VCS,
    config: Object.freeze({
      trailsLimit: 80,
      trailsIntensity: 38,
      radiosityResolutionDivisor: 4,
      blurOffset: 2.1,
      blurIntensity: (39.0 * 0.8) / 255.0,
      historyIntensity: 32 / 255.0,
      enableTrails: true,
      enableColorFilter: false,
      enableBigBloomSunEffect: true,
      enableRadiosity: true,
      enableBlur: true,
      debugView: 'final',
    }),
  }),
});

export const RW_PIPELINE_GAME_OPTIONS = Object.freeze([
  RW_PIPELINE_GAME.DEFAULT,
  RW_PIPELINE_GAME.VCS,
  RW_PIPELINE_GAME.LCS,
  RW_PIPELINE_GAME.SA,
]);

export const RW_PIPELINE_CATEGORY_OPTIONS = Object.freeze([
  RW_PIPELINE_CATEGORY.BUILDING,
  RW_PIPELINE_CATEGORY.POSTFX,
]);

export const RW_PIPELINE_PLATFORM_OPTIONS = Object.freeze({
  [RW_PIPELINE_CATEGORY.BUILDING]: Object.freeze({
    [RW_PIPELINE_GAME.DEFAULT]: [RW_PIPELINE_PLATFORM.PS2, RW_PIPELINE_PLATFORM.PSP, RW_PIPELINE_PLATFORM.PC, RW_PIPELINE_PLATFORM.DEFAULT],
    [RW_PIPELINE_GAME.VCS]: [RW_PIPELINE_PLATFORM.DEFAULT, RW_PIPELINE_PLATFORM.PS2, RW_PIPELINE_PLATFORM.PSP],
    [RW_PIPELINE_GAME.LCS]: [RW_PIPELINE_PLATFORM.DEFAULT, RW_PIPELINE_PLATFORM.PS2, RW_PIPELINE_PLATFORM.PSP],
    [RW_PIPELINE_GAME.SA]: [RW_PIPELINE_PLATFORM.DEFAULT, RW_PIPELINE_PLATFORM.PS2, RW_PIPELINE_PLATFORM.PC],
  }),
  [RW_PIPELINE_CATEGORY.POSTFX]: Object.freeze({
    [RW_PIPELINE_GAME.DEFAULT]: [RW_PIPELINE_PLATFORM.VCS, RW_PIPELINE_PLATFORM.LCS, RW_PIPELINE_PLATFORM.DEFAULT],
    [RW_PIPELINE_GAME.VCS]: [RW_PIPELINE_PLATFORM.VCS, RW_PIPELINE_PLATFORM.DEFAULT],
    [RW_PIPELINE_GAME.LCS]: [RW_PIPELINE_PLATFORM.LCS, RW_PIPELINE_PLATFORM.DEFAULT],
    [RW_PIPELINE_GAME.SA]: [RW_PIPELINE_PLATFORM.DEFAULT],
  }),
});
