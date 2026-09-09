import * as THREE from 'three';

export interface RoverCollider {
  id: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  heading: number;
  mass: number;
  radius: number;
  isPlayer: boolean;
  damage: number;
}

export interface CollisionImpact {
  roverAId: string;
  roverBId: string;
  relativeSpeed: number;
  impulseMagnitude: number;
  damageA: number;
  damageB: number;
  impactPoint: THREE.Vector3;
  normal: THREE.Vector3;
}

export class RoverCollisionSystem {
  public readonly restitution = 0.28; // Inelastic lunar composite collision
  public readonly minImpactSpeed = 1.5; // m/s threshold for structural damage
  public readonly defaultRadius = 1.6; // Rover half-length collision sphere

  public checkCollisions(rovers: RoverCollider[]): CollisionImpact[] {
    const impacts: CollisionImpact[] = [];
    const count = rovers.length;

    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const rA = rovers[i];
        const rB = rovers[j];

        // Horizontal planar separation
        const delta = new THREE.Vector3(
          rB.position.x - rA.position.x,
          0,
          rB.position.z - rA.position.z
        );
        const dist = delta.length();
        const minDist = rA.radius + rB.radius;

        if (dist < minDist && dist > 1e-4) {
          const normal = delta.clone().normalize();

          // Mass-weighted position separation
          const totalMass = rA.mass + rB.mass;
          const posA = rA.position.clone().add(normal.clone().multiplyScalar(-rA.radius * (rB.mass / totalMass)));
          const posB = rB.position.clone().add(normal.clone().multiplyScalar(rB.radius * (rA.mass / totalMass)));

          // Relative velocity
          const velDelta = rB.velocity.clone().sub(rA.velocity);
          const relativeSpeed = velDelta.dot(normal);

          if (relativeSpeed < 0) { // Only process approaching collisions
            // Calculate impulse magnitude
            const impulseMagnitude = (2 * rA.mass * rB.mass * relativeSpeed) / (totalMass * (1 - this.restitution));

            // Damage calculation based on closing velocity magnitude
            const closingSpeed = Math.abs(relativeSpeed);
            const damageA = closingSpeed > this.minImpactSpeed ? (closingSpeed - this.minImpactSpeed) * 1.5 : 0;
            const damageB = closingSpeed > this.minImpactSpeed ? (closingSpeed - this.minImpactSpeed) * 1.5 : 0;

            impacts.push({
              roverAId: rA.id,
              roverBId: rB.id,
              relativeSpeed,
              impulseMagnitude,
              damageA,
              damageB,
              impactPoint: posA.clone().add(posB.clone().sub(posA).multiplyScalar(0.5)),
              normal
            });
          }
        }
      }
    }

    return impacts;
  }
}