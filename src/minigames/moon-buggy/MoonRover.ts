import * as THREE from 'three';
import { LunarTerrain } from './LunarTerrain';

export interface RoverControls {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  handbrake: boolean;
}

export interface WheelConfig {
  offset: THREE.Vector3;
  radius: number;
  mesh?: THREE.Mesh;
}

export class MoonRover {
  readonly group: THREE.Group;
  private terrain: LunarTerrain;

  // Physics constants (Moon gravity: 1.62 m/s^2)
  public readonly gravity = 1.62;

  // State vectors
  public position = new THREE.Vector3(0, 5, 0);
  public velocity = new THREE.Vector3(0, 0, 0);
  public angularVelocity = new THREE.Vector3(0, 0, 0);
  public heading = 0; // Yaw angle in radians
  public pitch = 0;
  public roll = 0;

  // Driving parameters
  public speed = 0; // Current forward speed (m/s)
  private maxForwardSpeed = 16.0; // ~58 km/h max lunar sprint
  private maxReverseSpeed = 6.0;
  private acceleration = 12.0; // Engine traction force
  private brakingDecel = 18.0;
  private coastFriction = 1.5;
  private steerAngle = 0;
  private maxSteerAngle = 0.55; // ~31.5 deg
  private steerRate = 3.5;

  // Suspension parameters
  private restSuspensionLength = 0.65;
  private springStiffness = 38.0;
  private damperConstant = 6.0;
  public isGrounded = false;

