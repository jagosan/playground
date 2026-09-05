import * as THREE from 'three';
import { EventBus } from '../engine/Events';
import { SceneManager } from '../engine/SceneManager';

export class Player {
  readonly mesh: THREE.Group;
  private sceneManager: SceneManager;
  private eventBus: EventBus;

  // State
  public position: THREE.Vector3 = new THREE.Vector3(0, 0, 10);
  public velocity: THREE.Vector3 = new THREE.Vector3();
  public yaw: number = 0;
  public pitch: number = 0;
  public viewMode: 'first' | 'third' = 'third';

  // Input state
  private keys: Record<string, boolean> = {};
  private isPointerLocked: boolean = false;

  // Constants
  private readonly MOVE_SPEED = 8.0;
  private readonly SPRINT_MULT = 1.6;
  private readonly JUMP_VELOCITY = 6.0;
  private readonly GRAVITY = -18.0;
  private readonly MOUSE_SENSITIVITY = 0.0022;

  // Camera settings
  private readonly FIRST_PERSON_EYE_HEIGHT = 1.6;
  private readonly THIRD_PERSON_OFFSET = new THREE.Vector3(0, 2.5, 5.0);
  private currentCameraPos = new THREE.Vector3();

  constructor(sceneManager: SceneManager, eventBus: EventBus) {
    this.sceneManager = sceneManager;
    this.eventBus = eventBus;

    this.mesh = this.buildAvatarMesh();
    this.mesh.position.copy(this.position);
    this.sceneManager.addPersistent(this.mesh);

    this.bindInputs();
  }

  private buildAvatarMesh(): THREE.Group {
    const group = new THREE.Group();

    // Retro low-poly blocky character
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x3b82f6 }); // Blue torso
    const headMat = new THREE.MeshLambertMaterial({ color: 0xfde047 }); // Yellow head
    const limbMat = new THREE.MeshLambertMaterial({ color: 0x1e293b }); // Dark legs

    // Torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.4), bodyMat);
    torso.position.y = 1.0;
    torso.castShadow = true;
    group.add(torso);

    // Head
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), headMat);
    head.position.y = 1.75;
    head.castShadow = true;
    group.add(head);

    // Visor / eyes to indicate facing direction
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.15, 0.1), new THREE.MeshBasicMaterial({ color: 0x0f172a }));
    visor.position.set(0, 1.75, 0.26);
    group.add(visor);

    // Legs
    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.7, 0.3), limbMat);
    leftLeg.position.set(-0.25, 0.35, 0);
    leftLeg.castShadow = true;
    group.add(leftLeg);

    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.7, 0.3), limbMat);
    rightLeg.position.set(0.25, 0.35, 0);
    rightLeg.castShadow = true;
    group.add(rightLeg);

    return group;
  }

  private bindInputs(): void {
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'KeyV') {
        this.toggleViewMode();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
    });

    const canvas = this.sceneManager.domElement;
    canvas.addEventListener('click', () => {
      if (!this.isPointerLocked) {
        canvas.requestPointerLock();
      }
    });

    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === canvas;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isPointerLocked) return;
      this.yaw -= e.movementX * this.MOUSE_SENSITIVITY;
      this.pitch -= e.movementY * this.MOUSE_SENSITIVITY;
      // Clamp vertical pitch (-85 to +85 deg)
      const maxPitch = Math.PI / 2 - 0.05;
      this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
    });
  }

  public toggleViewMode(): void {
    this.viewMode = this.viewMode === 'first' ? 'third' : 'first';
    this.mesh.visible = this.viewMode === 'third';
    this.eventBus.emit('VIEW_MODE_CHANGED', { mode: this.viewMode });
  }

  public update(delta: number): void {
    // 1. Calculate movement vectors based on yaw
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();

    let moveX = 0;
    let moveZ = 0;

    if (this.keys['KeyW'] || this.keys['ArrowUp']) moveZ += 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) moveZ -= 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) moveX -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) moveX += 1;

    const inputDir = new THREE.Vector3();
    if (moveZ !== 0) inputDir.addScaledVector(forward, moveZ);
    if (moveX !== 0) inputDir.addScaledVector(right, moveX);
    if (inputDir.lengthSq() > 0) inputDir.normalize();

    const speed = this.MOVE_SPEED * (this.keys['ShiftLeft'] || this.keys['ShiftRight'] ? this.SPRINT_MULT : 1.0);

    // Apply horizontal velocity
    this.position.x += inputDir.x * speed * delta;
    this.position.z += inputDir.z * speed * delta;

    // Jump & gravity
    if (this.keys['Space'] && this.position.y <= 0.01) {
      this.velocity.y = this.JUMP_VELOCITY;
    }

    this.velocity.y += this.GRAVITY * delta;
    this.position.y += this.velocity.y * delta;

    if (this.position.y < 0) {
      this.position.y = 0;
      this.velocity.y = 0;
    }

    // Sync avatar position & rotation
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.yaw;

    // 2. Camera positioning
    const camera = this.sceneManager.camera;
    if (this.viewMode === 'first') {
      camera.position.set(
        this.position.x,
        this.position.y + this.FIRST_PERSON_EYE_HEIGHT,
        this.position.z
      );
      camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    } else {
      // Third-person chase camera
      const rotMatrix = new THREE.Matrix4().makeRotationY(this.yaw);
      const pitchMatrix = new THREE.Matrix4().makeRotationX(this.pitch);
      const combined = rotMatrix.multiply(pitchMatrix);

      const offset = this.THIRD_PERSON_OFFSET.clone().applyMatrix4(combined);
      const targetCamPos = this.position.clone().add(new THREE.Vector3(0, 1.4, 0)).add(offset);

      // Smooth camera follow
      this.currentCameraPos.lerp(targetCamPos, Math.min(1.0, 15.0 * delta));
      camera.position.copy(this.currentCameraPos);

      const lookTarget = this.position.clone().add(new THREE.Vector3(0, 1.4, 0));
      camera.lookAt(lookTarget);
    }
  }

  public destroy(): void {
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    this.keys = {};
  }
}

