import * as THREE from 'three';

export interface CraterSpec {
  x: number;
  z: number;
  radius: number;
  depth: number;
}

export interface RoadSample {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  bankAngle: number;
  centerlineHeight: number;
}

export interface RoadQuery {
  dist: number;
  lateralOffset: number;
  bankAngle: number;
  centerlineHeight: number;
}

export class PhotorealisticTerrain {
  readonly mesh: THREE.Mesh;
  public roadMesh: THREE.Mesh | null = null;
  public readonly size: number;
  private resolution: number;
  private craters: CraterSpec[] = [];

  // Bulldozed Road Network
  public readonly roadWidth = 8.0;
  public readonly roadBlendMargin = 4.5;
  private roadSamples: RoadSample[] = [];
  private roadSpatialGrid: Map<string, number[]> = new Map();
  private readonly roadCellSize = 16.0;

  constructor(size = 400, resolution = 200) {
    this.size = size;
    this.resolution = resolution;

    this.seedLunarLandscape();
    this.initBulldozedRoadNetwork();
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

  private initBulldozedRoadNetwork(): void {
    // 12-point sweeping circuit through the lunar mare, looping around craters and connecting to the base
    const waypoints = [
      new THREE.Vector3(0.0, 0, 0.0),      // Drop Station straightaway
      new THREE.Vector3(22.0, 0, -35.0),   // Turn past mare ridge
      new THREE.Vector3(54.0, 0, -68.0),   // High speed sweep
      new THREE.Vector3(94.0, 0, -42.0),   // Banked bowl turn 1
      new THREE.Vector3(106.0, 0, 12.0),   // East straight
      new THREE.Vector3(80.0, 0, 68.0),    // South-east curve
      new THREE.Vector3(24.0, 0, 96.0),    // Southern fast bend
      new THREE.Vector3(-28.0, 0, 80.0),   // Chicane
      new THREE.Vector3(-68.0, 0, 54.0),   // Banked carousel curve 2
      new THREE.Vector3(-86.0, 0, 6.0),    // West straight
      new THREE.Vector3(-66.0, 0, -38.0),  // North-west return
      new THREE.Vector3(-25.0, 0, -20.0),  // Approach to base
    ];

    const curve = new THREE.CatmullRomCurve3(waypoints, true, 'centripetal');
    const numSteps = 300;
    const pts = curve.getSpacedPoints(numSteps);

    this.roadSamples = [];
    for (let i = 0; i < numSteps; i++) {
      const p = pts[i];
      const nextP = pts[(i + 1) % numSteps];
      const prevP = pts[(i - 1 + numSteps) % numSteps];

      const tangent = new THREE.Vector3().subVectors(nextP, prevP).normalize();
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

      // Signed curvature across road direction
      const turn = tangent.x * (nextP.z - p.z) - tangent.z * (nextP.x - p.x);
      const bankAngle = Math.max(-0.25, Math.min(0.25, turn * 75.0));

      // Graded centerline elevation (filtered lunar base height)
      const baseH = this.calculateBaseLunarHeight(p.x, p.z);

      this.roadSamples.push({
        position: p,
        tangent,
        normal,
        bankAngle,
        centerlineHeight: baseH,
      });
    }

    // Smooth centerline elevations along the road loop to simulate bulldozer grading
    const smoothedHeights = new Float32Array(numSteps);
    const kernel = 5;
    for (let i = 0; i < numSteps; i++) {
      let sum = 0;
      let count = 0;
      for (let k = -kernel; k <= kernel; k++) {
        const idx = (i + k + numSteps) % numSteps;
        const weight = 1.0 - Math.abs(k) / (kernel + 1);
        sum += this.roadSamples[idx].centerlineHeight * weight;
        count += weight;
      }
      smoothedHeights[i] = sum / count;
    }
    for (let i = 0; i < numSteps; i++) {
      this.roadSamples[i].centerlineHeight = smoothedHeights[i];
      this.roadSamples[i].position.y = smoothedHeights[i];
    }

    // Build 2D spatial hash grid for <1 microsecond queries
    this.roadSpatialGrid.clear();
    for (let i = 0; i < numSteps; i++) {
      const p1 = this.roadSamples[i].position;
      const p2 = this.roadSamples[(i + 1) % numSteps].position;

      const minX = Math.floor(Math.min(p1.x, p2.x) / this.roadCellSize);
      const maxX = Math.floor(Math.max(p1.x, p2.x) / this.roadCellSize);
      const minZ = Math.floor(Math.min(p1.z, p2.z) / this.roadCellSize);
      const maxZ = Math.floor(Math.max(p1.z, p2.z) / this.roadCellSize);

      for (let cx = minX - 1; cx <= maxX + 1; cx++) {
        for (let cz = minZ - 1; cz <= maxZ + 1; cz++) {
          const key = `${cx},${cz}`;
          let cell = this.roadSpatialGrid.get(key);
          if (!cell) {
            cell = [];
            this.roadSpatialGrid.set(key, cell);
          }
          cell.push(i);
        }
      }
    }
  }

  public getRoadInfo(x: number, z: number): RoadQuery {
    const cx = Math.floor(x / this.roadCellSize);
    const cz = Math.floor(z / this.roadCellSize);
    const key = `${cx},${cz}`;
    const indices = this.roadSpatialGrid.get(key);

    let bestDistSq = 999999;
    let bestT = 0;
    let bestIdx = 0;

    if (indices && indices.length > 0) {
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        const p1 = this.roadSamples[i].position;
        const p2 = this.roadSamples[(i + 1) % this.roadSamples.length].position;

        const segX = p2.x - p1.x;
        const segZ = p2.z - p1.z;
        const lenSq = segX * segX + segZ * segZ;
        if (lenSq < 1e-6) continue;

        let t = ((x - p1.x) * segX + (z - p1.z) * segZ) / lenSq;
        t = Math.max(0, Math.min(1, t));

        const projX = p1.x + t * segX;
        const projZ = p1.z + t * segZ;
        const dx = x - projX;
        const dz = z - projZ;
        const distSq = dx * dx + dz * dz;

        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestT = t;
          bestIdx = i;
        }
      }
    }

