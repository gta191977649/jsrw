import * as THREE from 'three';

const TMP_NDC = new THREE.Vector3();
const TMP_VIEW = new THREE.Vector3();

export function createRwSpriteMaterial(map) {
  return new THREE.SpriteMaterial({
    map,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

export function prepareRwSpriteTexture(texture) {
  if (!texture?.isTexture) return null;
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function setRwSpriteScreenPosition(sprite, screenX, screenY, viewportWidth, viewportHeight, widthPx, heightPx) {
  sprite.position.set(
    screenX - (viewportWidth * 0.5),
    (viewportHeight * 0.5) - screenY,
    0,
  );
  sprite.scale.set(widthPx, heightPx, 1);
}

export function rwScreenFromNdc(ndc, viewportWidth, viewportHeight) {
  return {
    x: (ndc.x * 0.5 + 0.5) * viewportWidth,
    y: (-ndc.y * 0.5 + 0.5) * viewportHeight,
  };
}

export function calcScreenCoorsLikeRw(camera, worldPosition, viewportWidth, viewportHeight, farClip = true) {
  TMP_VIEW.copy(worldPosition).applyMatrix4(camera.matrixWorldInverse);
  const cameraZ = -TMP_VIEW.z;
  if (cameraZ <= camera.near + 1.0) return null;
  if (farClip && cameraZ >= camera.far) return null;

  TMP_NDC.copy(worldPosition).project(camera);
  const screen = rwScreenFromNdc(TMP_NDC, viewportWidth, viewportHeight);
  const halfHeightScale = viewportHeight / (2 * cameraZ * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
  return {
    x: screen.x,
    y: screen.y,
    z: cameraZ,
    recipZ: 1 / cameraZ,
    spriteW: halfHeightScale,
    spriteH: halfHeightScale,
  };
}

