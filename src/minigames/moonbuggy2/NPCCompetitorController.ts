import * as THREE from 'three';

export type CompetitorAIState = 'SEEKING' | 'COLLECTING' | 'RETURNING' | 'DEPOSITING';

export interface NPCCompetitor {
  id: string;
  name: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  heading: number;
  mass: number;
  radius: number;
  isPlayer: boolean;
  damage: number;
  totalDelivered: number;

  // Active AI State Fields
  aiState?: CompetitorAIState;
  targetPos?: THREE.Vector3;
  homeBasePos?: THREE.Vector3;
  actionTimer?: number;
  cargoRocks?: number;
  maxCargo?: number;
  currentSpeed?: number;
}

export class NPCCompetitorController {
  private competitors: NPCCompetitor[] = [];

  public addCompetitor(competitor: NPCCompetitor): void {
    if (!competitor.aiState) competitor.aiState = 'SEEKING';
    if (!competitor.cargoRocks) competitor.cargoRocks = 0;
    if (!competitor.maxCargo) competitor.maxCargo = 3;
    if (!competitor.actionTimer) competitor.actionTimer = 0;
    if (!competitor.currentSpeed) competitor.currentSpeed = 0;

    // Infer home bases
    if (!competitor.homeBasePos) {
      if (competitor.id.includes('valkyrie')) {
        competitor.homeBasePos = new THREE.Vector3(-75, 0, 45);
      } else if (competitor.id.includes('kaguya')) {
        competitor.homeBasePos = new THREE.Vector3(80, 0, -60);
      } else {
        competitor.homeBasePos = new THREE.Vector3(-75, 0, 45);
      }
    }

    this.competitors.push(competitor);
  }

  public setPlayerRoverId(_id: string): void {
    // Retained for interface contract
  }

  public getCompetitors(): NPCCompetitor[] {
    return this.competitors;
  }

  public reset(): void {
    this.competitors = [];
  }

  public update(delta: number): void {
    const dt = Math.min(0.1, Math.max(0.001, delta));

    for (const comp of this.competitors) {
      this.updateCompetitor(comp, dt);
    }
  }

  private updateCompetitor(comp: NPCCompetitor, dt: number): void {
    if (!comp.homeBasePos) {
      comp.homeBasePos = comp.id.includes('kaguya')
        ? new THREE.Vector3(80, 0, -60)
        : new THREE.Vector3(-75, 0, 45);
    }

    const state = comp.aiState || 'SEEKING';
    const currentSpeed = comp.currentSpeed || 0;

    switch (state) {
      case 'SEEKING': {
        // Ensure valid target rock position near the track circuit
        if (!comp.targetPos || comp.position.distanceTo(comp.targetPos) < 4.0) {
          comp.targetPos = this.generateSampleTarget(comp.id);
        }

        const dist = comp.position.distanceTo(comp.targetPos);
        if (dist < 4.5) {
          // Reached sample location
          comp.aiState = 'COLLECTING';
          comp.actionTimer = 1.8;
          comp.currentSpeed = 0;
          comp.velocity.set(0, 0, 0);
          break;
        }

        // Steer toward targetPos
        const dx = comp.targetPos.x - comp.position.x;
        const dz = comp.targetPos.z - comp.position.z;
        const desiredHeading = Math.atan2(dx, -dz);

        let angleDiff = desiredHeading - comp.heading;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        const maxTurn = 2.8 * dt;
        comp.heading += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), maxTurn);

        // Accelerate up to 13.5 m/s (~48 km/h)
        const targetSpeed = 13.5;
        const accel = 6.5;
        comp.currentSpeed = Math.min(targetSpeed, currentSpeed + accel * dt);

        comp.velocity.x = -Math.sin(comp.heading) * comp.currentSpeed;
        comp.velocity.z = -Math.cos(comp.heading) * comp.currentSpeed;

        comp.position.x += comp.velocity.x * dt;
        comp.position.z += comp.velocity.z * dt;
        break;
      }

      case 'COLLECTING': {
        comp.currentSpeed = 0;
        comp.velocity.set(0, 0, 0);
        comp.actionTimer = (comp.actionTimer || 1.8) - dt;

        if (comp.actionTimer <= 0) {
          comp.cargoRocks = (comp.cargoRocks || 0) + 1;
          const maxCargo = comp.maxCargo || 3;
          if (comp.cargoRocks >= maxCargo) {
            comp.aiState = 'RETURNING';
          } else {
            comp.aiState = 'SEEKING';
            comp.targetPos = this.generateSampleTarget(comp.id);
          }
        }
        break;
      }

      case 'RETURNING': {
        const base = comp.homeBasePos;
        const dist = comp.position.distanceTo(base);

        if (dist < 6.5) {
          comp.aiState = 'DEPOSITING';
          comp.actionTimer = 2.0;
          comp.currentSpeed = 0;
          comp.velocity.set(0, 0, 0);
          break;
        }

        // Steer toward home drop station
        const dx = base.x - comp.position.x;
        const dz = base.z - comp.position.z;
        const desiredHeading = Math.atan2(dx, -dz);

        let angleDiff = desiredHeading - comp.heading;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        const maxTurn = 3.0 * dt;
        comp.heading += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), maxTurn);

        // Sprint back to base at 15.0 m/s (~54 km/h)
        const targetSpeed = 15.0;
        const accel = 7.0;
        comp.currentSpeed = Math.min(targetSpeed, currentSpeed + accel * dt);

        comp.velocity.x = -Math.sin(comp.heading) * comp.currentSpeed;
        comp.velocity.z = -Math.cos(comp.heading) * comp.currentSpeed;

        comp.position.x += comp.velocity.x * dt;
        comp.position.z += comp.velocity.z * dt;
        break;
      }

      case 'DEPOSITING': {
        comp.currentSpeed = 0;
        comp.velocity.set(0, 0, 0);
        comp.actionTimer = (comp.actionTimer || 2.0) - dt;

        if (comp.actionTimer <= 0) {
          comp.totalDelivered += comp.cargoRocks || 0;
          comp.cargoRocks = 0;
          comp.aiState = 'SEEKING';
          comp.targetPos = this.generateSampleTarget(comp.id);
        }
        break;
      }
    }

    // World boundary clamping (-110 to 110)
    comp.position.x = Math.max(-110, Math.min(110, comp.position.x));
    comp.position.z = Math.max(-110, Math.min(110, comp.position.z));
  }

  private generateSampleTarget(competitorId: string): THREE.Vector3 {
    // Generate targets distributed along the circuit track
    const seed = competitorId.includes('valkyrie') ? 1 : 2;
    const angle = (Date.now() * 0.0003 * seed) + (seed * Math.PI);
    const radius = 55.0 + (Math.sin(Date.now() * 0.001) * 25.0);

    return new THREE.Vector3(
      Math.cos(angle) * radius,
      0,
      Math.sin(angle) * radius
    );
  }
}
