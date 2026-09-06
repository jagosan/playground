import * as THREE from 'three';
import { GLTFAssetLoader } from './GLTFAssetLoader';
import { PhotorealisticTerrain } from './PhotorealisticTerrain';

export class ScienceDropStation {
  public readonly group: THREE.Group;
  public readonly position = new THREE.Vector3(0, 0, 0);
  public readonly dockingRadius = 6.0;

  private dockingRing: THREE.Mesh;
  private beaconLight: THREE.PointLight;
  private radarDishNode: THREE.Object3D | null = null;
  private ringMaterial: THREE.MeshBasicMaterial;
  private pulseTime = 0;

  constructor(terrain: PhotorealisticTerrain) {
    this.group = new THREE.Group();

    const spawnY = terrain.calculateHeight(0, 0);
    this.position.set(0, spawnY, 0);
    this.group.position.copy(this.position);

    // Glowing Docking Beacon Ring at radius 6.0m
    const ringGeom = new THREE.RingGeometry(5.8, 6.2, 48);
    ringGeom.rotateX(-Math.PI / 2);
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x0284c7,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });
    this.dockingRing = new THREE.Mesh(ringGeom, this.ringMaterial);
    this.dockingRing.position.y = 0.08;
    this.group.add(this.dockingRing);

    // Cyan Strobe Beacon Light
    this.beaconLight = new THREE.PointLight(0x38bdf8, 3.5, 25);
    this.beaconLight.position.set(0, 4.5, 0);
    this.group.add(this.beaconLight);

    // Load Drop Station GLB
    this.loadDropStationGLTF();
  }

  private async loadDropStationGLTF(): Promise<void> {
    try {
      const loader = GLTFAssetLoader.getInstance();
      const gltf = await loader.loadGLTF('/models/lunar_drop_station.glb');
      
      // Look for radar dish node
      gltf.traverse((child) => {
        if (child.name.toLowerCase().includes('dish') || child.name.toLowerCase().includes('radar')) {
          this.radarDishNode = child;
        }
      });

      this.group.add(gltf);
      console.log('[ScienceDropStation] Drop station GLB loaded at (0, 0)');
    } catch (err) {
      console.warn('[ScienceDropStation] Failed to load lunar_drop_station.glb, building fallback', err);
      // Fallback base structure
      const baseMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        roughness: 0.4,
        metalness: 0.8,
      });
      const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.0, 1.8, 16), baseMat);
      cylinder.position.y = 0.9;
      cylinder.castShadow = true;
      this.group.add(cylinder);
    }
  }

  public isInDockingZone(roverPos: THREE.Vector3): boolean {
    const dx = roverPos.x - this.position.x;
    const dz = roverPos.z - this.position.z;
    return dx * dx + dz * dz <= this.dockingRadius * this.dockingRadius;
  }

  public update(delta: number): void {
    this.pulseTime += delta;

    // Pulse docking ring opacity and color
    const pulse = 0.6 + 0.4 * Math.sin(this.pulseTime * 3.5);
    this.ringMaterial.opacity = pulse;

    // Slowly rotate radar dish if present
    if (this.radarDishNode) {
      this.radarDishNode.rotation.y += delta * 0.8;
    }
  }
}
