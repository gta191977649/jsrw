import { VCS_WEATHER_NAMES } from '../../../Timecycle';

export class WeatherBuilder {
  async build(context) {
    const data = context.timecyc;
    const weatherNames = Array.isArray(data?.weatherNames) && data.weatherNames.length > 0
      ? data.weatherNames
      : [...VCS_WEATHER_NAMES];

    return {
      sourcePath: context.timecycSourcePath,
      data,
      weatherNames,
    };
  }
}
