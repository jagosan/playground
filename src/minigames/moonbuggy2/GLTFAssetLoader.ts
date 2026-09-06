import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class GLTFAssetLoader {
  private static instance: GLTFAssetLoader;
  private loader: GLTFLoader;
  private cache: Map<string, THREE.Group> = new Map();
  private loadingPromises: Map<string, Promise<THREE.Group>> = new Map();

  private constructor() {
    this.loader = new GLTFLoader();
  }

  public static getInstance(): GLTFAssetLoader {
    if (!GLTFAssetLoader.instance) {
      GLTFAssetLoader.instance = new GLTFAssetLoader();
    }
    return GLTFAssetLoader.instance;
  }

  public async loadGLTF(url: string): Promise<THREE.Group> {
    const cached = this.cache.get(url);
    if (cached) {
      return cached.clone(true);
    }

    const pending = this.loadingPromises.get(url);
    if (pending) {
      const group = await pending;
      return group.clone(true);
    }

    const promise = new Promise<THREE.Group>((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => {
          const root = gltf.scene;
          root.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const mesh = child as THREE.Mesh;
              mesh.castShadow = true;
              mesh.receiveShadow = true;
              if (mesh.material) {
                const fixRoughness = (m: THREE.Material) => {
                  if ('roughness' in m) {
                    (m as THREE.MeshStandardMaterial).roughness = Math.max(
                      (m as THREE.MeshStandardMaterial).roughness ?? 0.5,
                      0.2
                    );
                  }
                };
                if (Array.isArray(mesh.material)) {
                  mesh.material.forEach(fixRoughness);
                } else {
                  fixRoughness(mesh.material);
                }
              }
            }
          });
          this.cache.set(url, root);
          resolve(root);
        },
        undefined,
        (error) => {
          console.warn(`[GLTFAssetLoader] Failed to load ${url}:`, error);
          reject(error);
        }
      );
    });

    this.loadingPromises.set(url, promise);
    try {
      const result = await promise;
      return result.clone(true);
    } finally {
      this.loadingPromises.delete(url);
    }
  }
}
