export class IplRegistry {
  constructor() {
    this.placements = [];
    this.files = [];
  }

  addPlacements(sourcePath, placements) {
    const baseIndex = this.placements.length;
    const normalizedPlacements = [];

    for (const placement of placements || []) {
      const normalizedLod = Number.isInteger(placement.lod) && placement.lod >= 0
        ? placement.lod + baseIndex
        : -1;
      normalizedPlacements.push({
        ...placement,
        lod: normalizedLod,
        sourcePath,
      });
    }

    this.files.push({
      sourcePath,
      count: normalizedPlacements.length,
      baseIndex,
    });
    this.placements.push(...normalizedPlacements);
  }

  getAll() {
    return this.placements;
  }

  get size() {
    return this.placements.length;
  }
}
