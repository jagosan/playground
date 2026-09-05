import * as THREE from 'three';
import { SceneManager } from '../../engine/SceneManager';
import { EventBus } from '../../engine/Events';
import { PhotorealisticTerrain } from './PhotorealisticTerrain';
import { ApolloRoverModel } from './ApolloRoverModel';
import { LRVPhysics } from './LRVPhysics';
import { GamepadController } from './GamepadController';
import { Moonbuggy2HUD } from './Moonbuggy2HUD';

export class Moonbuggy2Scene {
  readonly scene: THREE.Scene;
  private sceneManager: SceneManager;
  private eventBus: EventBus;

  private terrain!: PhotorealisticTerrain;
  private model!: ApolloRoverModel;
  private physics!: LRVPhysics;
  private gamepad!: GamepadController;
  private hud!: Moonbuggy2HUD;

  private cameraMode: 'chase' | 'cockpit' = 'chase';
  private chaseCamPos = new THREE.Vector3();
  private chaseLookTarget = new THREE.Vector3();
  private keyState: Record<string, boolean> = {};
  private keydownHandler!: (e: KeyboardEvent) => void;
  private keyupHandler!: (e: KeyboardEvent) => void;
  private isDisposed = false;

  constructor(sceneManager: SceneManager, eventBus: EventBus) {
    this.sceneManager = sceneManager;
    this.eventBus = eventBus;
    this.scene = new THREE.Scene();

    this.setupPhotorealisticEnvironment();
    this.setupWorld();
    this.setupInput();
  }

