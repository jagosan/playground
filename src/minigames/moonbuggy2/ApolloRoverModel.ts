import * as THREE from 'three';
import { GLTFAssetLoader } from './GLTFAssetLoader';

export interface ApolloRoverVisuals {
  rootGroup: THREE.Group;
  chassisBody: THREE.Group;
  wheelMeshes: THREE.Mesh[];
  antennaDish: THREE.Mesh;
  steeringWheels: THREE.Mesh[];
}

export class ApolloRoverModel {
  public readonly group: THREE.Group;
  public readonly chassis: THREE.Group;
  public readonly wheelMeshes: THREE.Mesh[] = [];
  public readonly frontWheels: THREE.Mesh[] = [];
  public readonly rearWheels: THREE.Mesh[] = [];
  public readonly dishMesh: THREE.Mesh;

  // Procedural container to toggle visibility once GLB loads
  private proceduralChassis: THREE.Group;

  // GLTF nodes bound after asynchronous load
  public gltfLoaded = false;
  public gltfRoot: THREE.Group | null = null;
  public gltfWheels: (THREE.Object3D | null)[] = [null, null, null, null]; // FL, FR, RL, RR
  public armBaseNode: THREE.Object3D | null = null;
  public armBicepNode: THREE.Object3D | null = null;
  public armClawNode: THREE.Object3D | null = null;
  public highGainDishNode: THREE.Object3D | null = null;

