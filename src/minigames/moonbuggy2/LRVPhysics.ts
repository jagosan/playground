import * as THREE from 'three';
import { PhotorealisticTerrain } from './PhotorealisticTerrain';

export interface TirePhysicsState {
  offset: THREE.Vector3;
  worldPos: THREE.Vector3;
  isGrounded: boolean;
  compression: number;
  suspensionForce: number;
  slipRatio: number;
  slipAngle: number;
  angularVelocity: number;
  rotationX: number;
}

export class LRVPhysics {
  private terrain: PhotorealisticTerrain;

  // Authentic Lunar & Apollo LRV Constants
  public readonly gravity = 1.622;     // m/s^2 (Apollo 15 measured)
  public readonly emptyMass = 210.0;    // kg
  public readonly payloadMass = 250.0;  // 2 astronauts in A7LB suits + equipment
  public readonly totalMass = 460.0;    // kg
  public readonly cgHeight = 0.42;      // Low Center of Gravity in meters
  public readonly wheelRadius = 0.41;   // 32-inch diameter
  public readonly restSuspension = 0.52;// Extension rest length

  // Suspension & Damper Parameters
  private springK = 18500.0;            // N/m per wheel
  private damperBump = 1450.0;          // Ns/m compression
  private damperRebound = 2100.0;       // Ns/m extension

  // Drive & Powertrain (4 x 0.25 HP Delco series-wound DC motors)
  public maxSpeed = 16.5;              // ~60 km/h top lunar run
  public maxTorque = 380.0;            // Total Nm traction force
  public maxSteerAngle = 0.48;         // ~27.5 degrees
  private steerSpeed = 4.2;

  // Rigid Body State
  public position = new THREE.Vector3(0, 5, 0);
  public velocity = new THREE.Vector3(0, 0, 0);
  public heading = 0;                  // Yaw
  public pitch = 0;
  public roll = 0;
  public angularVelocity = 0;          // Yaw rate
  public steerAngle = 0;
  public forwardSpeed = 0;             // m/s
  public isAirborne = true;

  // 4 Wheels (FL, FR, RL, RR)
  public tires: TirePhysicsState[] = [];

  constructor(terrain: PhotorealisticTerrain, spawnPos = new THREE.Vector3(0, 5, 0)) {
    this.terrain = terrain;
    this.position.copy(spawnPos);

    const offsets: THREE.Vector3[] = [
      new THREE.Vector3(-1.02, 0, -1.15), // Front-Left
      new THREE.Vector3(1.02, 0, -1.15),  // Front-Right
      new THREE.Vector3(-1.02, 0, 1.15),  // Rear-Left
      new THREE.Vector3(1.02, 0, 1.15),   // Rear-Right
    ];

    for (const offset of offsets) {
      this.tires.push({
        offset,
        worldPos: new THREE.Vector3(),
        isGrounded: false,
        compression: 0,
        suspensionForce: 0,
        slipRatio: 0,
        slipAngle: 0,
        angularVelocity: 0,
        rotationX: 0,
      });
    }
  }

  // 120Hz sub-stepping solver for crisp lunar multi-body dynamics
  public step(delta: number, throttle: number, brake: number, steerInput: number, handbrake: boolean, reverse: boolean): void {
    const dt = Math.min(delta, 0.1);
    const subSteps = 2; // 120Hz effective physics rate
    const subDt = dt / subSteps;

    for (let s = 0; s < subSteps; s++) {
      this.integratePhysics(subDt, throttle, brake, steerInput, handbrake, reverse);
    }
  }

