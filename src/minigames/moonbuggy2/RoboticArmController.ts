import * as THREE from 'three';
import { ApolloRoverModel } from './ApolloRoverModel';

export type ArmState = 'idle' | 'targeting' | 'grabbing' | 'stowing' | 'retracting';

export interface PickupOptions {
  targetWorldPos?: THREE.Vector3;
  roverPos?: THREE.Vector3;
  roverHeading?: number;
  onGrab?: () => void;
  onComplete: () => void;
}

export class RoboticArmController {
  private model: ApolloRoverModel;
  public state: ArmState = 'idle';
  private timer = 0;
  private readonly cycleDuration = 1.4; // 1.4s full multi-phase grab & stow cycle
  private onGrabCallback: (() => void) | null = null;
  private onCompleteCallback: (() => void) | null = null;
  private grabTriggered = false;
  private depositTriggered = false;
  private targetAzimuth = 0.45; // Default starboard reach angle

  constructor(model: ApolloRoverModel) {
    this.model = model;
  }

  public isBusy(): boolean {
    return this.state !== 'idle';
  }

  public triggerPickup(optionsOrComplete: PickupOptions | (() => void)): boolean {
    if (this.isBusy()) return false;

    let opts: PickupOptions;
    if (typeof optionsOrComplete === 'function') {
      opts = { onComplete: optionsOrComplete };
    } else {
      opts = optionsOrComplete;
    }

    this.state = 'targeting';
    this.timer = 0;
    this.grabTriggered = false;
    this.depositTriggered = false;
    this.onGrabCallback = opts.onGrab || null;
    this.onCompleteCallback = opts.onComplete;

    // Compute directed reach azimuth toward the actual ground rock
    if (opts.targetWorldPos && opts.roverPos && opts.roverHeading !== undefined) {
      const dx = opts.targetWorldPos.x - opts.roverPos.x;
      const dz = opts.targetWorldPos.z - opts.roverPos.z;

      // Rotate delta into rover local coordinate space
      const cosH = Math.cos(-opts.roverHeading);
      const sinH = Math.sin(-opts.roverHeading);
      const localX = dx * cosH - dz * sinH;
      const localZ = dx * sinH + dz * cosH;

      // Base is located at +0.78m starboard, -0.35m forward
      const armRelX = localX - 0.78;
      const armRelZ = localZ - (-0.35);

      // Desired azimuth from arm base turret
      const rawAngle = Math.atan2(armRelX, -armRelZ);
      // Clamp to mechanical limits (-0.8 to +1.8 rad)
      this.targetAzimuth = THREE.MathUtils.clamp(rawAngle, -0.8, 1.8);
    } else {
      this.targetAzimuth = 0.45;
    }

    this.model.setLaserActive(true);
    return true;
  }

  public update(delta: number): void {
    if (this.state === 'idle') return;

    this.timer += delta;
    const progress = Math.min(1.0, this.timer / this.cycleDuration);

    const base = this.model.armBaseNode;
    const boom = this.model.armBoomNode;
    const forearm = this.model.armForearmNode;
    const claw = this.model.armClawNode;

    if (progress < 0.35) {
      // Phase 1: Targeting & Extending toward the ground rock
      this.state = 'targeting';
      const t = progress / 0.35;
      const easeT = THREE.MathUtils.smoothstep(t, 0, 1);

      if (base) base.rotation.y = THREE.MathUtils.lerp(0, this.targetAzimuth, easeT);
      if (boom) boom.rotation.x = THREE.MathUtils.lerp(0, -0.92, easeT);
      if (forearm) forearm.rotation.x = THREE.MathUtils.lerp(0, -0.75, easeT);
      if (claw) {
        claw.rotation.x = THREE.MathUtils.lerp(0, 0.45, easeT);
        claw.scale.set(1.25, 1.25, 1.25); // Fingers open wide
      }
    } else if (progress < 0.55) {
      // Phase 2: Grabbing sample at surface level
      this.state = 'grabbing';
      const pGrab = (progress - 0.35) / 0.20;

      // Close claw fingers around the rock
      if (claw) {
        claw.scale.set(0.9, 0.9, 0.9); // Fingers grip tightly
        claw.rotation.z = Math.sin(pGrab * Math.PI * 4) * 0.05;
      }

      if (!this.grabTriggered) {
        this.grabTriggered = true;
        this.model.setHeldRockVisible(true);
        if (this.onGrabCallback) {
          this.onGrabCallback();
        }
      }
    } else if (progress < 0.85) {
      // Phase 3: Stowing & Swinging sample back to rear cargo bed
      this.state = 'stowing';
      const t = (progress - 0.55) / 0.30;
      const easeT = THREE.MathUtils.smoothstep(t, 0, 1);

      // Turret swings toward rear cargo deck (~ +2.6 rad)
      if (base) base.rotation.y = THREE.MathUtils.lerp(this.targetAzimuth, 2.65, easeT);
      // Boom lifts high to clear chassis rollbars, then lowers over cargo bay
      const boomArc = Math.sin(easeT * Math.PI) * 0.45;
      if (boom) boom.rotation.x = THREE.MathUtils.lerp(-0.92, 0.45, easeT) + boomArc;
      if (forearm) forearm.rotation.x = THREE.MathUtils.lerp(-0.75, 0.85, easeT);
      if (claw) {
        claw.rotation.x = THREE.MathUtils.lerp(0.45, -0.65, easeT);
        claw.rotation.z = 0;
      }
    } else if (progress < 1.0) {
      // Phase 4: Depositing rock into cargo bed & Returning to aerodynamic rest
      this.state = 'retracting';
      const t = (progress - 0.85) / 0.15;
      const easeT = THREE.MathUtils.smoothstep(t, 0, 1);

      if (!this.depositTriggered) {
        this.depositTriggered = true;
        this.model.setHeldRockVisible(false);
        this.model.setLaserActive(false);
      }

      if (claw) claw.scale.set(1.0, 1.0, 1.0);
      if (base) base.rotation.y = THREE.MathUtils.lerp(2.65, 0, easeT);
      if (boom) boom.rotation.x = THREE.MathUtils.lerp(0.45, 0, easeT);
      if (forearm) forearm.rotation.x = THREE.MathUtils.lerp(0.85, 0, easeT);
      if (claw) claw.rotation.set(0, 0, 0);
    } else {
      // Sequence Finished
      this.state = 'idle';
      this.timer = 0;
      this.model.setHeldRockVisible(false);
      this.model.setLaserActive(false);

      if (base) base.rotation.set(0, 0, 0);
      if (boom) boom.rotation.set(0, 0, 0);
      if (forearm) forearm.rotation.set(0, 0, 0);
      if (claw) {
        claw.rotation.set(0, 0, 0);
        claw.scale.set(1.0, 1.0, 1.0);
      }

      if (this.onCompleteCallback) {
        const cb = this.onCompleteCallback;
        this.onCompleteCallback = null;
        this.onGrabCallback = null;
        cb();
      }
    }
  }
}
