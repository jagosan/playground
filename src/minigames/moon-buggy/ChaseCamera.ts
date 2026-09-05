import * as THREE from 'three';
import { MoonRover } from './MoonRover';

export class ChaseCamera {
  private camera: THREE.PerspectiveCamera;
  private target: MoonRover;

  // Chase offsets relative to buggy
  private distance = 7.5;
  private height = 3.2;
  private lookAheadDistance = 4.0;
  private lookAheadHeight = 1.2;

  // Smoothing damping factors
  private followStiffness = 6.0;
  private lookStiffness = 10.0;

  private currentPosition = new THREE.Vector3();
  private currentLookTarget = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, target: MoonRover) {
    this.camera = camera;
    this.target = target;

    // Initialize camera position immediately behind rover
    this.snapToTarget();
  }

  public snapToTarget(): void {
    const heading = this.target.heading;
    const backwardDir = new THREE.Vector3(0, 0, 1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      heading
    );

    this.currentPosition
      .copy(this.target.position)
      .add(backwardDir.multiplyScalar(this.distance));
    this.currentPosition.y += this.height;

    this.currentLookTarget.copy(this.target.position);
    this.currentLookTarget.y += this.lookAheadHeight;

    this.camera.position.copy(this.currentPosition);
    this.camera.lookAt(this.currentLookTarget);
  }

  public update(delta: number): void {
    const dt = Math.min(delta, 0.1);
    const heading = this.target.heading;

    // Calculate ideal camera position behind the rover
    const backwardDir = new THREE.Vector3(0, 0, 1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      heading
    );
    const forwardDir = new THREE.Vector3(0, 0, -1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      heading
    );

    const idealPosition = this.target.position
      .clone()
      .add(backwardDir.multiplyScalar(this.distance));
    idealPosition.y += this.height;

    // Calculate ideal look-at point ahead of the rover
    const idealLookTarget = this.target.position
      .clone()
      .add(forwardDir.multiplyScalar(this.lookAheadDistance));
    idealLookTarget.y += this.lookAheadHeight;

    // Damped spherical/linear interpolation
    this.currentPosition.lerp(idealPosition, this.followStiffness * dt);
    this.currentLookTarget.lerp(idealLookTarget, this.lookStiffness * dt);

    this.camera.position.copy(this.currentPosition);
    this.camera.lookAt(this.currentLookTarget);
  }
}