  constructor() {
    this.group = new THREE.Group();
    this.chassis = new THREE.Group();
    this.group.add(this.chassis);

    this.proceduralChassis = new THREE.Group();
    this.chassis.add(this.proceduralChassis);

    // 1. PBR Material Definitions for procedural fallback
    const goldKaptonMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      roughness: 0.28,
      metalness: 0.88,
      flatShading: true,
    });

    const aluminumMat = new THREE.MeshStandardMaterial({
      color: 0xd4d4d8,
      roughness: 0.45,
      metalness: 0.75,
    });

    const titaniumMat = new THREE.MeshStandardMaterial({
      color: 0x3f3f46,
      roughness: 0.5,
      metalness: 0.8,
    });

    const wireMeshTireMat = new THREE.MeshStandardMaterial({
      color: 0x27272a,
      roughness: 0.82,
      metalness: 0.65,
    });

    const seatMat = new THREE.MeshStandardMaterial({
      color: 0x1d4ed8,
      roughness: 0.85,
      metalness: 0.1,
    });

    // 2. Chassis Tubular Frame & Bed (Apollo LRV specs: 3.10m long, 2.06m wide)
    const chassisWidth = 1.48;
    const chassisLength = 2.45;
    const chassisHeight = 0.24;

    const frameGeom = new THREE.BoxGeometry(chassisWidth, chassisHeight, chassisLength);
    const frameMesh = new THREE.Mesh(frameGeom, aluminumMat);
    frameMesh.position.y = 0.28;
    frameMesh.castShadow = true;
    frameMesh.receiveShadow = true;
    this.proceduralChassis.add(frameMesh);

    // Gold Thermal Insulation Blanket
    const foilGeom = new THREE.BoxGeometry(chassisWidth * 0.96, 0.38, 0.85);
    const foilMesh = new THREE.Mesh(foilGeom, goldKaptonMat);
    foilMesh.position.set(0, 0.46, -0.68);
    foilMesh.castShadow = true;
    this.proceduralChassis.add(foilMesh);

    // Rear Cargo Pallet & Science Equipment Deck
    const rearCargoGeom = new THREE.BoxGeometry(chassisWidth * 0.94, 0.16, 0.88);
    const rearCargoMesh = new THREE.Mesh(rearCargoGeom, titaniumMat);
    rearCargoMesh.position.set(0, 0.36, 0.68);
    rearCargoMesh.castShadow = true;
    this.proceduralChassis.add(rearCargoMesh);

    // Astronaut Seats (Commander Left, Lunar Module Pilot Right)
    const seatWidth = 0.44;
    const seatDepth = 0.46;
    const seatBackHeight = 0.55;

    const seatBaseGeom = new THREE.BoxGeometry(seatWidth, 0.08, seatDepth);
    const seatBackGeom = new THREE.BoxGeometry(seatWidth, seatBackHeight, 0.07);

    [-0.36, 0.36].forEach((xOffset) => {
      const seatGroup = new THREE.Group();
      seatGroup.position.set(xOffset, 0.45, 0.05);

      const seatBase = new THREE.Mesh(seatBaseGeom, seatMat);
      seatBase.castShadow = true;
      seatGroup.add(seatBase);

      const seatBack = new THREE.Mesh(seatBackGeom, seatMat);
      seatBack.position.set(0, seatBackHeight * 0.48, seatDepth * 0.45);
      seatBack.rotation.x = -0.16;
      seatBack.castShadow = true;
      seatGroup.add(seatBack);

      this.proceduralChassis.add(seatGroup);
    });

    // High-Gain Parabolic Telemetry Antenna Dish
    const dishGeom = new THREE.ConeGeometry(0.38, 0.18, 16, 1, true);
    dishGeom.rotateX(Math.PI / 2);
    this.dishMesh = new THREE.Mesh(dishGeom, goldKaptonMat);
    this.dishMesh.position.set(-0.52, 1.12, -0.92);
    this.dishMesh.rotation.set(-0.4, 0.3, 0);
    this.dishMesh.castShadow = true;
    this.proceduralChassis.add(this.dishMesh);

    // Rollbar & Handrail Framework
    const rollbarGeom = new THREE.CylinderGeometry(0.025, 0.025, 0.82, 8);
    const rollbarLeft = new THREE.Mesh(rollbarGeom, aluminumMat);
    rollbarLeft.position.set(-chassisWidth * 0.46, 0.78, 0.28);
    const rollbarRight = new THREE.Mesh(rollbarGeom, aluminumMat);
    rollbarRight.position.set(chassisWidth * 0.46, 0.78, 0.28);
    this.proceduralChassis.add(rollbarLeft, rollbarRight);

    // 4 Procedural Wire Mesh Wheels
    const wheelRadius = 0.41;
    const wheelWidth = 0.26;
    const wheelGeom = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 20);
    wheelGeom.rotateZ(Math.PI / 2);

    const hubGeom = new THREE.CylinderGeometry(0.14, 0.14, wheelWidth + 0.04, 10);
    hubGeom.rotateZ(Math.PI / 2);

    const offsets: THREE.Vector3[] = [
      new THREE.Vector3(-1.02, 0, -1.15), // Front-Left
      new THREE.Vector3(1.02, 0, -1.15),  // Front-Right
      new THREE.Vector3(-1.02, 0, 1.15),  // Rear-Left
      new THREE.Vector3(1.02, 0, 1.15),   // Rear-Right
    ];

    for (let i = 0; i < offsets.length; i++) {
      const wheelGroup = new THREE.Mesh(wheelGeom, wireMeshTireMat);
      wheelGroup.castShadow = true;

      const hub = new THREE.Mesh(hubGeom, titaniumMat);
      wheelGroup.add(hub);

      this.group.add(wheelGroup);
      this.wheelMeshes.push(wheelGroup);

      if (i < 2) {
        this.frontWheels.push(wheelGroup);
      } else {
        this.rearWheels.push(wheelGroup);
      }
    }

    // Trigger Asynchronous GLB Loading from Blender 4.2 Pipeline
    this.loadGLTFModel();
  }

  private async loadGLTFModel(): Promise<void> {
    try {
      const loader = GLTFAssetLoader.getInstance();
      const model = await loader.loadGLTF('/models/apollo_lrv.glb');
      this.gltfRoot = model;

      // Scan and bind named nodes
      this.gltfRoot.traverse((child) => {
        const name = child.name;
        if (name === 'Wheel_FL') this.gltfWheels[0] = child;
        else if (name === 'Wheel_FR') this.gltfWheels[1] = child;
        else if (name === 'Wheel_RL') this.gltfWheels[2] = child;
        else if (name === 'Wheel_RR') this.gltfWheels[3] = child;
        else if (name === 'RoboticArm_Base') this.armBaseNode = child;
        else if (name === 'RoboticArm_Bicep') this.armBicepNode = child;
        else if (name === 'RoboticArm_Claw') this.armClawNode = child;
        else if (name === 'HighGain_Dish') this.highGainDishNode = child;
      });

      // Add the GLTF model to the chassis group
      this.chassis.add(this.gltfRoot);

      // Hide procedural chassis meshes
      this.proceduralChassis.visible = false;

      // If GLTF wheels exist inside the model, hide the procedural wheels
      const hasGLTFWheels = this.gltfWheels.some((w) => w !== null);
      if (hasGLTFWheels) {
        for (const pw of this.wheelMeshes) {
          pw.visible = false;
        }
      }

      this.gltfLoaded = true;
      console.log('[ApolloRoverModel] High-fidelity Blender 4.2 GLTF rover loaded successfully');
    } catch (err) {
      console.warn('[ApolloRoverModel] Failed to load apollo_lrv.glb, running with procedural fallback', err);
    }
  }

  public updateWheelTransforms(
    wheelPositions: THREE.Vector3[],
    wheelRotations: THREE.Euler[],
    steerAngle: number
  ): void {
    // 1. Update procedural fallback wheels
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const mesh = this.wheelMeshes[i];
      mesh.position.copy(wheelPositions[i]);
      mesh.rotation.x = wheelRotations[i].x;

      if (i < 2) {
        mesh.rotation.y = steerAngle;
      } else {
        mesh.rotation.y = -steerAngle * 0.7;
      }
    }

    // 2. Update GLTF wheel nodes if bound
    for (let i = 0; i < 4; i++) {
      const gltfWheel = this.gltfWheels[i];
      if (gltfWheel) {
        gltfWheel.rotation.x = wheelRotations[i].x;
        if (i < 2) {
          gltfWheel.rotation.y = steerAngle;
        } else {
          gltfWheel.rotation.y = -steerAngle * 0.7;
        }
      }
    }
  }
}
