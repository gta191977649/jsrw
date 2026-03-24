import { createWeatherTimecycleState } from '../../../core/TimecycleState.js';

export class WeatherBuilder {
  async build(context) {
    return createWeatherTimecycleState({
      sourcePath: context.timecycSourcePath,
      data: context.timecyc,
    });
  }
}