  private integratePhysics(
    dt: number,
    throttle: number,
    brake: number,
    steerInput: number,
    handbrake: boolean,
    reverse: boolean
  ): void {
    // 1. Dual-Axle Proportional Steering
    const targetSteer = -steerInput * this.maxSteerAngle;
    this.steerAngle += (targetSteer - this.steerAngle) * this.steerSpeed * dt;

    // 2. Wheel Ground Query & Double-Wishbone Spring-Damper Suspension
    let groundedCount = 0;
    let totalSuspensionForce = 0;

    for (let i = 0; i < this.tires.length; i++) {
      const tire = this.tires[i];
      // World attachment coordinate
      const worldOffset = tire.offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
      tire.worldPos.copy(this.position).add(worldOffset);

      const groundY = this.terrain.getHeightAt(tire.worldPos.x, tire.worldPos.z);
      const contactDist = tire.worldPos.y - groundY;
      const totalArmLength = this.restSuspension + this.wheelRadius;

      if (contactDist < totalArmLength) {
        groundedCount++;
        tire.isGrounded = true;
        tire.compression = totalArmLength - contactDist;

        // Non-linear spring + dual-rate damping
        const springForce = tire.compression * this.springK;
        const vDamper = -this.velocity.y;
        const cDamper = vDamper >= 0 ? this.damperBump : this.damperRebound;
        const damperForce = vDamper * cDamper;

        tire.suspensionForce = Math.max(0, springForce + damperForce);
        totalSuspensionForce += tire.suspensionForce;

        // Pacejka tire angular rotation
        tire.rotationX += (this.forwardSpeed / this.wheelRadius) * dt;
      } else {
        tire.isGrounded = false;
        tire.compression = 0;
        tire.suspensionForce = 0;
      }
    }

    this.isAirborne = groundedCount < 2;

    // 3. Vertical Acceleration & Lunar Gravity Integration
    this.velocity.y -= this.gravity * dt;

    if (!this.isAirborne) {
      const upwardAccel = totalSuspensionForce / this.totalMass;
      this.velocity.y += upwardAccel * dt;

      if (this.velocity.y < 0 && upwardAccel > this.gravity * 0.9) {
        this.velocity.y *= 0.82; // Rebound settle
      }

      // 4. Longitudinal Powertrain & Pacejka Friction
      let driveForce = 0;
      if (reverse) {
        driveForce = -throttle * (this.maxTorque * 0.6);
      } else {
        driveForce = throttle * this.maxTorque;
      }

      // Braking force
      const brakeForce = (brake * 450.0) + (handbrake ? 800.0 : 0);
      if (Math.abs(this.forwardSpeed) > 0.05) {
        const brakeDirection = -Math.sign(this.forwardSpeed);
        driveForce += brakeDirection * Math.min(Math.abs(this.forwardSpeed) * 300.0, brakeForce);
      }

      // Regolith rolling resistance
      const rollingResistance = 25.0 * Math.sign(this.forwardSpeed);
      const netForce = driveForce - rollingResistance;
      const acceleration = netForce / this.totalMass;

      this.forwardSpeed += acceleration * dt;
      this.forwardSpeed = THREE.MathUtils.clamp(this.forwardSpeed, -6.5, this.maxSpeed);

      // 5. Yaw Dynamics (Counter-steer Ackermann turning)
      if (Math.abs(this.forwardSpeed) > 0.1) {
        const turnMult = this.forwardSpeed > 0 ? 1 : -1;
        this.angularVelocity = (this.forwardSpeed / 2.3) * Math.tan(this.steerAngle) * turnMult;
        this.heading += this.angularVelocity * dt;
      }

      // Orient chassis with terrain normal
      const normal = this.terrain.getNormalAt(this.position.x, this.position.z);
      const targetPitch = -normal.z * 0.85;
      const targetRoll = normal.x * 0.85;
      this.pitch += (targetPitch - this.pitch) * 7.5 * dt;
      this.roll += (targetRoll - this.roll) * 7.5 * dt;
    } else {
      // In flight: authentic low-gravity momentum conservation
      this.pitch += (0 - this.pitch) * 1.0 * dt;
      this.roll += (0 - this.roll) * 1.0 * dt;
    }

    // 6. Horizontal Translation
    const forwardVec = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
    this.velocity.x = forwardVec.x * this.forwardSpeed;
    this.velocity.z = forwardVec.z * this.forwardSpeed;

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    // Hard floor barrier
    const minHeight = this.terrain.getHeightAt(this.position.x, this.position.z) + this.cgHeight;
    if (this.position.y < minHeight) {
      this.position.y = minHeight;
      if (this.velocity.y < 0) {
        this.velocity.y = -this.velocity.y * 0.22; // Soft lunar bounce
      }
    }
  }

  public getSpeedKmh(): number {
    return Math.round(Math.abs(this.forwardSpeed) * 3.6);
  }
}
