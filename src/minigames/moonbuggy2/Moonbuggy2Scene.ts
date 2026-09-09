import * as THREE from 'three';
import { SceneManager } from '../../engine/SceneManager';
import { EventBus } from '../../engine/Events';
import { PhotorealisticTerrain } from './PhotorealisticTerrain';
import { ApolloRoverModel } from './ApolloRoverModel';
import { LRVPhysics } from './LRVPhysics';
import { GamepadController } from './GamepadController';
import { Moonbuggy2HUD, HUDNotificationState } from './Moonbuggy2HUD';
import { LunarRockField, LunarRock } from './LunarRockField';
import { ScienceDropStation } from './ScienceDropStation';
import { RoboticArmController } from './RoboticArmController';
import { RoverCollisionSystem, RoverCollider } from './RoverCollisionSystem';
import { NPCCompetitorController, NPCCompetitor } from './NPCCompetitorController';
import { LunarWaveManager } from './LunarWaveManager';

interface DustParticle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

export class Moonbuggy2Scene {
  private sceneManager: SceneManager;
  private eventBus?: EventBus;
  public readonly scene: THREE.Scene;
  private terrain!: PhotorealisticTerrain;
  private model!: ApolloRoverModel;
  private physics!: LRVPhysics;
  private gamepad!: GamepadController;
  private hud!: Moonbuggy2HUD;
  private rockField!: LunarRockField;
  private dropStation!: ScienceDropStation;
  private armController!: RoboticArmController;

  private cameraMode: 'chase' | 'cockpit' = 'chase';
  private chaseCamPos = new THREE.Vector3();
  private chaseLookTarget = new THREE.Vector3();
  private keyState: Record<string, boolean> = {};
  private isDisposed = false;
  private activeTargetRock: LunarRock | null = null;
  private dockingMessage = '';
  private dockingMessageTimer = 0;
  private sunLight!: THREE.DirectionalLight;
  private contactShadow!: THREE.Mesh;
  private collisionSystem!: RoverCollisionSystem;
  private npcController!: NPCCompetitorController;
  private waveManager!: LunarWaveManager;
  private rivalDropStations: ScienceDropStation[] = [];
  private npcVisualGroups: { id: string; group: THREE.Group }[] = [];
  private playerDamage = 0;

  // Dust puff particles on sample retrieval
  private dustContainer!: THREE.Group;
  private dustParticles: DustParticle[] = [];
  private dustGeom!: THREE.DodecahedronGeometry;
  private dustMat!: THREE.MeshBasicMaterial;

  constructor(sceneManager: SceneManager, eventBus?: EventBus) {
    this.sceneManager = sceneManager;
    this.eventBus = eventBus;
    this.scene = new THREE.Scene();

    this.setupLighting();
    this.setupWorld();
    this.setupInput();
  }

  private setupLighting(): void {
    // 1. Deep Space Void Background
    this.scene.background = new THREE.Color(0x020205);
    this.scene.fog = new THREE.FogExp2(0x020205, 0.0018);

    // 2. High-Fidelity Cinematic Tone Mapping & PCF Soft Shadows
    const renderer = this.sceneManager.renderer;
    if (renderer) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    // 3. Perspective Field of View Adjustment for 3D Depth
    if (this.sceneManager.camera instanceof THREE.PerspectiveCamera) {
      this.sceneManager.camera.fov = 55;
      this.sceneManager.camera.updateProjectionMatrix();
    }

    // 4. Oblique High-Contrast Solar Key Light with Dynamic Rover Tracking
    this.sunLight = new THREE.DirectionalLight(0xfff7ed, 4.4);
    this.sunLight.position.set(-75, 60, -50);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 5;
    this.sunLight.shadow.camera.far = 250;
    this.sunLight.shadow.camera.left = -35;
    this.sunLight.shadow.camera.right = 35;
    this.sunLight.shadow.camera.top = 35;
    this.sunLight.shadow.camera.bottom = -35;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.025;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // 5. Earthshine Lunar Rim Lighting
    const earthshine = new THREE.DirectionalLight(0x38bdf8, 0.55);
    earthshine.position.set(120, 35, 90);
    this.scene.add(earthshine);

    // 6. Subtle Ambient Fill for Lunar Surface Shadows
    const ambientLight = new THREE.AmbientLight(0x0a101d, 0.22);
    this.scene.add(ambientLight);
  }