  private setupPhotorealisticEnvironment(): void {
    // 1. Deep Space Vacuum Skybox
    this.scene.background = new THREE.Color(0x010204);

    // High-density 2,500 Starfield Dome
    const starGeom = new THREE.BufferGeometry();
    const starCount = 2500;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i += 3) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = 550 + Math.random() * 80;
      starPos[i] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i + 1] = Math.abs(r * Math.cos(phi));
      starPos[i + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeom.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.2,
      sizeAttenuation: false,
    });
    this.scene.add(new THREE.Points(starGeom, starMat));

    // 2. Distant Earth (Photorealistic Blue Marble)
    const earthGeom = new THREE.SphereGeometry(18, 32, 32);
    const earthMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      roughness: 0.6,
      metalness: 0.2,
    });
    const earthMesh = new THREE.Mesh(earthGeom, earthMat);
    earthMesh.position.set(160, 220, -380);
    this.scene.add(earthMesh);

    // 3. Harsh Direct Sun (Collimated Vacuum Radiation)
    const sunLight = new THREE.DirectionalLight(0xfffdf5, 2.8);
    sunLight.position.set(120, 150, 70);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 4096;
    sunLight.shadow.mapSize.height = 4096;
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 400;
    sunLight.shadow.camera.left = -70;
    sunLight.shadow.camera.right = 70;
    sunLight.shadow.camera.top = 70;
    sunLight.shadow.camera.bottom = -70;
    sunLight.shadow.bias = -0.0003;
    this.scene.add(sunLight);

    // 4. Earthshine & Deep Regolith Ambient Bounce
    const earthShine = new THREE.DirectionalLight(0x0284c7, 0.45);
    earthShine.position.set(-160, -220, 380);
    this.scene.add(earthShine);

    const ambientLight = new THREE.AmbientLight(0x111827, 0.35);
    this.scene.add(ambientLight);
  }

  private setupWorld(): void {
    // Photorealistic PBR Terrain
    this.terrain = new PhotorealisticTerrain(400, 180);
    this.scene.add(this.terrain.mesh);

    // 3D Apollo LRV Master Model
    this.model = new ApolloRoverModel();
    this.scene.add(this.model.group);

    // Analytical Multi-Body Physics
    const spawnY = this.terrain.getHeightAt(0, 0) + 1.2;
    this.physics = new LRVPhysics(this.terrain, new THREE.Vector3(0, spawnY, 0));

    // Gamepad controller with GPD Win Max 2 analog triggers
    this.gamepad = new GamepadController(() => {
      this.toggleCameraMode();
    });

    // Glass Cockpit Telemetry HUD
    this.hud = new Moonbuggy2HUD(
      () => this.exitToLobby(),
      () => this.toggleCameraMode()
    );
  }

  private setupInput(): void {
    this.keydownHandler = (e: KeyboardEvent) => {
      this.keyState[e.code] = true;
      if (e.code === 'KeyC') {
        this.toggleCameraMode();
      }
      if (e.code === 'Escape') {
        this.exitToLobby();
      }
    };
    this.keyupHandler = (e: KeyboardEvent) => {
      this.keyState[e.code] = false;
    };

    window.addEventListener('keydown', this.keydownHandler);
    window.addEventListener('keyup', this.keyupHandler);
  }

  public toggleCameraMode(): void {
    this.cameraMode = this.cameraMode === 'chase' ? 'cockpit' : 'chase';
  }

  public update(delta: number): void {
    if (this.isDisposed) return;

    // 1. Poll Gamepad (GPD Win Max 2)
    const gp = this.gamepad.poll();

    // 2. Synthesize Gamepad + Keyboard Inputs
    let throttle = gp.throttle;
    if (this.keyState['KeyW'] || this.keyState['ArrowUp']) throttle = 1.0;

    let brake = gp.brake;
    if (this.keyState['KeyS'] || this.keyState['ArrowDown']) brake = 1.0;

    let steer = gp.steer;
    if (this.keyState['KeyA'] || this.keyState['ArrowLeft']) steer = -1.0;
    if (this.keyState['KeyD'] || this.keyState['ArrowRight']) steer = 1.0;

    const handbrake = gp.handbrake || Boolean(this.keyState['Space']);
    const reverse = gp.reverse || Boolean(this.keyState['KeyR']);

    // 3. Step 120Hz Physics
    this.physics.step(delta, throttle, brake, steer, handbrake, reverse);

    // 4. Synchronize 3D Mesh Transforms
    this.model.group.position.copy(this.physics.position);
    this.model.group.rotation.set(0, 0, 0);
    this.model.group.rotation.y = this.physics.heading;
    this.model.chassis.rotation.x = this.physics.pitch;
    this.model.chassis.rotation.z = this.physics.roll;

    // Synchronize 4 wheels
    const wheelPositions = this.physics.tires.map((t) => t.offset);
    const wheelRotations = this.physics.tires.map(
      (t) => new THREE.Euler(t.rotationX, 0, 0)
    );
    this.model.updateWheelTransforms(
      wheelPositions,
      wheelRotations,
      this.physics.steerAngle
    );

    // 5. Update Camera Rig (Chase or Cockpit)
    const camera = this.sceneManager.camera;
    const heading = this.physics.heading;

    if (this.cameraMode === 'chase') {
      const backOffset = new THREE.Vector3(0, 0, 1)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), heading)
        .multiplyScalar(7.5);
      const idealCamPos = this.physics.position.clone().add(backOffset);
      idealCamPos.y += 3.2;

      const forwardOffset = new THREE.Vector3(0, 0, -1)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), heading)
        .multiplyScalar(4.5);
      const idealLook = this.physics.position.clone().add(forwardOffset);
      idealLook.y += 1.2;

      this.chaseCamPos.lerp(idealCamPos, Math.min(1.0, 7.0 * delta));
      this.chaseLookTarget.lerp(idealLook, Math.min(1.0, 10.0 * delta));

      camera.position.copy(this.chaseCamPos);
      camera.lookAt(this.chaseLookTarget);
    } else {
      // Astronaut First-Person Cockpit View (Commander Left Seat)
      const seatOffset = new THREE.Vector3(-0.36, 1.15, 0.1).applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        heading
      );
      camera.position.copy(this.physics.position).add(seatOffset);

      const lookDir = new THREE.Vector3(0, -0.15, -5.0).applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        heading
      );
      camera.lookAt(camera.position.clone().add(lookDir));
    }

    // 6. Update Cockpit HUD
    this.hud.update(this.physics, gp, this.cameraMode);
  }

  public exitToLobby(): void {
    if (this.isDisposed) return;
    this.dispose();
    this.eventBus.emit('TRANSITION_TO_LOBBY', { reason: 'Returned to Lobby' });
  }

  public dispose(): void {
    this.isDisposed = true;
    window.removeEventListener('keydown', this.keydownHandler);
    window.removeEventListener('keyup', this.keyupHandler);
    this.hud.destroy();
  }
}
