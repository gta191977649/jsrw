import { VCS_WEATHER_NAMES } from '../utils/Timecycle.js';

function createDefaultTimecycleControls() {
  return {
    hour: 12,
    minute: 0,
    weatherA: 0,
    weatherB: 0,
    weatherBlend: 0,
    extraColour: -1,
    overrides: {},
  };
}

export function resolveTimecycleWeatherNames(data) {
  return Array.isArray(data?.weatherNames) && data.weatherNames.length > 0
    ? data.weatherNames
    : [...VCS_WEATHER_NAMES];
}

export function createWeatherTimecycleState(input = {}) {
  const data = input.data ?? null;
  const weatherNames = Array.isArray(input.weatherNames) && input.weatherNames.length > 0
    ? input.weatherNames
    : resolveTimecycleWeatherNames(data);

  return {
    sourcePath: input.sourcePath || '',
    data,
    weatherNames,
  };
}

export function createDefaultTimecycleState(input = {}) {
  const defaultControls = createDefaultTimecycleControls();
  const controls = input.controls && typeof input.controls === 'object'
    ? {
        ...defaultControls,
        ...input.controls,
        overrides: {
          ...defaultControls.overrides,
          ...(input.controls.overrides || {}),
        },
      }
    : defaultControls;
  const weatherNames = Array.isArray(input.weatherNames) && input.weatherNames.length > 0
    ? input.weatherNames
    : resolveTimecycleWeatherNames(input.data);

  return {
    sourcePath: input.sourcePath || '',
    data: input.data ?? null,
    current: input.current ?? null,
    weatherNames,
    controls,
  };
}