    const dist = Math.sqrt(bestDistSq);
    if (dist > 25.0) {
      return { dist, lateralOffset: 0, bankAngle: 0, centerlineHeight: 0 };
    }

    const nextIdx = (bestIdx + 1) % this.roadSamples.length;
    const s1 = this.roadSamples[bestIdx];
    const s2 = this.roadSamples[nextIdx];

    const normalX = (1 - bestT) * s1.normal.x + bestT * s2.normal.x;
    const normalZ = (1 - bestT) * s1.normal.z + bestT * s2.normal.z;
    const projX = (1 - bestT) * s1.position.x + bestT * s2.position.x;
    const projZ = (1 - bestT) * s1.position.z + bestT * s2.position.z;

    const lateralOffset = (x - projX) * normalX + (z - projZ) * normalZ;
    const bankAngle = (1 - bestT) * s1.bankAngle + bestT * s2.bankAngle;
    const centerlineHeight = (1 - bestT) * s1.centerlineHeight + bestT * s2.centerlineHeight;

    return {
      dist,
      lateralOffset,
      bankAngle,
      centerlineHeight,
    };
  }

  public calculateBaseLunarHeight(x: number, z: number): number {
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

  public calculateHeight(x: number, z: number): number {
    const hBase = this.calculateBaseLunarHeight(x, z);
    const road = this.getRoadInfo(x, z);

    const halfW = this.roadWidth * 0.5; // 4.0m
    const maxInfluence = halfW + this.roadBlendMargin; // 8.5m

    if (road.dist < maxInfluence) {
      // Superelevation (banking) tilting inward on curves
      const bankHeight = -road.lateralOffset * Math.sin(road.bankAngle);
      // Slight bulldozer crown in center and blade edge berm
      const uFrac = Math.min(1.0, Math.abs(road.lateralOffset) / halfW);
      const crown = (1.0 - uFrac * uFrac) * 0.08;
      const hRoad = road.centerlineHeight + bankHeight + crown;

      if (road.dist <= halfW) {
        return hRoad;
      } else {
        // Smoothstep cubic hermite transition to natural regolith
        const t = (road.dist - halfW) / this.roadBlendMargin;
        const blend = t * t * (3.0 - 2.0 * t);
        return (1.0 - blend) * hRoad + blend * hBase;
      }
    }

    return hBase;
  }

  public getHeightAt(x: number, z: number): number {
    return this.calculateHeight(x, z);
  }

  public getNormalAt(x: number, z: number, delta = 0.35): THREE.Vector3 {
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
          const n = Math.floor(128 + (Math.random() - 0.5) * 45);
          imgData.data[i] = n;
          imgData.data[i + 1] = n;
          imgData.data[i + 2] = n;
          imgData.data[i + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
      }
      regolithTexture = new THREE.CanvasTexture(noiseCanvas);
      regolithTexture.wrapS = THREE.RepeatWrapping;
      regolithTexture.wrapT = THREE.RepeatWrapping;
      regolithTexture.repeat.set(40, 40);
    }

    // Photorealistic PBR Material: High roughness, Hapke backscatter approximation
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

    // Build the 3D visual Bulldozed Dirt Road Ribbon Mesh
    this.roadMesh = this.buildRoadRibbonMesh();
    if (this.roadMesh) {
      mesh.add(this.roadMesh);
    }

    return mesh;
  }

  private buildRoadRibbonMesh(): THREE.Mesh {
    const numSteps = this.roadSamples.length;
    const numCols = 6;
    const roadWidth = this.roadWidth;

    const vertices: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= numSteps; i++) {
      const idx = i % numSteps;
      const sample = this.roadSamples[idx];
      const p = sample.position;
      const norm = sample.normal;

      for (let c = 0; c < numCols; c++) {
        const uFrac = c / (numCols - 1);
        const u = (uFrac - 0.5) * roadWidth;

        const vx = p.x + norm.x * u;
        const vz = p.z + norm.z * u;
        // Float 3.5cm above terrain to eliminate z-fighting
        const vy = this.calculateHeight(vx, vz) + 0.035;

        vertices.push(vx, vy, vz);
        uvs.push(uFrac, i * 0.25);
      }
    }

    for (let i = 0; i < numSteps; i++) {
      for (let c = 0; c < numCols - 1; c++) {
        const row1 = i * numCols;
        const row2 = (i + 1) * numCols;
        indices.push(row1 + c, row2 + c, row1 + c + 1);
        indices.push(row1 + c + 1, row2 + c, row2 + c + 1);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    // Compacted lunar dirt road texture with tire ruts and grader marks
    let roadTexture: THREE.Texture | null = null;
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Base excavated dark lunar mare basalt
        ctx.fillStyle = '#181b20';
        ctx.fillRect(0, 0, 256, 256);

        // Grader blade longitudinal striations
        ctx.strokeStyle = '#252a32';
        ctx.lineWidth = 3;
        for (let y = 0; y < 256; y += 8) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(256, y);
          ctx.stroke();
        }

        // Two deep dark tire/tread ruts (compacted crushed basalt)
        ctx.fillStyle = '#0f1114';
        ctx.fillRect(45, 0, 40, 256);
        ctx.fillRect(170, 0, 40, 256);

        // Surface basalt gravel grain
        const imgData = ctx.getImageData(0, 0, 256, 256);
        for (let i = 0; i < imgData.data.length; i += 4) {
          const noise = (Math.random() - 0.5) * 14;
          imgData.data[i] = Math.min(255, Math.max(0, imgData.data[i] + noise));
          imgData.data[i + 1] = Math.min(255, Math.max(0, imgData.data[i + 1] + noise));
          imgData.data[i + 2] = Math.min(255, Math.max(0, imgData.data[i + 2] + noise));
        }
        ctx.putImageData(imgData, 0, 0);
      }
      roadTexture = new THREE.CanvasTexture(canvas);
      roadTexture.wrapS = THREE.RepeatWrapping;
      roadTexture.wrapT = THREE.RepeatWrapping;
      roadTexture.repeat.set(1, 24);
    }

    const roadMat = new THREE.MeshStandardMaterial({
      color: 0x242830, // Deep dark lunar mare basalt under surface dust
      map: roadTexture,
      roughness: 0.94,
      metalness: 0.18,
      flatShading: false,
    });

    const roadMesh = new THREE.Mesh(geom, roadMat);
    roadMesh.receiveShadow = true;
    roadMesh.castShadow = false;
    return roadMesh;
  }
}
