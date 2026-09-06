import * as THREE from 'three';
import { ApolloRoverModel } from './ApolloRoverModel';

export type ArmState = 'idle' | 'extending' | 'grabbing' | 'retracting';

export class RoboticArmController {
  private model: ApolloRoverModel;
  public state: ArmState = 'idle';
  private timer = 0;
  private readonly cycleDuration = 1.2; // 1.2s full grab cycle
  private onCompleteCallback: (() => void) | null = null;

  constructor(model: ApolloRoverModel) {
    this.model = model;
  }

  public isBusy(): boolean {
    return this.state !== 'idle';
  }

  public triggerPickup(onComplete: () => void): boolean {
    if (this.isBusy()) return false;

    this.state = 'extending';
    this.timer = 0;
    this.onCompleteCallback = onComplete;
    return true;
  }

  public update(delta: number): void {
    if (this.state === 'idle') return;

    this.timer += delta;
    const progress = Math.min(1.0, this.timer / this.cycleDuration);

    const base = this.model.armBaseNode;
    const bicep = this.model.armBicepNode;
    const claw = this.model.armClawNode;

    if (progress < 0.4) {
      // Extending phase
      this.state = 'extending';
      const t = progress / 0.4;
      if (base) base.rotation.y = THREE.MathUtils.lerp(0, 0.45, t);
      if (bicep) bicep.rotation.x = THREE.MathUtils.lerp(0, -0.85, t);
      if (claw) claw.rotation.x = THREE.MathUtils.lerp(0, -0.65, t);
    } else if (progress < 0.65) {
      // Grabbing phase
      this.state = 'grabbing';
      if (bicep) bicep.rotation.x = -0.85 + Math.sin((progress - 0.4) * 20.0) * 0.05;
      if (claw) claw.rotation.z = Math.sin((progress - 0.4) * 30.0) * 0.3;
    } else if (progress < 1.0) {
      // Retracting phase
      this.state = 'retracting';
      const t = (progress - 0.65) / 0.35;
      if (base) base.rotation.y = THREE.MathUtils.lerp(0.45, 0, t);
      if (bicep) bicep.rotation.x = THREE.MathUtils.lerp(-0.85, 0, t);
      if (claw) {
        claw.rotation.x = THREE.MathUtils.lerp(-0.65, 0, t);
        claw.rotation.z = 0;
      }
    } else {
      // Cycle complete
      this.state = 'idle';
      this.timer = 0;
      if (base) base.rotation.set(0, 0, 0);
      if (bicep) bicep.rotation.set(0, 0, 0);
      if (claw) claw.rotation.set(0, 0, 0);

      if (this.onCompleteCallback) {
        const cb = this.onCompleteCallback;
        this.onCompleteCallback = null;
        cb();
      }
    }
  }
}
