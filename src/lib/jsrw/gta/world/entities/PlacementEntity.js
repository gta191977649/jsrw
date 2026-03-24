export function getPlacementModelName(placement) {
  return String(placement?.modelName || '').trim().toLowerCase();
}

export function getPlacementPosition(placement) {
  return {
    x: Number(placement?.position?.x) || 0,
    y: Number(placement?.position?.y) || 0,
    z: Number(placement?.position?.z) || 0,
  };
}

export function createPlacementEntity(placement, index = -1) {
  return {
    index,
    id: placement?.id ?? null,
    modelName: getPlacementModelName(placement),
    position: getPlacementPosition(placement),
    placement: placement || null,
  };
}