  private setupWorld(): void {
    // Photorealistic PBR Terrain
    this.terrain = new PhotorealisticTerrain(400, 180);
    this.scene.add(this.terrain.mesh);

    // 3D Apollo LRV Master Model (loads apollo_lrv.glb asynchronously)
    this.model = new ApolloRoverModel();
    this.scene.add(this.model.group);

    // Soft Ground Contact Shadow Plane
    let shadowTexture: THREE.Texture | null = null;
    if (typeof document !== 'undefined') {
      const shadowCanvas = document.createElement('canvas');
      shadowCanvas.width = 128;
      shadowCanvas.height = 128;
      const sCtx = shadowCanvas.getContext('2d');
      if (sCtx) {
        const grad = sCtx.createRadialGradient(64, 64, 10, 64, 64, 60);
        grad.addColorStop(0, 'rgba(0, 0, 0, 0.65)');
        grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.35)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        sCtx.fillStyle = grad;
        sCtx.fillRect(0, 0, 128, 128);
      }
      shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    }
    const shadowGeom = new THREE.PlaneGeometry(2.6, 3.8);
    shadowGeom.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
    });
    this.contactShadow = new THREE.Mesh(shadowGeom, shadowMat);
    this.contactShadow.position.set(0, 0.02, 0);
    this.model.group.add(this.contactShadow);

    // Dual Artemis LTV High-Intensity LED Headlights
    const leftHeadlight = new THREE.SpotLight(0xf8fafc, 45, 60, Math.PI / 4.5, 0.4, 1.2);
    leftHeadlight.position.set(-0.48, 0.55, -1.45);
    const leftTarget = new THREE.Object3D();
    leftTarget.position.set(-0.48, -0.3, -12.0);
    this.model.chassis.add(leftHeadlight);
    this.model.chassis.add(leftTarget);
    leftHeadlight.target = leftTarget;

    const rightHeadlight = new THREE.SpotLight(0xf8fafc, 45, 60, Math.PI / 4.5, 0.4, 1.2);
    rightHeadlight.position.set(0.48, 0.55, -1.45);
    const rightTarget = new THREE.Object3D();
    rightTarget.position.set(0.48, -0.3, -12.0);
    this.model.chassis.add(rightHeadlight);
    this.model.chassis.add(rightTarget);
    rightHeadlight.target = rightTarget;

    // Robotic Arm Controller
    this.armController = new RoboticArmController(this.model);

    // Lunar Rocks Field (loads lunar_rocks.glb asynchronously)
    this.rockField = new LunarRockField(this.terrain, 45);
    this.scene.add(this.rockField.group);

    // Science Drop Station at (0, 0) (loads lunar_drop_station.glb)
    this.dropStation = new ScienceDropStation(this.terrain);
    this.scene.add(this.dropStation.group);

    // Dedicated Rival Science Drop Stations per architecture blueprint
    // Outpost Beta (Valkyrie Mining Drone Station) at (-75, 45) with Amber Beacon
    const outpostBeta = new ScienceDropStation(this.terrain, -75, 45, 'Valkyrie Outpost Beta', 0xf59e0b);
    this.scene.add(outpostBeta.group);
    this.rivalDropStations.push(outpostBeta);

    // Outpost Gamma (Kaguya Autonomous Station) at (80, -60) with Purple Beacon
    const outpostGamma = new ScienceDropStation(this.terrain, 80, -60, 'Kaguya Outpost Gamma', 0xa855f7);
    this.scene.add(outpostGamma.group);
    this.rivalDropStations.push(outpostGamma);

    // Collision physics & NPC controller & Wave manager
    this.collisionSystem = new RoverCollisionSystem();
    this.npcController = new NPCCompetitorController();
    this.waveManager = new LunarWaveManager();

    // Spawn initial rival competitors
    this.spawnCompetitors();

    // Regolith Dust Particle Container
    this.dustContainer = new THREE.Group();
    this.scene.add(this.dustContainer);
    this.dustGeom = new THREE.DodecahedronGeometry(0.04, 0);
    this.dustMat = new THREE.MeshBasicMaterial({
      color: 0x94a3b8,
      transparent: true,
      opacity: 0.75,
    });

    // Analytical Multi-Body Physics with Spec 06 Dynamic Mass
    const spawnY = this.terrain.calculateHeight(0, 0) + 1.2;
    // Spawn 10m north of drop station facing south towards base
    this.physics = new LRVPhysics(this.terrain, new THREE.Vector3(0, spawnY, 10));

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

  private spawnDustPuff(pos: THREE.Vector3): void {
    const particleCount = 28;
    for (let i = 0; i < particleCount; i++) {
      const pMesh = new THREE.Mesh(this.dustGeom, this.dustMat.clone());
      pMesh.position.copy(pos);
      pMesh.position.x += (Math.random() - 0.5) * 0.4;
      pMesh.position.z += (Math.random() - 0.5) * 0.4;
      pMesh.position.y += 0.05 + Math.random() * 0.15;

      const angle = Math.random() * Math.PI * 2;
      const speed = 0.35 + Math.random() * 0.85;
      const vel = new THREE.Vector3(
        Math.cos(angle) * speed,
        0.85 + Math.random() * 1.4, // Upward initial velocity
        Math.sin(angle) * speed
      );

      const life = 1.0 + Math.random() * 0.8;
      this.dustContainer.add(pMesh);
      this.dustParticles.push({
        mesh: pMesh,
        vel,
        life,
        maxLife: life,
      });
    }
  }

  private spawnCompetitors(): void {
    const factions = [
      {
        id: 'valkyrie-01',
        name: 'Valkyrie Mining Drone',
        color: 0xf59e0b,
        basePos: new THREE.Vector3(-75, 0, 45),
        startPos: new THREE.Vector3(-65, 0, 40),
      },
      {
        id: 'kaguya-02',
        name: 'Kaguya Prospector',
        color: 0xa855f7,
        basePos: new THREE.Vector3(80, 0, -60),
        startPos: new THREE.Vector3(70, 0, -55),
      },
    ];

    for (const f of factions) {
      const groundY = this.terrain.calculateHeight(f.startPos.x, f.startPos.z) + 0.6;
      f.startPos.y = groundY;

      const competitor: NPCCompetitor = {
        id: f.id,
        name: f.name,
        position: f.startPos.clone(),
        velocity: new THREE.Vector3(0, 0, 0),
        heading: Math.random() * Math.PI * 2,
        mass: 700,
        radius: 1.6,
        isPlayer: false,
        damage: 0,
        totalDelivered: 0,
      };
      this.npcController.addCompetitor(competitor);

      // Create distinctive visual rover model for competitor with colored beacon
      const npcModel = new ApolloRoverModel();
      const beaconLight = new THREE.PointLight(f.color, 4.0, 18);
      beaconLight.position.set(0, 2.2, 0);
      npcModel.group.add(beaconLight);

      const beaconMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 0.4, 8),
        new THREE.MeshBasicMaterial({ color: f.color })
      );
      beaconMesh.position.set(0, 2.0, 0);
      npcModel.group.add(beaconMesh);

      npcModel.group.position.copy(f.startPos);
      this.scene.add(npcModel.group);
      this.npcVisualGroups.push({ id: f.id, group: npcModel.group });
    }
  }

  private setupInput(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keyState[e.code] = true;

    if (e.code === 'KeyC') {
      this.toggleCameraMode();
    }
    if (e.code === 'Escape') {
      this.exitToLobby();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keyState[e.code] = false;
  };

  private toggleCameraMode(): void {
    this.cameraMode = this.cameraMode === 'chase' ? 'cockpit' : 'chase';
  }

  private exitToLobby(): void {
    if (this.eventBus) {
      this.eventBus.emit('TRANSITION_TO_LOBBY', { reason: 'user_exit' });
    } else {
      window.location.hash = '';
      window.location.reload();
    }
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

    // 4. Update Drop Station & Arm Controller
    this.dropStation.update(delta);
    for (const st of this.rivalDropStations) {
      st.update(delta);
    }
    this.armController.update(delta);

    // 4b. Update NPC Competitors & Visual Models
    this.npcController.update(delta);
    const competitors = this.npcController.getCompetitors();
    for (const comp of competitors) {
      const visual = this.npcVisualGroups.find((v) => v.id === comp.id);
      if (visual) {
        const groundY = this.terrain.calculateHeight(comp.position.x, comp.position.z) + 0.6;
        visual.group.position.set(comp.position.x, groundY, comp.position.z);
        visual.group.rotation.y = comp.heading;
      }
    }

    // 4c. Vehicle-to-Vehicle Collision Detection & Impulse Physics
    const playerCollider: RoverCollider = {
      id: 'player',
      position: this.physics.position,
      velocity: this.physics.velocity,
      heading: this.physics.heading,
      mass: this.physics.currentMass,
      radius: 1.6,
      isPlayer: true,
      damage: this.playerDamage,
    };
    const allColliders: RoverCollider[] = [playerCollider, ...competitors];
    const impacts = this.collisionSystem.checkCollisions(allColliders);
    for (const imp of impacts) {
      if (imp.roverAId === 'player' || imp.roverBId === 'player') {
        const isA = imp.roverAId === 'player';
        const appliedDmg = isA ? imp.damageA : imp.damageB;
        this.playerDamage = Math.min(100, this.playerDamage + appliedDmg);

        // Apply physical bounce impulse to player velocity
        const bounceDir = isA ? imp.normal.clone().negate() : imp.normal.clone();
        const deltaV = Math.abs(imp.impulseMagnitude) / this.physics.currentMass;
        this.physics.velocity.addScaledVector(bounceDir, deltaV * 0.45);

        // Spawn regolith collision puff
        this.spawnDustPuff(imp.impactPoint);
      }
    }

    // 5. Update Regolith Dust Particles (1/6th lunar gravity g=1.62 m/s^2)
    for (let i = this.dustParticles.length - 1; i >= 0; i--) {
      const p = this.dustParticles[i];
      p.life -= delta;
      if (p.life <= 0) {
        this.dustContainer.remove(p.mesh);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
        this.dustParticles.splice(i, 1);
      } else {
        // Lunar gravity acceleration
        p.vel.y -= 1.62 * delta;
        p.mesh.position.addScaledVector(p.vel, delta);
        const alpha = p.life / p.maxLife;
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = alpha * 0.75;
        const scale = 1.0 + (1.0 - alpha) * 2.2;
        p.mesh.scale.set(scale, scale, scale);
      }
    }

    // 6. Check Science Drop Station Interaction at (0, 0)
    const inDockingZone = this.dropStation.isInDockingZone(this.physics.position);
    if (inDockingZone) {
      // Recharge power at +15%/s
      this.physics.rechargeBattery(this.physics.rechargeRate * delta);

      // Unload cargo rocks if any
      if (this.physics.rockCount > 0) {
        const unloaded = this.physics.clearCargoRocks();
        this.model.setCargoRockCount(0);
        this.dockingMessage = `STATION DOCKED: +${unloaded * 35} kg CARGO STORED & RECHARGING`;
        this.dockingMessageTimer = 3.5;
      }
    }

    if (this.dockingMessageTimer > 0) {
      this.dockingMessageTimer -= delta;
    }

    // 7. Check Rock Sampling Proximity
    this.activeTargetRock = this.rockField.getNearestUncollectedRock(this.physics.position, 4.2);
    const speedKmh = Math.abs(this.physics.forwardSpeed) * 3.6;
    const canSample = Boolean(
      this.activeTargetRock &&
      speedKmh < 10.0 &&
      this.physics.rockCount < this.physics.maxRocks &&
      !this.armController.isBusy() &&
      this.physics.batteryLevel > 0.02
    );

    // Trigger Robotic Arm directed pickup on Button A or Space
    if (canSample && (gp.handbrake || this.keyState['Space'])) {
      const target = this.activeTargetRock!;
      this.armController.triggerPickup({
        targetWorldPos: target.position,
        roverPos: this.physics.position,
        roverHeading: this.physics.heading,
        onGrab: () => {
          this.rockField.collectRock(target.id);
          this.spawnDustPuff(target.position);
        },
        onComplete: () => {
          this.physics.addCargoRock();
          this.model.setCargoRockCount(this.physics.rockCount);
          this.physics.drainBattery(0.015); // 1.5% action cost
        },
      });
    }

    // 8. Synchronize 3D Mesh Transforms
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

    // 8b. Dynamically track high-res solar shadow camera with the rover
    if (this.sunLight) {
      this.sunLight.target.position.copy(this.physics.position);
      this.sunLight.position.set(
        this.physics.position.x - 70,
        this.physics.position.y + 55,
        this.physics.position.z - 45
      );
    }

    // 9. Update Camera Rig (Chase or Cockpit)
    const camera = this.sceneManager.camera;
    const heading = this.physics.heading;

    if (this.cameraMode === 'chase') {
      // Moved back and up another buggy-length (~3.3m back, ~2.5m up) for true 3D perspective
      const backOffset = new THREE.Vector3(0, 0, 1)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), heading)
        .multiplyScalar(10.8);
      const idealCamPos = this.physics.position.clone().add(backOffset);
      idealCamPos.y += 5.7;

      const forwardOffset = new THREE.Vector3(0, 0, -1)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), heading)
        .multiplyScalar(5.5);
      const idealLook = this.physics.position.clone().add(forwardOffset);
      idealLook.y += 1.0;

      this.chaseCamPos.lerp(idealCamPos, Math.min(1.0, 7.0 * delta));
      this.chaseLookTarget.lerp(idealLook, Math.min(1.0, 10.0 * delta));

      camera.position.copy(this.chaseCamPos);
      camera.lookAt(this.chaseLookTarget);
    } else {
      // Astronaut First-Person Cockpit View (Commander Left Seat)
      const seatOffset = new THREE.Vector3(-0.38, 1.20, 0.15).applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        heading
      );
      camera.position.copy(this.physics.position).add(seatOffset);

      const lookTarget = this.physics.position
        .clone()
        .add(
          new THREE.Vector3(0, 0.4, -6.0).applyAxisAngle(
            new THREE.Vector3(0, 1, 0),
            heading
          )
        );
      camera.lookAt(lookTarget);
    }

    // 10. Synchronize Glass Cockpit HUD Readouts
    const distToBase = this.physics.position.distanceTo(new THREE.Vector3(0, 0, 0));
    // Calculate angle to base relative to vehicle heading
    const angleToBase = Math.atan2(-this.physics.position.x, -this.physics.position.z);
    let relBaseAngle = angleToBase - this.physics.heading;
    while (relBaseAngle > Math.PI) relBaseAngle -= Math.PI * 2;
    while (relBaseAngle < -Math.PI) relBaseAngle += Math.PI * 2;
    const bearingDeg = THREE.MathUtils.radToDeg(relBaseAngle);

    const navState: HUDNotificationState = {
      rockPrompt: canSample,
      dockingPrompt: inDockingZone,
      dockingText: this.dockingMessageTimer > 0 ? this.dockingMessage : undefined,
      compassDegrees: bearingDeg,
      distanceToBase: distToBase,
      hullDamage: this.playerDamage,
      waveInfo: `RUN: ${this.waveManager.waveState} | RIVALS: VALKYRIE (${competitors[0]?.totalDelivered ?? 0}), KAGUYA (${competitors[1]?.totalDelivered ?? 0})`,
    };

    this.hud.update(this.physics, gp, this.cameraMode, navState);
  }

  public dispose(): void {
    this.isDisposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.hud.destroy();
  }
}
