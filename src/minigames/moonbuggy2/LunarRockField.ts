import * as THREE from 'three';
import { GLTFAssetLoader } from './GLTFAssetLoader';
import { PhotorealisticTerrain } from './PhotorealisticTerrain';

export interface LunarRock {
  id: string;
  position: THREE.Vector3;
  mesh: THREE.Object3D;
  collected: boolean;
  massKg: number;
}

export class LunarRockField {
  public readonly group: THREE.Group;
  public readonly rocks: LunarRock[] = [];
  private terrain: PhotorealisticTerrain;

  constructor(terrain: PhotorealisticTerrain, count = 48) {
    this.terrain = terrain;
    this.group = new THREE.Group();

    this.spawnRockField(count);
  }

  private async spawnRockField(count: number): Promise<void> {
    const loader = GLTFAssetLoader.getInstance();
    let rockTemplates: THREE.Mesh[] = [];

    try {
      const gltf = await loader.loadGLTF('/models/lunar_rocks.glb');
      gltf.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          rockTemplates.push((child as THREE.Mesh).clone());
        }
      });
    } catch (err) {
      console.warn('[LunarRockField] Failed to load lunar_rocks.glb, using procedural rocks', err);
    }

    // Fallback procedural rock geometry if GLB extraction returned no meshes
    if (rockTemplates.length === 0) {
      const fallbackMat = new THREE.MeshStandardMaterial({
        color: 0x475569,
        roughness: 0.9,
        metalness: 0.1,
        flatShading: true,
      });
      const geom = new THREE.DodecahedronGeometry(0.65, 1);
      const fallbackMesh = new THREE.Mesh(geom, fallbackMat);
      rockTemplates.push(fallbackMesh);
    }

    // Golden spiral distribution away from origin (0, 0) drop station
    for (let i = 0; i < count; i++) {
      const angle = (i * 137.5 * Math.PI) / 180;
      const radius = 16.0 + Math.pow(i / count, 0.7) * 160.0;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = this.terrain.calculateHeight(x, z);

      // Select rock variant
      const template = rockTemplates[i % rockTemplates.length];
      const rockMesh = template.clone();

      // Randomize scale and orientation
      const scale = 0.55 + Math.random() * 0.75;
      rockMesh.scale.set(scale, scale, scale);
      rockMesh.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI
      );
      rockMesh.position.set(x, y + 0.15 * scale, z);
      rockMesh.castShadow = true;
      rockMesh.receiveShadow = true;

      this.group.add(rockMesh);

      this.rocks.push({
        id: `rock-${i}`,
        position: rockMesh.position,
        mesh: rockMesh,
        collected: false,
        massKg: 35.0, // Spec 06: +35 kg per rock
      });
    }

    console.log(`[LunarRockField] Seeded ${this.rocks.length} basalt sample rocks across lunar surface`);
  }

  public getNearestUncollectedRock(pos: THREE.Vector3, maxDist = 4.0): LunarRock | null {
    let nearest: LunarRock | null = null;
    let nearestDistSq = maxDist * maxDist;

    for (const rock of this.rocks) {
      if (rock.collected) continue;
      const distSq = pos.distanceToSquared(rock.position);
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = rock;
      }
    }

    return nearest;
  }

  public collectRock(id: string): LunarRock | null {
    const rock = this.rocks.find((r) => r.id === id);
    if (!rock || rock.collected) return null;

    rock.collected = true;
    rock.mesh.visible = false;
    return rock;
  }
}
