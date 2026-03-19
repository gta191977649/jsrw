import * as THREE from 'three';

export class ThreeDffFactory {
  constructor(options = {}) {
    this.textureDictionary = options.textureDictionary || null;
    this.path = options.path || '';
  }

  setTextureDictionary(textures) {
    this.textureDictionary = textures;
    return this;
  }

  create(clump) {
    const group = new THREE.Group();
    if (!clump) return group;

    const meshes = [];
    const meshesByGeometry = [];

    clump.RWGeometryList.forEach((rwGeometry) => {
      const binMesh = rwGeometry.RWExtension?.CHUNK_BINMESH;
      const materialSplits = [];

      if (binMesh?.splits?.length > 0) {
        const hasEmbeddedIndices = binMesh.splits.some((split) => split.indices && split.indices.length > 0);
        if (hasEmbeddedIndices) {
          binMesh.splits.forEach((split) => {
            if (!split.indices?.length) return;
            const triangles = [];
            if (binMesh.faceType === 0) {
              for (let j = 0; j < split.indices.length; j += 3) triangles.push([split.indices[j], split.indices[j + 1], split.indices[j + 2]]);
            } else {
              for (let j = 0; j < split.indices.length - 2; j += 1) {
                if (j % 2 === 0) triangles.push([split.indices[j], split.indices[j + 1], split.indices[j + 2]]);
                else triangles.push([split.indices[j + 1], split.indices[j], split.indices[j + 2]]);
              }
            }
            materialSplits.push({ matIndex: split.matIndex, triangles });
          });
        } else {
          let triangleOffset = 0;
          binMesh.splits.forEach((split) => {
            const numTriangles = Math.floor((split.numIndices || 0) / 3);
            const triangles = [];
            for (let j = 0; j < numTriangles && (triangleOffset + j) < rwGeometry.triangles.length; j += 1) {
              const tri = rwGeometry.triangles[triangleOffset + j];
              triangles.push([tri.vertex1, tri.vertex2, tri.vertex3]);
            }
            if (triangles.length > 0) materialSplits.push({ matIndex: split.matIndex, triangles });
            triangleOffset += numTriangles;
          });
        }
      }

      if (materialSplits.length === 0) {
        const triangleGroups = {};
        rwGeometry.triangles.forEach((triangle) => {
          const matId = triangle.materialId || 0;
          if (!triangleGroups[matId]) triangleGroups[matId] = [];
          triangleGroups[matId].push([triangle.vertex1, triangle.vertex2, triangle.vertex3]);
        });
        Object.entries(triangleGroups).forEach(([matIndex, triangles]) => {
          materialSplits.push({ matIndex: Number(matIndex), triangles });
        });
      }

      const hasNormals = rwGeometry.morphTargets[0].hasNormals;
      const hasColors = Boolean(rwGeometry.prelitcolor);
      const hasUVs = Boolean(rwGeometry.texCoords);

      const materials = rwGeometry.RWMaterialList.map((material) => this.createMaterial(material.RWMaterial, hasColors));

      const geometryMeshes = [];
      for (const split of materialSplits) {
        const triangleCount = split.triangles.length;
        if (triangleCount <= 0) continue;

        const geometry = new THREE.BufferGeometry();
        const positionBuffer = new THREE.BufferAttribute(new Float32Array(triangleCount * 9), 3);
        const normalBuffer = hasNormals ? new THREE.BufferAttribute(new Float32Array(triangleCount * 9), 3) : null;
        const colorBuffer = hasColors ? new THREE.BufferAttribute(new Float32Array(triangleCount * 12), 4) : null;
        const uvBuffer = hasUVs ? new THREE.BufferAttribute(new Float32Array(triangleCount * 6), 2) : null;
        const newVertexIndices = {};

        let vertexPos = 0;
        for (const indices of split.triangles) {
          for (const index of indices) {
            const vertex = rwGeometry.morphTargets[0].vertices[index];
            positionBuffer.setXYZ(vertexPos, vertex.x, vertex.y, vertex.z);
            if (!newVertexIndices[index]) newVertexIndices[index] = [];
            newVertexIndices[index].push(vertexPos);
            if (normalBuffer) {
              const normal = rwGeometry.morphTargets[0].normals[index];
              normalBuffer.setXYZ(vertexPos, normal.x, normal.y, normal.z);
            }
            if (uvBuffer) {
              const uv = rwGeometry.texCoords[0][index];
              uvBuffer.setXY(vertexPos, uv.u, uv.v);
            }
            if (colorBuffer) {
              const color = rwGeometry.prelitcolor[index];
              colorBuffer.setXYZW(vertexPos, color.r / 255, color.g / 255, color.b / 255, color.a / 255);
            }
            vertexPos += 1;
          }
        }

        geometry.setAttribute('position', positionBuffer);
        if (normalBuffer) geometry.setAttribute('normal', normalBuffer);
        else geometry.computeVertexNormals();
        if (colorBuffer) geometry.setAttribute('color', colorBuffer);
        if (uvBuffer) geometry.setAttribute('uv', uvBuffer);
        geometry.computeBoundingSphere();

        if (rwGeometry.RWExtension?.CHUNK_SKIN) {
          const skinExtension = rwGeometry.RWExtension.CHUNK_SKIN;
          const indicesBuffer = new THREE.Float32BufferAttribute(new Float32Array(positionBuffer.count * 4), 4);
          const weightsBuffer = new THREE.Float32BufferAttribute(new Float32Array(positionBuffer.count * 4), 4);
          for (let index = 0; index < rwGeometry.numVertices; index += 1) {
            if (!newVertexIndices[index]) continue;
            newVertexIndices[index].forEach((newIndex) => {
              const boneIndices = skinExtension.vertexBoneIndices[index];
              const boneWeights = skinExtension.vertexBoneWeights[index];
              indicesBuffer.setXYZW(newIndex, boneIndices.x, boneIndices.y, boneIndices.z, boneIndices.w);
              weightsBuffer.setXYZW(newIndex, boneWeights.x, boneWeights.y, boneWeights.z, boneWeights.w);
            });
          }
          geometry.setAttribute('skinIndex', indicesBuffer);
          geometry.setAttribute('skinWeight', weightsBuffer);
        }

        const meshEntry = { geometry, material: materials[split.matIndex], materialIndex: split.matIndex };
        geometryMeshes.push(meshEntry);
        meshes.push(meshEntry);
      }
      meshesByGeometry.push(geometryMeshes);
    });

    clump.RWAtomicList.forEach((atomic) => {
      const geometryMeshes = meshesByGeometry[atomic.geometryIndex];
      if (!geometryMeshes?.length) return;

      const nodelist = new Array(clump.RWFrameList.length);
      let nodeInfo = null;
      let parentNode = null;

      clump.RWFrameList.forEach((frame, i) => {
        const rwFrame = frame.RWFrame;
        const bone = new THREE.Bone();
        bone.name = frame.RWExtension?.CHUNK_FRAME || `bone_${i}`;
        const transform = new THREE.Matrix4();
        transform.set(
          rwFrame.rotationMatrix[0], rwFrame.rotationMatrix[3], rwFrame.rotationMatrix[6], rwFrame.position[0],
          rwFrame.rotationMatrix[1], rwFrame.rotationMatrix[4], rwFrame.rotationMatrix[7], rwFrame.position[1],
          rwFrame.rotationMatrix[2], rwFrame.rotationMatrix[5], rwFrame.rotationMatrix[8], rwFrame.position[2],
          0, 0, 0, 1,
        );
        bone.applyMatrix4(transform);
        if (rwFrame.parentIndex >= 0 && nodelist[rwFrame.parentIndex]) nodelist[rwFrame.parentIndex].add(bone);
        const hAnim = frame.RWExtension?.CHUNK_HANIM;
        if (hAnim) {
          bone.userData.nodeId = hAnim.nodeId;
          bone.userData.nodeIndex = i;
          if (hAnim.numNodes > 0) {
            parentNode = bone;
            nodeInfo = hAnim.nodes.map((node, idx) => ({ id: node.nodeId, index: idx, flags: node.flags, frame: null }));
          }
        }
        nodelist[i] = bone;
      });

      if (nodeInfo) {
        const bones = new Array(nodeInfo.length);
        const getIndex = (node) => nodeInfo.findIndex((entry) => entry.node === node);
        const findUnattachedById = (node, id, visited = new Set()) => {
          if (!node || visited.has(node)) return null;
          visited.add(node);
          if (node.userData.nodeId >= 0 && node.userData.nodeId === id && getIndex(node) === -1) return node;
          for (const child of node.children) {
            const found = findUnattachedById(child, id, visited);
            if (found) return found;
          }
          const nextIndex = node.userData.nodeIndex + 1;
          if (nextIndex < nodelist.length) return findUnattachedById(nodelist[nextIndex], id, visited);
          return null;
        };
        for (let i = 0; i < nodeInfo.length; i += 1) {
          nodeInfo[i].node = findUnattachedById(parentNode, nodeInfo[i].id);
          bones[i] = nodeInfo[i].node;
        }
        if (bones.every((bone) => bone !== null)) {
          for (const meshData of geometryMeshes) meshData.skeleton = new THREE.Skeleton(bones);
        }
      }
    });

    meshes.forEach((meshData) => {
      let mesh;
      if (meshData.skeleton) {
        mesh = new THREE.SkinnedMesh(meshData.geometry, meshData.material);
        mesh.add(meshData.skeleton.bones[0]);
        mesh.bind(meshData.skeleton);
      } else {
        mesh = new THREE.Mesh(meshData.geometry, meshData.material);
      }
      mesh.userData = {
        ...(mesh.userData || {}),
        rwMaterialIndex: meshData.materialIndex,
      };
      mesh.rotation.set(-Math.PI / 2, 0, Math.PI);
      group.add(mesh);
    });

    return group;
  }