  // Controls state
  private controls: RoverControls = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    handbrake: false,
  };

  // Chassis and wheel meshes
  private wheels: WheelConfig[] = [];
  private wheelGroup: THREE.Group = new THREE.Group();
  private bodyMesh!: THREE.Group;

  constructor(terrain: LunarTerrain, spawnPos = new THREE.Vector3(0, 5, 0)) {
    this.terrain = terrain;
    this.position.copy(spawnPos);
    this.group = new THREE.Group();

    this.setupVisuals();
    this.setupInputListeners();
  }

  private setupVisuals(): void {
    // 1. Chassis body: Retro Apollo Lunar Roving Vehicle style
    this.bodyMesh = new THREE.Group();

    // Main frame/tub
    const chassisGeom = new THREE.BoxGeometry(1.6, 0.35, 2.6);
    const chassisMat = new THREE.MeshStandardMaterial({
      color: 0xd4d4d8, // Apollo white/silver heat blanket
      roughness: 0.6,
      metalness: 0.4,
      flatShading: true,
    });
    const chassis = new THREE.Mesh(chassisGeom, chassisMat);
    chassis.position.y = 0.2;
    chassis.castShadow = true;
    this.bodyMesh.add(chassis);

    // Front instrument console & high-gain dish antenna
    const dishGeom = new THREE.CylinderGeometry(0.45, 0.1, 0.15, 8);
    const dishMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b, // Gold foil mesh
      roughness: 0.3,
      metalness: 0.8,
      flatShading: true,
    });
    const dish = new THREE.Mesh(dishGeom, dishMat);
    dish.position.set(0.4, 0.8, -0.9);
    dish.rotation.x = -Math.PI / 4;
    dish.castShadow = true;
    this.bodyMesh.add(dish);

    const mastGeom = new THREE.CylinderGeometry(0.04, 0.04, 0.7, 5);
    const mast = new THREE.Mesh(mastGeom, chassisMat);
    mast.position.set(0.4, 0.45, -0.9);
    this.bodyMesh.add(mast);

    // Rover roll-cage tubular bars
    const rollCageMat = new THREE.MeshStandardMaterial({
      color: 0x52525b,
      metalness: 0.5,
      roughness: 0.5,
    });
    const barGeom = new THREE.BoxGeometry(1.4, 0.08, 0.08);
    const topBar = new THREE.Mesh(barGeom, rollCageMat);
    topBar.position.set(0, 0.95, 0.1);
    this.bodyMesh.add(topBar);

    // Astronaut twin seats (lawn-chair style)
    const seatMat = new THREE.MeshStandardMaterial({
      color: 0x3b82f6, // Retro NASA blue accents
      roughness: 0.8,
    });
    const seatL = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.4, 0.45), seatMat);
    seatL.position.set(-0.35, 0.5, 0.0);
    this.bodyMesh.add(seatL);

    const seatR = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.4, 0.45), seatMat);
    seatR.position.set(0.35, 0.5, 0.0);
    this.bodyMesh.add(seatR);

    this.group.add(this.bodyMesh);

    // 2. Wheels: Wire-mesh Apollo zinc-coated tires
    const wheelMat = new THREE.MeshStandardMaterial({
      color: 0x27272a, // Dark titanium/mesh
      roughness: 0.9,
      metalness: 0.3,
      flatShading: true,
    });
    const wheelGeom = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 10);
    wheelGeom.rotateZ(Math.PI / 2);

    const wheelOffsets: THREE.Vector3[] = [
      new THREE.Vector3(-0.95, 0, -1.05), // Front Left
      new THREE.Vector3(0.95, 0, -1.05),  // Front Right
      new THREE.Vector3(-0.95, 0, 1.05),  // Rear Left
      new THREE.Vector3(0.95, 0, 1.05),   // Rear Right
    ];

    this.wheelGroup = new THREE.Group();
    for (let i = 0; i < wheelOffsets.length; i++) {
      const mesh = new THREE.Mesh(wheelGeom, wheelMat);
      mesh.castShadow = true;
      this.wheelGroup.add(mesh);
      this.wheels.push({
        offset: wheelOffsets[i],
        radius: 0.38,
        mesh,
      });
    }
    this.group.add(this.wheelGroup);
  }

  private setupInputListeners(): void {
    if (typeof window === 'undefined') return;

    const handleKey = (code: string, isDown: boolean) => {
      switch (code) {
        case 'KeyW':
        case 'ArrowUp':
          this.controls.forward = isDown;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this.controls.backward = isDown;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this.controls.left = isDown;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.controls.right = isDown;
          break;
        case 'Space':
          this.controls.handbrake = isDown;
          break;
      }
    };

    window.addEventListener('keydown', (e) => handleKey(e.code, true));
    window.addEventListener('keyup', (e) => handleKey(e.code, false));
  }

  public update(delta: number): void {
    // Clamp delta to avoid spiral of death on lag spike
    const dt = Math.min(delta, 0.1);

    // 1. Steering computation
    let targetSteer = 0;
    if (this.controls.left) targetSteer += this.maxSteerAngle;
    if (this.controls.right) targetSteer -= this.maxSteerAngle;

    this.steerAngle += (targetSteer - this.steerAngle) * this.steerRate * dt;

    // 2. Wheel raycast & suspension force
    let groundedWheels = 0;
    let totalSuspensionUpForce = 0;

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      // World position of wheel attachment
      const worldOffset = w.offset
        .clone()
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
      const wheelWorldPos = this.position.clone().add(worldOffset);

      // Query terrain height at wheel contact
      const groundY = this.terrain.getHeightAt(wheelWorldPos.x, wheelWorldPos.z);
      const contactDist = wheelWorldPos.y - groundY;

      if (contactDist < this.restSuspensionLength + w.radius) {
        groundedWheels++;
        const compression =
          this.restSuspensionLength + w.radius - contactDist;
        const springForce = compression * this.springStiffness;
        const damperForce = -this.velocity.y * this.damperConstant;
        totalSuspensionUpForce += Math.max(0, springForce + damperForce);

        // Adjust wheel visual position
        if (w.mesh) {
          w.mesh.position.copy(worldOffset);
          w.mesh.position.y = Math.max(
            w.offset.y - compression * 0.5,
            w.offset.y - 0.2
          );
          // Turn front wheels with steering
          if (i < 2) {
            w.mesh.rotation.y = this.steerAngle;
          }
          // Spin wheels based on speed
          w.mesh.rotation.x += (this.speed / w.radius) * dt;
        }
      } else {
        if (w.mesh) {
          w.mesh.position.copy(worldOffset);
          w.mesh.position.y = w.offset.y - 0.15;
          if (i < 2) {
            w.mesh.rotation.y = this.steerAngle;
          }
        }
      }
    }

    this.isGrounded = groundedWheels >= 2;

    // 3. Gravity application (1/6th Moon gravity: 1.62 m/s^2)
    this.velocity.y -= this.gravity * dt;

    if (this.isGrounded) {
      // Suspension upward acceleration
      const upwardAccel = totalSuspensionUpForce / this.wheels.length;
      this.velocity.y += upwardAccel * dt;

      // Vertical damping on ground contact
      if (this.velocity.y < 0 && upwardAccel > this.gravity * 0.8) {
        this.velocity.y *= 0.85;
      }

      // 4. Drive throttle & braking
      if (this.controls.forward) {
        this.speed += this.acceleration * dt;
      } else if (this.controls.backward) {
        this.speed -= this.acceleration * 0.7 * dt;
      } else {
        // Natural lunar rolling resistance (low, long glide)
        if (this.speed > 0) {
          this.speed = Math.max(0, this.speed - this.coastFriction * dt);
        } else if (this.speed < 0) {
          this.speed = Math.min(0, this.speed + this.coastFriction * dt);
        }
      }

      // Handbrake
      if (this.controls.handbrake) {
        if (this.speed > 0) {
          this.speed = Math.max(0, this.speed - this.brakingDecel * dt);
        } else if (this.speed < 0) {
          this.speed = Math.min(0, this.speed + this.brakingDecel * dt);
        }
      }

      // Clamp max speeds
      this.speed = THREE.MathUtils.clamp(
        this.speed,
        -this.maxReverseSpeed,
        this.maxForwardSpeed
      );

      // 5. Steering yaw angular velocity
      if (Math.abs(this.speed) > 0.1) {
        const turnDirection = this.speed > 0 ? 1 : -1;
        this.heading += this.steerAngle * (this.speed / 3.0) * turnDirection * dt;
      }

      // Align chassis pitch & roll with terrain normal
      const terrainNormal = this.terrain.getNormalAt(
        this.position.x,
        this.position.z
      );
      const targetPitch = -terrainNormal.z * 0.9;
      const targetRoll = terrainNormal.x * 0.9;
      this.pitch += (targetPitch - this.pitch) * 8.0 * dt;
      this.roll += (targetRoll - this.roll) * 8.0 * dt;
    } else {
      // In flight (lunar hop / crater jump): preserve momentum, gentle self-righting
      this.pitch += (0 - this.pitch) * 1.5 * dt;
      this.roll += (0 - this.roll) * 1.5 * dt;
    }

    // 6. Integrate horizontal translation
    const travelDir = new THREE.Vector3(0, 0, -1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      this.heading
    );
    this.velocity.x = travelDir.x * this.speed;
    this.velocity.z = travelDir.z * this.speed;

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    // Hard floor boundary to prevent falling through terrain
    const minCenterGround = this.terrain.getHeightAt(
      this.position.x,
      this.position.z
    );
    if (this.position.y < minCenterGround + 0.5) {
      this.position.y = minCenterGround + 0.5;
      if (this.velocity.y < 0) {
        // Lunar bouncy impact rebound
        this.velocity.y = -this.velocity.y * 0.25;
      }
    }

    // 7. Update Group transforms
    this.group.position.copy(this.position);
    this.group.rotation.set(0, 0, 0);
    this.group.rotation.y = this.heading;
    this.bodyMesh.rotation.x = this.pitch;
    this.bodyMesh.rotation.z = this.roll;
  }

  public getSpeedKmh(): number {
    return Math.round(Math.abs(this.speed) * 3.6);
  }
}
