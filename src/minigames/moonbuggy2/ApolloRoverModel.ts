import * as THREE from 'three';
import { GLTFAssetLoader } from './GLTFAssetLoader';

export interface ApolloRoverVisuals {
  rootGroup: THREE.Group;
  chassisBody: THREE.Group;
  wheelMeshes: THREE.Object3D[];
  antennaDish: THREE.Mesh;
  steeringWheels: THREE.Object3D[];
}

export class ApolloRoverModel {
  public readonly group: THREE.Group;
  public readonly chassis: THREE.Group;
  public readonly wheelMeshes: THREE.Object3D[] = [];
  public readonly frontWheels: THREE.Object3D[] = [];
  public readonly rearWheels: THREE.Object3D[] = [];
  public readonly dishMesh: THREE.Mesh;

  // Procedural container to toggle visibility once GLB loads
  private proceduralChassis: THREE.Group;

  // GLTF nodes bound after asynchronous load
  public gltfLoaded = false;
  public gltfRoot: THREE.Group | null = null;
  public gltfKnuckles: (THREE.Object3D | null)[] = [null, null, null, null]; // FL, FR, RL, RR
  public gltfWheels: (THREE.Object3D | null)[] = [null, null, null, null]; // FL, FR, RL, RR
  public armBaseNode: THREE.Object3D | null = null;
  public armBoomNode: THREE.Object3D | null = null;
  public armForearmNode: THREE.Object3D | null = null;
  public armClawNode: THREE.Object3D | null = null;
  public armLaserNode: THREE.Object3D | null = null;
  public heldRockNode: THREE.Object3D | null = null;
  public highGainDishNode: THREE.Object3D | null = null;
  public cargoRocks: THREE.Object3D[] = [];

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

    // Parabolic High-Gain Antenna Dish
    const dishGeom = new THREE.ConeGeometry(0.48, 0.16, 16, 1, true);
    this.dishMesh = new THREE.Mesh(dishGeom, goldKaptonMat);
    this.dishMesh.position.set(0.45, 1.25, -0.95);
    this.dishMesh.rotation.set(-0.55, 0.25, 0.4);
    this.dishMesh.castShadow = true;
    this.proceduralChassis.add(this.dishMesh);

    // 3. Four Wire-Mesh Tires (Apollo LRV specs: 0.818m diameter, 0.23m wide)
    const wheelRadius = 0.41;
    const wheelWidth = 0.23;
    const wheelGeom = new THREE.CylinderGeometry(
      wheelRadius,
      wheelRadius,
      wheelWidth,
      24
    );
    wheelGeom.rotateZ(Math.PI / 2);

    const hubGeom = new THREE.CylinderGeometry(0.16, 0.16, wheelWidth * 1.05, 16);
    hubGeom.rotateZ(Math.PI / 2);

    const wheelOffsets = [
      new THREE.Vector3(-0.95, 0.41, -1.15), // Front Left
      new THREE.Vector3(0.95, 0.41, -1.15),  // Front Right
      new THREE.Vector3(-0.95, 0.41, 1.15),  // Rear Left
      new THREE.Vector3(0.95, 0.41, 1.15),   // Rear Right
    ];

    for (let i = 0; i < 4; i++) {
      const wheelGroup = new THREE.Group();
      wheelGroup.position.copy(wheelOffsets[i]);

      const tire = new THREE.Mesh(wheelGeom, wireMeshTireMat);
      tire.castShadow = true;
      tire.receiveShadow = true;
      wheelGroup.add(tire);

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

      this.cargoRocks = [];

      // Scan and bind named nodes
      this.gltfRoot.traverse((child) => {
        const name = child.name;
        if (name === 'SteeringKnuckle_FL') this.gltfKnuckles[0] = child;
        else if (name === 'SteeringKnuckle_FR') this.gltfKnuckles[1] = child;
        else if (name === 'SteeringKnuckle_RL') this.gltfKnuckles[2] = child;
        else if (name === 'SteeringKnuckle_RR') this.gltfKnuckles[3] = child;
        else if (name === 'Wheel_FL') this.gltfWheels[0] = child;
        else if (name === 'Wheel_FR') this.gltfWheels[1] = child;
        else if (name === 'Wheel_RL') this.gltfWheels[2] = child;
        else if (name === 'Wheel_RR') this.gltfWheels[3] = child;
        else if (name === 'RoboticArm_Base') this.armBaseNode = child;
        else if (name === 'RoboticArm_Boom') this.armBoomNode = child;
        else if (name === 'RoboticArm_Forearm') this.armForearmNode = child;
        else if (name === 'RoboticArm_Claw') this.armClawNode = child;
        else if (name === 'RoboticArm_LaserEmitter') this.armLaserNode = child;
        else if (name === 'RoboticArm_HeldRock') {
          this.heldRockNode = child;
          child.visible = false; // Initially hidden until a rock is grabbed
        } else if (name === 'HighGain_Dish') {
          this.highGainDishNode = child;
        } else if (name.startsWith('Cargo_Rock_')) {
          this.cargoRocks.push(child);
          child.visible = false; // Hidden until collected into cargo
        }
      });

      // Sort cargo rocks by index
      this.cargoRocks.sort((a, b) => a.name.localeCompare(b.name));

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
      console.log(`[ApolloRoverModel] High-fidelity Artemis LTV loaded successfully (bound ${this.cargoRocks.length} cargo slots)`);
    } catch (err) {
      console.warn('[ApolloRoverModel] Failed to load apollo_lrv.glb, running with procedural fallback', err);
    }
  }

  public setCargoRockCount(count: number): void {
    for (let i = 0; i < this.cargoRocks.length; i++) {
      this.cargoRocks[i].visible = i < count;
    }
  }

  public setHeldRockVisible(visible: boolean): void {
    if (this.heldRockNode) {
      this.heldRockNode.visible = visible;
    }
  }

  public setLaserActive(active: boolean): void {
    if (this.armLaserNode) {
      this.armLaserNode.visible = active;
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

    // 2. Update GLTF wheel and knuckle nodes if bound
    // Knuckles handle steering yaw, wheels handle forward rolling pitch.
    // Wheels sit at (0, 0, 0) relative to knuckles, with zero lateral offset.
    for (let i = 0; i < 4; i++) {
      const knuckle = this.gltfKnuckles[i];
      const wheel = this.gltfWheels[i];
      if (knuckle) {
        knuckle.rotation.y = i < 2 ? steerAngle : -steerAngle * 0.7;
      }
      if (wheel) {
        wheel.rotation.x = wheelRotations[i].x;
        wheel.position.set(0, 0, 0);
      }
    }
  }
}
