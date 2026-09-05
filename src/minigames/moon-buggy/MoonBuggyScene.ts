import * as THREE from 'three';
import { SceneManager } from '../../engine/SceneManager';
import { EventBus } from '../../engine/Events';
import { LunarTerrain } from './LunarTerrain';
import { MoonRover } from './MoonRover';
import { ChaseCamera } from './ChaseCamera';
import { MoonBuggyHUD } from './MoonBuggyHUD';

export class MoonBuggyScene {
  readonly scene: THREE.Scene;
  private sceneManager: SceneManager;
  private eventBus: EventBus;

  private terrain!: LunarTerrain;
  private rover!: MoonRover;
  private chaseCamera!: ChaseCamera;
  private hud!: MoonBuggyHUD;
  private keydownHandler!: (e: KeyboardEvent) => void;
  private isDisposed = false;

  constructor(sceneManager: SceneManager, eventBus: EventBus) {
    this.sceneManager = sceneManager;
    this.eventBus = eventBus;
    this.scene = new THREE.Scene();

    this.setupEnvironment();
    this.setupWorld();
    this.setupControls();
  }

  private setupEnvironment(): void {
    // True lunar space: Pitch black void
    this.scene.background = new THREE.Color(0x020205);

    // Deep space starfield
    const starGeom = new THREE.BufferGeometry();
    const starCount = 1200;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i += 3) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = 400 + Math.random() * 50;
      starPos[i] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i + 1] = Math.abs(r * Math.cos(phi)); // Hemisphere above ground
      starPos[i + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeom.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.5,
      sizeAttenuation: false,
    });
    const starField = new THREE.Points(starGeom, starMat);
    this.scene.add(starField);

    // Earth in the distant sky
    const earthGeom = new THREE.SphereGeometry(12, 16, 16);
    const earthMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8, // Vibrant blue marble
    });
    const earth = new THREE.Mesh(earthGeom, earthMat);
    earth.position.set(120, 160, -280);
    this.scene.add(earth);

    // Harsh directional sunlight (no atmosphere diffusion)
    const sunLight = new THREE.DirectionalLight(0xfffbeb, 2.2);
    sunLight.position.set(80, 100, 50);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 300;
    sunLight.shadow.camera.left = -60;
    sunLight.shadow.camera.right = 60;
    sunLight.shadow.camera.top = 60;
    sunLight.shadow.camera.bottom = -60;
    this.scene.add(sunLight);

    // Regolith ambient bounce
    const ambient = new THREE.AmbientLight(0x1e293b, 0.4);
    this.scene.add(ambient);
  }

  private setupWorld(): void {
    // Procedural cratered lunar terrain
    this.terrain = new LunarTerrain(320, 140);
    this.scene.add(this.terrain.mesh);

    // Spawn lunar rover safely at origin
    const spawnY = this.terrain.getHeightAt(0, 0) + 1.2;
    this.rover = new MoonRover(this.terrain, new THREE.Vector3(0, spawnY, 0));
    this.scene.add(this.rover.group);

    // Chase Camera
    this.chaseCamera = new ChaseCamera(this.sceneManager.camera, this.rover);

    // HUD Telemetry
    this.hud = new MoonBuggyHUD(this.rover, () => {
      this.exitToLobby();
    });
  }

  private setupControls(): void {
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        this.exitToLobby();
      }
    };
    window.addEventListener('keydown', this.keydownHandler);
  }

  public update(delta: number): void {
    if (this.isDisposed) return;
    this.rover.update(delta);
    this.chaseCamera.update(delta);
    this.hud.update(this.rover);
  }

  public exitToLobby(): void {
    if (this.isDisposed) return;
    this.dispose();
    this.eventBus.emit('TRANSITION_TO_LOBBY', { reason: 'User exited minigame' });
  }

  public dispose(): void {
    this.isDisposed = true;
    window.removeEventListener('keydown', this.keydownHandler);
    this.hud.destroy();
  }
}
