import * as THREE from 'three';

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

  constructor() {
    this.group = new THREE.Group();
    this.chassis = new THREE.Group();
    this.group.add(this.chassis);

    // 1. PBR Material Definitions
    // Kapton / Aluminized Mylar gold thermal insulation foil
    const goldKaptonMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      roughness: 0.28,
      metalness: 0.88,
      flatShading: true, // Gives crinkled space foil look
    });

    // Anodized aluminum chassis & tubular framework
    const aluminumMat = new THREE.MeshStandardMaterial({
      color: 0xd4d4d8,
      roughness: 0.45,
      metalness: 0.75,
    });

    // Dark titanium structural fittings & roll-bar
    const titaniumMat = new THREE.MeshStandardMaterial({
      color: 0x3f3f46,
      roughness: 0.5,
      metalness: 0.8,
    });

    // Apollo zinc-coated woven steel wire-mesh tires
    const wireMeshTireMat = new THREE.MeshStandardMaterial({
      color: 0x27272a,
      roughness: 0.82,
      metalness: 0.65,
      wireframe: false,
    });

    // NASA blue fabric astronaut seats
    const seatMat = new THREE.MeshStandardMaterial({
      color: 0x1d4ed8,
      roughness: 0.85,
      metalness: 0.1,
    });

    // 2. Chassis Lower Hull & Bathtub Tub
    const tubGeom = new THREE.BoxGeometry(1.5, 0.3, 2.6);
    const tub = new THREE.Mesh(tubGeom, aluminumMat);
    tub.position.y = 0.25;
    tub.castShadow = true;
    this.chassis.add(tub);

    // Gold Foil Blanket Covering forward electronics & battery compartments
    const foilGeom = new THREE.BoxGeometry(1.42, 0.35, 1.1);
    const foil = new THREE.Mesh(foilGeom, goldKaptonMat);
    foil.position.set(0, 0.45, -0.7);
    foil.castShadow = true;
    this.chassis.add(foil);

    // Tubular Roll-Bar Cage & Handrails
    const rollBarGeom = new THREE.CylinderGeometry(0.035, 0.035, 1.4, 8);
    const barL = new THREE.Mesh(rollBarGeom, titaniumMat);
    barL.position.set(-0.7, 0.85, 0.2);
    barL.castShadow = true;
    this.chassis.add(barL);

    const barR = new THREE.Mesh(rollBarGeom, titaniumMat);
    barR.position.set(0.7, 0.85, 0.2);
    barR.castShadow = true;
    this.chassis.add(barR);

    const crossBarGeom = new THREE.CylinderGeometry(0.035, 0.035, 1.45, 8);
    const crossBar = new THREE.Mesh(crossBarGeom, titaniumMat);
    crossBar.rotation.z = Math.PI / 2;
    crossBar.position.set(0, 1.45, 0.2);
    crossBar.castShadow = true;
    this.chassis.add(crossBar);

    // 3. Crew Cockpit: Dual Foldable Lawn-Chair Astronaut Seats
    const seatBackGeom = new THREE.BoxGeometry(0.48, 0.55, 0.06);
    const seatBottomGeom = new THREE.BoxGeometry(0.48, 0.06, 0.45);

    // Commander Seat (Left)
    const seatLBack = new THREE.Mesh(seatBackGeom, seatMat);
    seatLBack.position.set(-0.36, 0.72, 0.22);
    seatLBack.rotation.x = -0.2;
    this.chassis.add(seatLBack);

    const seatLBot = new THREE.Mesh(seatBottomGeom, seatMat);
    seatLBot.position.set(-0.36, 0.45, 0.02);
    this.chassis.add(seatLBot);

    // Lunar Module Pilot Seat (Right)
    const seatRBack = new THREE.Mesh(seatBackGeom, seatMat);
    seatRBack.position.set(0.36, 0.72, 0.22);
    seatRBack.rotation.x = -0.2;
    this.chassis.add(seatRBack);

    const seatRBot = new THREE.Mesh(seatBottomGeom, seatMat);
    seatRBot.position.set(0.36, 0.45, 0.02);
    this.chassis.add(seatRBot);

    // T-Handle Control Stick (Center Joystick between seats)
    const stickGeom = new THREE.CylinderGeometry(0.025, 0.025, 0.4, 6);
    const stick = new THREE.Mesh(stickGeom, titaniumMat);
    stick.position.set(0, 0.62, -0.1);
    stick.rotation.x = -0.3;
    this.chassis.add(stick);

    const handleGeom = new THREE.BoxGeometry(0.18, 0.04, 0.04);
    const handle = new THREE.Mesh(handleGeom, goldKaptonMat);
    handle.position.set(0, 0.8, -0.16);
    this.chassis.add(handle);

    // 4. Parabolic High-Gain Antenna (Gold Dish) & Color TV Mast
    const dishGeom = new THREE.CylinderGeometry(0.55, 0.12, 0.18, 14);
    this.dishMesh = new THREE.Mesh(dishGeom, goldKaptonMat);
    this.dishMesh.position.set(0.45, 1.25, -1.05);
    this.dishMesh.rotation.x = -0.65;
    this.dishMesh.rotation.z = 0.2;
    this.dishMesh.castShadow = true;
    this.chassis.add(this.dishMesh);

    const mastGeom = new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6);
    const mast = new THREE.Mesh(mastGeom, titaniumMat);
    mast.position.set(0.45, 0.75, -1.05);
    mast.castShadow = true;
    this.chassis.add(mast);

    // 5. 4 Woven-Wire Wheels with Chevron Cleats & Hub Motors
    const wheelRadius = 0.41;
    const wheelWidth = 0.28;
    const wheelGeom = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 16);
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

      // Add titanium hub motor cap
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
  }

  public updateWheelTransforms(
    wheelPositions: THREE.Vector3[],
    wheelRotations: THREE.Euler[],
    steerAngle: number
  ): void {
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const mesh = this.wheelMeshes[i];
      mesh.position.copy(wheelPositions[i]);
      mesh.rotation.x = wheelRotations[i].x;

      // Apollo LRV Ackermann dual-axle counter-steering:
      // Front wheels turn with steer angle, rear wheels turn counter at low speeds
      if (i < 2) {
        mesh.rotation.y = steerAngle;
      } else {
        mesh.rotation.y = -steerAngle * 0.7; // Rear counter-steer
      }
    }
  }
}
