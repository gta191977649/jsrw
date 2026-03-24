export class MapZoneLoader {
  async load(record) {
    return {
      sourcePath: record.resolvedPath,
      raw: await record.file.text(),
    };
  }
}
