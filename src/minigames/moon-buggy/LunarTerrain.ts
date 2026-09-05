import * as THREE from 'three';

export interface Crater {
  x: number;
  z: number;
  radius: number;
  depth: number;
}

export class LunarTerrain {
  readonly mesh: THREE.Mesh;
  private size: number;
  private resolution: number;
  private craters: Crater[] = [];

  constructor(size = 300, resolution = 150) {
    this.size = size;
    this.resolution = resolution;

    this.generateCraters();
    this.mesh = this.buildMesh();
  }

  private generateCraters(): void {
    // Seed a collection of authentic craters across the terrain
    const predefinedCraters: Crater[] = [
      { x: 0, z: 25, radius: 14, depth: 3.5 },
      { x: -35, z: -40, radius: 22, depth: 5.0 },
      { x: 45, z: -30, radius: 18, depth: 4.0 },
      { x: -50, z: 45, radius: 28, depth: 6.5 },
      { x: 30, z: 60, radius: 15, depth: 3.2 },
      { x: -70, z: -80, radius: 35, depth: 8.0 },
      { x: 60, z: 80, radius: 25, depth: 5.5 },
      { x: 0, z: -70, radius: 20, depth: 4.5 },
      { x: -80, z: 15, radius: 16, depth: 3.8 },
      { x: 75, z: -65, radius: 30, depth: 6.0 },
      { x: -20, z: 90, radius: 18, depth: 4.2 },
      { x: 85, z: 20, radius: 22, depth: 4.8 },
    ];
    this.craters.push(...predefinedCraters);

    // Minor procedural micro-craters
    for (let i = 0; i < 35; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 15 + Math.random() * (this.size * 0.45);
      const radius = 4 + Math.random() * 8;
      const depth = 1.0 + Math.random() * 2.0;
      this.craters.push({
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist,
        radius,
        depth,
      });
    }
  }

  public calculateHeight(x: number, z: number): number {
    // Gentle broad rolling lunar mare hills
    let h =
      Math.sin(x * 0.02) * Math.cos(z * 0.02) * 2.5 +
      Math.sin(x * 0.05 + z * 0.04) * 1.2 +
      Math.cos(x * 0.09 - z * 0.08) * 0.6;

    // Apply crater depressions with raised rims
    for (const c of this.craters) {
      const dx = x - c.x;
      const dz = z - c.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < c.radius * 1.5) {
        const normDist = dist / c.radius;
        if (normDist <= 1.0) {
          // Inner bowl depression (parabolic)
          const bowl = Math.cos((normDist * Math.PI) / 2);
          h -= Math.pow(bowl, 2) * c.depth;
        } else {
          // Elevated crater rim ejecta
          const rimDist = (normDist - 1.0) / 0.5; // 0 to 1
          const rimHeight = c.depth * 0.25 * Math.sin(rimDist * Math.PI);
          h += Math.max(0, rimHeight);
        }
      }
    }

    return h;
  }

  public getHeightAt(x: number, z: number): number {
    return this.calculateHeight(x, z);
  }

  public getNormalAt(x: number, z: number, delta = 0.5): THREE.Vector3 {
    const hL = this.calculateHeight(x - delta, z);
    const hR = this.calculateHeight(x + delta, z);
    const hD = this.calculateHeight(x, z - delta);
    const hU = this.calculateHeight(x, z + delta);

    const normal = new THREE.Vector3(hL - hR, 2 * delta, hD - hU).normalize();
    return normal;
  }

  private buildMesh(): THREE.Mesh {
    const geom = new THREE.PlaneGeometry(
      this.size,
      this.size,
      this.resolution,
      this.resolution
    );
    geom.rotateX(-Math.PI / 2);

    const pos = geom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = this.calculateHeight(x, z);
      pos.setY(i, y);
    }
    geom.computeVertexNormals();

    // Lunar regolith material: harsh retro matte, stark shading
    const mat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8, // Slate regolith grey
      roughness: 0.95,
      metalness: 0.05,
      flatShading: true, // Chunky retro polygon appearance
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.receiveShadow = true;
    return mesh;
  }
}
