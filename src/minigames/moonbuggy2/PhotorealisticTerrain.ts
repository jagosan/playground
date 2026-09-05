import * as THREE from 'three';

export interface CraterSpec {
  x: number;
  z: number;
  radius: number;
  depth: number;
}

export class PhotorealisticTerrain {
  readonly mesh: THREE.Mesh;
  public readonly size: number;
  private resolution: number;
  private craters: CraterSpec[] = [];

  constructor(size = 400, resolution = 200) {
    this.size = size;
    this.resolution = resolution;

    this.seedLunarLandscape();
    this.mesh = this.buildPBRTerrainMesh();
  }

  private seedLunarLandscape(): void {
    // Authentic Lunar Mare topography: prominent impact craters & undulating mare ridges
    const primaryCraters: CraterSpec[] = [
      { x: 0, z: 35, radius: 20, depth: 4.8 },
      { x: -45, z: -50, radius: 32, depth: 7.2 },
      { x: 60, z: -40, radius: 26, depth: 6.0 },
      { x: -70, z: 60, radius: 38, depth: 8.5 },
      { x: 40, z: 80, radius: 22, depth: 5.0 },
      { x: -90, z: -90, radius: 45, depth: 10.0 },
      { x: 85, z: 100, radius: 34, depth: 7.5 },
      { x: 0, z: -95, radius: 28, depth: 6.2 },
      { x: -110, z: 20, radius: 24, depth: 5.4 },
      { x: 105, z: -80, radius: 40, depth: 9.0 },
    ];
    this.craters.push(...primaryCraters);

    // Micro-craters scattering for authentic surface roughness
    for (let i = 0; i < 60; i++) {
      const angle = (i * 137.5 * Math.PI) / 180; // Golden angle distribution
      const dist = 18 + ((i * 5.5) % (this.size * 0.44));
      const radius = 3.5 + ((i * 1.3) % 7.5);
      const depth = 0.8 + ((i * 0.4) % 2.5);
      this.craters.push({
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist,
        radius,
        depth,
      });
    }
  }

  public calculateHeight(x: number, z: number): number {
    // Multi-octave fractional Brownian motion (fBm) approximation for lunar mare
    let h =
      Math.sin(x * 0.015) * Math.cos(z * 0.015) * 3.5 +
      Math.sin(x * 0.04 + z * 0.03) * 1.8 +
      Math.cos(x * 0.08 - z * 0.07) * 0.9 +
      Math.sin(x * 0.16 + z * 0.14) * 0.35;

    // Apply crater depressions with elevated rim ejecta
    for (let i = 0; i < this.craters.length; i++) {
      const c = this.craters[i];
      const dx = x - c.x;
      const dz = z - c.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < c.radius * 1.6) {
        const normDist = dist / c.radius;
        if (normDist <= 1.0) {
          // Inner bowl depression (cosine profile)
          const bowl = Math.cos((normDist * Math.PI) / 2);
          h -= Math.pow(bowl, 2.2) * c.depth;
        } else {
          // Elevated crater ejecta rim
          const rimDist = (normDist - 1.0) / 0.6;
          const rimHeight = c.depth * 0.28 * Math.sin(rimDist * Math.PI);
          h += Math.max(0, rimHeight);
        }
      }
    }

    return h;
  }

  public getHeightAt(x: number, z: number): number {
    return this.calculateHeight(x, z);
  }

  public getNormalAt(x: number, z: number, delta = 0.4): THREE.Vector3 {
    const hL = this.calculateHeight(x - delta, z);
    const hR = this.calculateHeight(x + delta, z);
    const hD = this.calculateHeight(x, z - delta);
    const hU = this.calculateHeight(x, z + delta);

    return new THREE.Vector3(hL - hR, 2 * delta, hD - hU).normalize();
  }

  private buildPBRTerrainMesh(): THREE.Mesh {
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

    // Generate procedural high-resolution regolith normal and roughness noise map
    let regolithTexture: THREE.Texture | null = null;
    if (typeof document !== 'undefined') {
      const noiseCanvas = document.createElement('canvas');
      noiseCanvas.width = 512;
      noiseCanvas.height = 512;
      const ctx = noiseCanvas.getContext('2d');
      if (ctx) {
        const imgData = ctx.createImageData(512, 512);
        for (let i = 0; i < imgData.data.length; i += 4) {
          // Subtle high-frequency lunar grain
          const n = Math.floor(128 + (Math.random() - 0.5) * 45);
          imgData.data[i] = n;     // R
          imgData.data[i + 1] = n; // G
          imgData.data[i + 2] = n; // B
          imgData.data[i + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
      }
      regolithTexture = new THREE.CanvasTexture(noiseCanvas);
      regolithTexture.wrapS = THREE.RepeatWrapping;
      regolithTexture.wrapT = THREE.RepeatWrapping;
      regolithTexture.repeat.set(40, 40);
    }

    // Photorealistic PBR Material: High roughness, Hapke backscatter approximation, zero specular shine
    const mat = new THREE.MeshStandardMaterial({
      color: 0x8a929e, // Authentic lunar basalt regolith
      roughness: 0.94,
      metalness: 0.08,
      bumpMap: regolithTexture,
      bumpScale: 0.15,
      flatShading: false,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
  }
}
