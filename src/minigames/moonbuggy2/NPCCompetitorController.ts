import * as THREE from 'three';

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
}

export class NPCCompetitorController {
  private competitors: NPCCompetitor[] = [];
  
  public addCompetitor(competitor: NPCCompetitor): void {
    this.competitors.push(competitor);
  }
  
  public setPlayerRoverId(): void {
  }
  
  public getCompetitors(): NPCCompetitor[] {
    return this.competitors;
  }
  
  public update(delta: number): void {
    // Simple AI for competitors
    for (const competitor of this.competitors) {
      // Basic movement logic
      competitor.velocity.x += (Math.random() - 0.5) * 0.1;
      competitor.velocity.z += (Math.random() - 0.5) * 0.1;
      
      // Clamp velocity
      const maxSpeed = 3.0;
      const speed = competitor.velocity.length();
      if (speed > maxSpeed) {
        competitor.velocity.normalize().multiplyScalar(maxSpeed);
      }
      
      // Update position
      competitor.position.add(competitor.velocity.clone().multiplyScalar(delta));
      
      // Keep within bounds
      competitor.position.x = Math.max(-20, Math.min(20, competitor.position.x));
      competitor.position.z = Math.max(-20, Math.min(20, competitor.position.z));
    }
  }
  
  public reset(): void {
    this.competitors = [];
  }
}