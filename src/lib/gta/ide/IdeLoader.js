import { parseIde } from '../loaders/SectionLoader';

export class IdeLoader {
  async load(record) {
    return {
      sourcePath: record.resolvedPath,
      parsed: parseIde(await record.file.text()),
    };
  }
}
