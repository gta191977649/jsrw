import {
  RW_PIPELINE_CATEGORY,
  RW_PIPELINE_CATEGORY_OPTIONS,
  RW_PIPELINE_GAME,
  RW_PIPELINE_GAME_OPTIONS,
  RW_PIPELINE_PLATFORM,
  RW_PIPELINE_PLATFORM_OPTIONS,
  RW_PIPELINE_SELECTION_DEFAULT,
  RW_PIPELINE_SELECTION_DEFAULTS,
} from './constants.js';

function clampPipelineValue(value, validValues, fallback) {
  return validValues.includes(value) ? value : fallback;
}

function getSelectionDefault(category = RW_PIPELINE_CATEGORY.BUILDING) {
  return RW_PIPELINE_SELECTION_DEFAULTS[category] || RW_PIPELINE_SELECTION_DEFAULT;
}

function getPlatformOptionsFor(category, game) {
  const categoryOptions = RW_PIPELINE_PLATFORM_OPTIONS[category] || RW_PIPELINE_PLATFORM_OPTIONS[RW_PIPELINE_CATEGORY.BUILDING];
  return categoryOptions[String(game || '').toUpperCase()] || categoryOptions[RW_PIPELINE_GAME.DEFAULT] || [RW_PIPELINE_PLATFORM.DEFAULT];
}

export function cloneRWPipelineSelection(selection = RW_PIPELINE_SELECTION_DEFAULT) {
  const defaultSelection = getSelectionDefault(String(selection?.category || RW_PIPELINE_CATEGORY.BUILDING));
  const game = clampPipelineValue(
    String(selection.game || '').toUpperCase(),
    RW_PIPELINE_GAME_OPTIONS,
    defaultSelection.game,
  );
  const category = clampPipelineValue(
    String(selection.category || ''),
    RW_PIPELINE_CATEGORY_OPTIONS,
    defaultSelection.category,
  );
  const platform = clampPipelineValue(
    String(selection.platform || '').toUpperCase(),
    getPlatformOptionsFor(category, game),
    defaultSelection.platform,
  );
  return {
    enabled: Boolean(selection.enabled),
    game,
    category,
    platform,
    ...(defaultSelection.config || selection?.config
      ? {
        config: {
          ...(defaultSelection.config || {}),
          ...(selection?.config || {}),
        },
      }
      : {}),
  };
}

export function cloneRWPipelineSelections(selections = RW_PIPELINE_SELECTION_DEFAULTS) {
  const next = {};
  for (const category of RW_PIPELINE_CATEGORY_OPTIONS) {
    next[category] = cloneRWPipelineSelection({
      ...getSelectionDefault(category),
      ...(selections?.[category] || {}),
      category,
    });
  }
  return next;
}

export function getRWPipelineGameOptions() {
  return [...RW_PIPELINE_GAME_OPTIONS];
}

export function getRWPipelineCategoryOptions() {
  return [...RW_PIPELINE_CATEGORY_OPTIONS];
}

export function getRWPipelinePlatformOptions(game, category = RW_PIPELINE_CATEGORY.BUILDING) {
  return [...getPlatformOptionsFor(category, game)];
}

export function resolveRWPipelineSelection(selection, worldGameVersion) {
  const normalized = cloneRWPipelineSelection(selection);
  const resolvedGame = normalized.game === RW_PIPELINE_GAME.DEFAULT
    ? clampPipelineValue(
      String(worldGameVersion || '').toUpperCase(),
      RW_PIPELINE_GAME_OPTIONS.filter((option) => option !== RW_PIPELINE_GAME.DEFAULT),
      RW_PIPELINE_GAME.VCS,
    )
    : normalized.game;

  const validPlatforms = getPlatformOptionsFor(normalized.category, resolvedGame);
  const resolvedPlatform = validPlatforms.includes(normalized.platform)
    ? normalized.platform
    : (validPlatforms[0] || RW_PIPELINE_PLATFORM.DEFAULT);

  return {
    ...normalized,
    game: resolvedGame,
    platform: resolvedPlatform,
  };
}

export function resolveRWPipelineSelections(selections, worldGameVersion) {
  const next = {};
  const normalizedSelections = cloneRWPipelineSelections(selections);
  for (const category of RW_PIPELINE_CATEGORY_OPTIONS) {
    next[category] = resolveRWPipelineSelection(normalizedSelections[category], worldGameVersion);
  }
  return next;
}
