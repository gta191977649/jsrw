export class ObjectDatLoader {
  async load(record) {
    return {
      sourcePath: record.resolvedPath,
      raw: await record.file.text(),
    };
  }
}
