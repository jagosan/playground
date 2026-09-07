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

  // Authentic Lunar & Apollo LRV Constants (Spec 04 & Spec 06)
  public readonly gravity = 1.622;     // m/s^2 (Apollo 15 measured)
  public readonly emptyMass = 210.0;    // kg
  public readonly crewMass = 150.0;     // 2 astronauts in A7LB suits
  public readonly baseMass = 360.0;     // 360 kg base mass (Spec 06 §2.2)
  public readonly rockMass = 35.0;      // +35.0 kg per rock
  public readonly maxRocks = 8;         // Max 8 rocks cargo (+280 kg)
  public rockCount = 0;                 // Current rocks in payload

  public readonly wheelbase = 2.30;     // 2.30 m between front and rear axles
  public readonly trackWidth = 2.04;    // 2.04 m between left and right wheels
  public readonly cargoBedZ = 1.15;     // Rear cargo deck longitudinal offset (m)

  public get totalMass(): number {
    return this.baseMass + this.rockCount * this.rockMass;
  }

  public get currentMass(): number {
    return this.totalMass;
  }

  public get cargoMass(): number {
    return this.rockCount * this.rockMass;
  }

  public get battery(): number {
    return this.batteryLevel * 100;
  }

  public set battery(val: number) {
    this.batteryLevel = THREE.MathUtils.clamp(val / 100, 0, 1);
  }

  public get inDropStation(): boolean {
    const dSq = this.position.x * this.position.x + this.position.z * this.position.z;
    return dSq <= 36.0; // 6m radius at (0, 0)
  }

  public addRock(): void {
    this.addCargoRock();
  }

  public getSpeedKmh(): number {
    return Math.abs(this.forwardSpeed) * 3.6;
  }

  /**
   * Distance from geometric vehicle center to Center of Gravity along longitudinal axis (Z).
   * Positive Z is rearward. Cargo rack is located at +1.15m.
   */
  public get cgOffsetZ(): number {
    const cargoM = this.cargoMass;
    return (cargoM * this.cargoBedZ) / this.totalMass;
  }

  /**
   * Base polar moment of inertia I_zz (kg*m^2) for the 360kg unladen vehicle.
   * Approximated via box cuboid: I_base = (1/12) * m * (L^2 + W^2)
   */
  public get baseInertia(): number {
    return (1 / 12) * this.baseMass * (this.wheelbase * this.wheelbase + this.trackWidth * this.trackWidth);
  }

  /**
   * Dynamic polar moment of inertia I_zz (kg*m^2) accounting for sample rocks
   * loaded onto the rear cargo deck using the parallel axis theorem.
   */
  public get yawInertia(): number {
    const zCg = this.cgOffsetZ;
    const baseShifted = this.baseInertia + this.baseMass * (zCg * zCg);
    const cargoM = this.cargoMass;
    const cargoInertia = cargoM * Math.pow(this.cargoBedZ - zCg, 2);
    return baseShifted + cargoInertia;
  }

  public readonly cgHeight = 0.42;      // Low Center of Gravity in meters
  public readonly wheelRadius = 0.41;   // 32-inch diameter
  public readonly restSuspension = 0.52;// Extension rest length

  // Suspension & Damper Parameters (Spec 06 §2.2: k=7500 N/m, c=950 Ns/m)
  private springK = 7500.0;             // N/m per wheel
  private damperBump = 1350.0;          // Ns/m compression
  private damperRebound = 1850.0;       // Ns/m extension

  // Drive & Powertrain (Spec 06 §2.2: 4 x 1.2 kW motors, 25.0 km/h hard cap)
  public readonly maxSpeed = 6.944;     // 25.0 km/h (6.944 m/s)
  public maxTorque = 360.0;             // Total Nm traction force
  public maxSteerAngle = 0.48;          // ~27.5 degrees
  private steerSpeed = 4.2;

  // Battery / Fuel Gauge (0.0 to 1.0 = 0% to 100%)
  public batteryLevel = 1.0;
  public readonly batteryDrainRate = 0.0035; // ~0.35 %/s at full throttle
  public readonly rechargeRate = 0.15;       // +15 %/s at drop station

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
      new THREE.Vector3(-1.02, 0, -1.15), // Front-Left (0)
      new THREE.Vector3(1.02, 0, -1.15),  // Front-Right (1)
      new THREE.Vector3(-1.02, 0, 1.15),  // Rear-Left (2)
      new THREE.Vector3(1.02, 0, 1.15),   // Rear-Right (3)
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

  public addCargoRock(): boolean {
    if (this.rockCount >= this.maxRocks) return false;
    this.rockCount++;
    return true;
  }

  public clearCargoRocks(): number {
    const count = this.rockCount;
    this.rockCount = 0;
    return count;
  }

  public drainBattery(amount: number): void {
    this.batteryLevel = Math.max(0, this.batteryLevel - amount);
  }

  public rechargeBattery(amount: number): void {
    this.batteryLevel = Math.min(1.0, this.batteryLevel + amount);
  }

  /**
   * Evaluates the Pacejka 'Magic Formula' tire-regolith friction curve:
   * F = D * sin(C * atan(B * s - E * (B * s - atan(B * s))))
   */
  public pacejkaMagicFormula(slip: number, normalForce: number, isLateral = false): number {
    if (normalForce <= 0) return 0;
    const mu = isLateral ? 0.72 : 0.80;
    const D = mu * normalForce;
    const C = 1.35;
    const B = isLateral ? 5.5 : 7.0;
    const E = -0.15;

    const bSlip = B * slip;
    return D * Math.sin(C * Math.atan(bSlip - E * (bSlip - Math.atan(bSlip))));
  }

  public step(
    dt: number,
    throttle: number,
    brake: number,
    steerInput: number,
    handbrake: boolean,
    reverse: boolean
  ): void {
    // 120Hz sub-stepping (8.33ms substep)
    const substeps = 4;
    const subDt = dt / substeps;

    for (let i = 0; i < substeps; i++) {
      this.substep(subDt, throttle, brake, steerInput, handbrake, reverse);
    }
  }

  private substep(
    dt: number,
    throttle: number,
    brake: number,
    steerInput: number,
    handbrake: boolean,
    reverse: boolean
  ): void {
    // 1. Steering Dynamics
    const targetSteer = -steerInput * this.maxSteerAngle;
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1.0, this.steerSpeed * dt);

    // 2. Drop Station Interactions (Spec 04 §2.3)
    if (this.inDropStation) {
      this.rockCount = 0;
      this.rechargeBattery(this.rechargeRate * dt);
    }

    // 3. Battery Drain from Driving
    if (this.batteryLevel > 0 && Math.abs(throttle) > 0.01) {
      this.drainBattery(this.batteryDrainRate * Math.abs(throttle) * dt);
    }

    // Effective power cuts to 0 if battery exhausted
    const powerAvailable = this.batteryLevel > 0 ? 1.0 : 0.0;

    // 4. Wheel Ground Detection, Dynamic Weight Bias & Suspension Forces
    let totalSuspensionForce = 0;
    let groundedCount = 0;
    const currentMass = this.totalMass;
    const zCg = this.cgOffsetZ;

    // Dynamic damping scale with increased mass to moderate lunar bounce (Spec 04 §1.2)
    const bounceDampingScale = Math.sqrt(currentMass / this.baseMass);
    const activeDamperBump = this.damperBump * bounceDampingScale;
    const activeDamperRebound = this.damperRebound * bounceDampingScale;

    for (let i = 0; i < this.tires.length; i++) {
      const tire = this.tires[i];
      const isFront = tire.offset.z < 0;
      const euler = new THREE.Euler(this.pitch, this.heading, this.roll, 'YXZ');
      const worldOffset = tire.offset.clone().applyEuler(euler);
      tire.worldPos.copy(this.position).add(worldOffset);

      const groundY = this.terrain.getHeightAt(tire.worldPos.x, tire.worldPos.z);
      const contactDist = tire.worldPos.y - groundY;
      const totalArmLength = this.restSuspension + this.wheelRadius;

      if (contactDist < totalArmLength) {
        groundedCount++;
        tire.isGrounded = true;
        tire.compression = totalArmLength - contactDist;

        // Weight distribution: rear wheels carry additional static load as rocks fill cargo bed
        const axleWeightShare = isFront
          ? (1.15 - zCg) / this.wheelbase
          : (1.15 + zCg) / this.wheelbase;
        const staticLoadPerTire = axleWeightShare * (currentMass * this.gravity) * 0.5;

        // Non-linear spring + dynamic bounce damping
        const springForce = tire.compression * this.springK;
        const vDamper = -this.velocity.y;
        const cDamper = vDamper >= 0 ? activeDamperBump : activeDamperRebound;
        const damperForce = vDamper * cDamper;

        // Total vertical normal force (N) on tire (accounting for static load distribution)
        tire.suspensionForce = Math.max(0, springForce + damperForce + staticLoadPerTire * 0.05);
        totalSuspensionForce += tire.suspensionForce;

        // -------------------------------------------------------------
        // Pacejka Slip Dynamics (Longitudinal Kappa & Lateral Alpha)
        // -------------------------------------------------------------
        const steerForTire = isFront ? this.steerAngle : 0;
        const vTireX = this.forwardSpeed * Math.cos(steerForTire);

        // Effective wheel linear speed with throttle slip / brake slip
        const driveSlipDelta = Math.abs(throttle) > 0.05
          ? (reverse ? -1 : 1) * throttle * 0.35 * powerAvailable
          : 0;
        const brakeSlipDelta = Math.abs(brake) > 0.05
          ? -Math.sign(this.forwardSpeed) * brake * 0.4
          : 0;
        const effectiveWheelSpeed = this.forwardSpeed + driveSlipDelta + brakeSlipDelta;

        tire.angularVelocity = effectiveWheelSpeed / this.wheelRadius;
        tire.rotationX += tire.angularVelocity * dt;

        // Pacejka Slip Ratio kappa = (V_wheel - V_x) / max(|V_x|, |V_wheel|, 0.1)
        const denomX = Math.max(Math.abs(vTireX), Math.abs(effectiveWheelSpeed), 0.2);
        tire.slipRatio = THREE.MathUtils.clamp((effectiveWheelSpeed - vTireX) / denomX, -1.0, 1.0);

        // Lateral slip angle alpha = steer - atan2(V_lateral, |V_forward|)
        const axleArm = isFront ? (1.15 - zCg) : -(1.15 + zCg);
        const vLateral = this.angularVelocity * axleArm;
        const denomY = Math.max(Math.abs(this.forwardSpeed), 0.2);
        tire.slipAngle = THREE.MathUtils.clamp(steerForTire - Math.atan2(vLateral, denomY), -0.6, 0.6);
      } else {
        tire.isGrounded = false;
        tire.compression = 0;
        tire.suspensionForce = 0;
        tire.slipRatio = 0;
        tire.slipAngle = 0;
      }
    }

    this.isAirborne = groundedCount === 0;

    // 5. Vertical Acceleration & Lunar Gravity Integration
    this.velocity.y -= this.gravity * dt;

    if (!this.isAirborne) {
      const upwardAccel = totalSuspensionForce / currentMass;
      this.velocity.y += upwardAccel * dt;

      if (this.velocity.y < 0 && upwardAccel > this.gravity * 0.9) {
        this.velocity.y *= 0.75; // Settle rebound cleanly
      }

      // 6. Longitudinal Powertrain & Dynamic Mass Acceleration
      // Apollo LRV motors tuned to reach 25 km/h within governor curve (Spec 04 §2.1)
      const nominalTraction = 480.0 * powerAvailable;
      let driveForce = 0;

      if (reverse) {
        driveForce = -throttle * (nominalTraction * 0.6);
      } else {
        const speedRatio = Math.min(1.0, this.forwardSpeed / this.maxSpeed);
        const torqueCurve = Math.max(0.5, 1.0 - Math.pow(speedRatio, 4));
        driveForce = throttle * nominalTraction * torqueCurve;
      }

      // Braking force
      const brakeForce = (brake * 550.0) + (handbrake ? 900.0 : 0);
      if (Math.abs(this.forwardSpeed) > 0.05) {
        const brakeDirection = -Math.sign(this.forwardSpeed);
        driveForce += brakeDirection * Math.min(Math.abs(this.forwardSpeed) * 350.0, brakeForce);
      }

      // Regolith rolling resistance
      const rollingResistance = 25.0 * Math.sign(this.forwardSpeed);
      const netForce = driveForce - (Math.abs(this.forwardSpeed) > 0.05 ? rollingResistance : 0);
      const acceleration = netForce / currentMass;

      this.forwardSpeed += acceleration * dt;
      // Governed speed cap at 25 km/h (6.944 m/s)
      this.forwardSpeed = THREE.MathUtils.clamp(this.forwardSpeed, -3.5, this.maxSpeed);

      // 7. Yaw Dynamics (Counter-steer Ackermann turning with dynamic yaw inertia)
      if (Math.abs(this.forwardSpeed) > 0.1) {
        const turnMult = this.forwardSpeed > 0 ? 1 : -1;
        const targetAngularVel = (this.forwardSpeed / 2.3) * Math.tan(this.steerAngle) * turnMult;
        // Yaw responsiveness scales inversely with dynamic yaw inertia (more rocks = more inertia damping)
        const inertiaDamping = this.baseInertia / this.yawInertia;
        this.angularVelocity += (targetAngularVel - this.angularVelocity) * Math.min(1.0, 6.0 * inertiaDamping * dt);
        this.heading += this.angularVelocity * dt;
      } else {
        this.angularVelocity *= 0.85;
      }
    } else {
      // Airborne damping
      this.forwardSpeed *= 0.998;
    }

    // 8. Velocity Vector & Position Integration
    const forwardVector = new THREE.Vector3(0, 0, -1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      this.heading
    );
    this.velocity.x = forwardVector.x * this.forwardSpeed;
    this.velocity.z = forwardVector.z * this.forwardSpeed;

    this.position.addScaledVector(this.velocity, dt);

    // Hard floor boundary
    const centerGround = this.terrain.getHeightAt(this.position.x, this.position.z);
    if (this.position.y < centerGround + 0.3) {
      this.position.y = centerGround + 0.3;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }

    // 9. Dynamic Pitch and Roll from 4 Tire Heights
    if (!this.isAirborne) {
      const g0 = this.terrain.getHeightAt(this.tires[0].worldPos.x, this.tires[0].worldPos.z);
      const g1 = this.terrain.getHeightAt(this.tires[1].worldPos.x, this.tires[1].worldPos.z);
      const g2 = this.terrain.getHeightAt(this.tires[2].worldPos.x, this.tires[2].worldPos.z);
      const g3 = this.terrain.getHeightAt(this.tires[3].worldPos.x, this.tires[3].worldPos.z);

      const frontGround = (g0 + g1) * 0.5;
      const rearGround = (g2 + g3) * 0.5;
      const targetPitch = Math.atan2(frontGround - rearGround, this.wheelbase);
      this.pitch += (targetPitch - this.pitch) * Math.min(1.0, 9.0 * dt);

      const leftGround = (g0 + g2) * 0.5;
      const rightGround = (g1 + g3) * 0.5;
      const targetRoll = Math.atan2(rightGround - leftGround, this.trackWidth);
      this.roll += (targetRoll - this.roll) * Math.min(1.0, 9.0 * dt);
    } else {
      this.pitch *= 0.98;
      this.roll *= 0.98;
    }
  }
}