  createMaterial(matData, hasColors) {
    const result = new THREE.MeshStandardMaterial({
      vertexColors: hasColors,
      roughness: matData.diffuse !== undefined ? matData.diffuse : 0.8,
      metalness: 0.1,
      color: new THREE.Color(matData.color.r / 255, matData.color.g / 255, matData.color.b / 255),
      transparent: matData.color.a < 255,
      opacity: matData.color.a / 255,
    });
    result.userData = {
      ...(result.userData || {}),
      textureName: matData.RWTexture?.name || '',
      maskName: matData.RWTexture?.maskName || '',
      rwSurfaceProps: {
        ambient: Number.isFinite(matData.ambient) ? matData.ambient : 1,
        specular: Number.isFinite(matData.specular) ? matData.specular : 0,
        diffuse: Number.isFinite(matData.diffuse) ? matData.diffuse : 1,
      },
      rwSourceMaterial: {
        color: { ...matData.color },
        isTextured: Boolean(matData.isTextured),
      },
    };

    const applyAlphaMode = (alphaMode, alphaRef = 0.5) => {
      if (alphaMode === 'cutout') {
        result.transparent = false;
        result.alphaTest = alphaRef;
        result.depthWrite = true;
        return;
      }
      if (alphaMode === 'blend' || alphaMode === 'additive') {
        result.transparent = true;
        result.alphaTest = 0;
        result.depthWrite = false;
      }
    };

    if (matData.isTextured && matData.RWTexture) {
      const textureName = matData.RWTexture.name;
      const maskName = matData.RWTexture.maskName;
      if (textureName && this.textureDictionary) {
        const txdEntry = this.textureDictionary.get(textureName.toLowerCase());
        if (txdEntry) {
          const txdTexture = txdEntry.texture || txdEntry;
          result.map = txdTexture.clone();
          const textureAlphaMode = txdTexture?.userData?.rwAlphaMode
            || txdEntry?.texture?.userData?.rwAlphaMode
            || (txdEntry.hasAlpha ? 'blend' : 'opaque');
          applyAlphaMode(textureAlphaMode, 0.5);
          result.map.needsUpdate = true;
        }
      }

      if (!result.map && textureName) {
        const textureLoader = new THREE.TextureLoader();
        if (this.path) textureLoader.setPath(this.path);
        result.map = textureLoader.load(
          `${textureName}.png`,
          () => { result.needsUpdate = true; },
          undefined,
          () => {
            result.map = textureLoader.load(
              `${textureName}.jpg`,
              () => { result.needsUpdate = true; },
              undefined,
              () => {
                result.map = textureLoader.load(`${textureName}.bmp`, () => { result.needsUpdate = true; });
              },
            );
          },
        );
      }

      if (result.map) {
        result.map.wrapS = THREE.RepeatWrapping;
        result.map.wrapT = THREE.RepeatWrapping;
        result.map.colorSpace = THREE.SRGBColorSpace;
      }

      if (maskName) {
        if (this.textureDictionary) {
          const txdMask = this.textureDictionary.get(maskName.toLowerCase());
          if (txdMask) {
            const txdMaskTexture = txdMask.texture || txdMask;
            result.alphaMap = txdMaskTexture.clone();
            result.alphaMap.needsUpdate = true;
          }
        }
        if (!result.alphaMap) {
          const textureLoader = new THREE.TextureLoader();
          if (this.path) textureLoader.setPath(this.path);
          result.alphaMap = textureLoader.load(`${maskName}.png`, () => { result.needsUpdate = true; });
        }
        if (result.alphaMap) {
          result.alphaMap.wrapS = THREE.RepeatWrapping;
          result.alphaMap.wrapT = THREE.RepeatWrapping;
          const maskAlphaMode = result.alphaMap.userData?.rwAlphaMode || 'cutout';
          applyAlphaMode(maskAlphaMode, maskAlphaMode === 'blend' ? 0 : 0.5);
        }
      }
    }

    return result;
  }
}

export default ThreeDffFactory;
