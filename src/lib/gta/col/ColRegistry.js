export class ColRegistry {
  constructor() {
    this.records = [];
  }

  add(record) {
    this.records.push(record);
  }

  getAll() {
    return this.records;
  }
}
