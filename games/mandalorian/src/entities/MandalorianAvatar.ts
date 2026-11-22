/**
 * Mandalorian: Nevarro Frontier — Procedural Beskar Armor Avatar (Spec 40 §3.2)
 *
 * Phase 2: NullEngine-safe procedural mesh hierarchy with T-visor helmet,
 * pauldrons, chestplate, cape, Z-6 jetpack with twin angled nozzles and
 * emissive orange-cyan thruster cones. Grounded walk/sprint and jetpack
 * flight animations via `update(state, dt)`.
 *
 * Strict Invariants:
 * - Pure procedural code (100% NullEngine-safe, zero DOM/canvas/GLB dependencies)
 * - TypeScript strict compliance (verbatimModuleSyntax, import type, noUncheckedIndexedAccess)
 * - Coordinate mapping: MandoPhysics uses (x,y,z) with z vertical; Babylon uses Y-up (x,z,y)
 */

import { Scene } from '@babylonjs/core/scene.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function createCylinder(
  scene: Scene,
  name: string,
  height: number,
  diameter: number,
  tessellation: number = 16,
  position?: Vector3,
  rotation?: Vector3,
): AbstractMesh {
  const mesh = MeshBuilder.CreateCylinder(
    name,
    { diameter, height, tessellation },
    scene,
  );
  if (position) mesh.position.copyFrom(position);
  if (rotation) {
    mesh.rotation.x = rotation.x;
    mesh.rotation.y = rotation.y;
    mesh.rotation.z = rotation.z;
  }
  return mesh;
}

function createBox(
  scene: Scene,
  name: string,
  width: number,
  height: number,
  depth: number,
  position?: Vector3,
): AbstractMesh {
  const mesh = MeshBuilder.CreateBox(
    name,
    { width, height, depth },
    scene,
  );
  if (position) mesh.position.copyFrom(position);
  return mesh;
}

function createSphere(
  scene: Scene,
  name: string,
  diameter: number,
  segments: number = 16,
  position?: Vector3,
): AbstractMesh {
  const mesh = MeshBuilder.CreateSphere(
    name,
    { diameter, segments },
    scene,
  );
  if (position) mesh.position.copyFrom(position);
  return mesh;
}

function createCone(
  scene: Scene,
  name: string,
  height: number,
  bottomDiameter: number,
  topDiameter: number = 0,
  tessellation: number = 16,
  position?: Vector3,
  rotation?: Vector3,
): AbstractMesh {
  const mesh = MeshBuilder.CreateCylinder(
    name,
    { diameterBottom: bottomDiameter, diameterTop: topDiameter, height, tessellation },
    scene,
  );
  if (position) mesh.position.copyFrom(position);
  if (rotation) {
    mesh.rotation.x = rotation.x;
    mesh.rotation.y = rotation.y;
    mesh.rotation.z = rotation.z;
  }
  return mesh;
}

function createDisc(
  scene: Scene,
  name: string,
  radius: number,
  tessellation: number = 16,
  position?: Vector3,
  rotation?: Vector3,
): AbstractMesh {
  const mesh = MeshBuilder.CreateDisc(
    name,
    { radius, tessellation },
    scene,
  );
  if (position) mesh.position.copyFrom(position);
  if (rotation) {
    mesh.rotation.x = rotation.x;
    mesh.rotation.y = rotation.y;
    mesh.rotation.z = rotation.z;
  }
  return mesh;
}

// ============================================================================
// MATERIAL CREATION
// ============================================================================

function createBeskarMaterial(scene: Scene, name: string): PBRMaterial {
  const mat = new PBRMaterial(name, scene);
  mat.albedoColor = new Color3(0.72, 0.76, 0.8); // #b8c2cc
  mat.emissiveColor = new Color3(0.05, 0.05, 0.08);
  mat.metallic = 0.9;
  mat.roughness = 0.25;
  return mat;
}

function createTVisorMaterial(scene: Scene, name: string): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = new Color3(0.035, 0.05, 0.078); // #090d14
  mat.emissiveColor = new Color3(0.01, 0.01, 0.015);
  return mat;
}

function createFlightSuitMaterial(scene: Scene, name: string): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = new Color3(0.169, 0.149, 0.137); // #2b2623
  mat.emissiveColor = new Color3(0.02, 0.02, 0.02);
  return mat;
}

function createBandolierMaterial(scene: Scene, name: string): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = new Color3(0.36, 0.227, 0.129); // #5c3a21
  mat.emissiveColor = new Color3(0.02, 0.015, 0.01);
  return mat;
}

function createCapeMaterial(scene: Scene, name: string): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = new Color3(0.184, 0.169, 0.157); // #2f2b28
  mat.emissiveColor = new Color3(0.01, 0.01, 0.01);
  return mat;
}

function createJetpackMaterial(scene: Scene, name: string): PBRMaterial {
  const mat = new PBRMaterial(name, scene);
  mat.albedoColor = new Color3(0.6, 0.62, 0.64); // silver/slate
  mat.emissiveColor = new Color3(0.02, 0.02, 0.02);
  mat.metallic = 0.7;
  mat.roughness = 0.35;
  return mat;
}

function createThrusterMaterial(
  scene: Scene,
  name: string,
  isLeft: boolean,
): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  // Emissive orange-cyan gradient based on side
  if (isLeft) {
    mat.diffuseColor = new Color3(1.0, 0.4, 0.15); // orange
    mat.emissiveColor = new Color3(1.0, 0.5, 0.2); // bright orange
  } else {
    mat.diffuseColor = new Color3(0.15, 0.8, 1.0); // cyan
    mat.emissiveColor = new Color3(0.2, 0.9, 1.0); // bright cyan
  }
  return mat;
}

// ============================================================================
// MANDALORIANAVATAR CLASS
// ============================================================================

/**
 * Procedural Beskar armor avatar with T-visor helmet, pauldrons, chestplate,
 * cape, and Z-6 jetpack with twin thruster cones.
 */
export class MandalorianAvatar {
  public readonly root: TransformNode;
  public readonly parts: Record<string, AbstractMesh | TransformNode>;

  private readonly _materials: (StandardMaterial | PBRMaterial)[] = [];
  private readonly _thrusterMaterials: StandardMaterial[] = [];

  /**
   * Create a procedural Beskar armor Mandalorian avatar.
   * @param scene Babylon.js scene
   */
  constructor(scene: Scene) {
    // Create root transform node
    this.root = new TransformNode('MandalorianRoot', scene);

    // Create parts registry
    this.parts = {};

    // Create materials
    const beskarMat = createBeskarMaterial(scene, 'Mando_Beskar');
    const tVisorMat = createTVisorMaterial(scene, 'Mando_TVisor');
    const flightSuitMat = createFlightSuitMaterial(scene, 'Mando_FlightSuit');
    const bandolierMat = createBandolierMaterial(scene, 'Mando_Bandolier');
    const capeMat = createCapeMaterial(scene, 'Mando_Cape');
    const jetpackMat = createJetpackMaterial(scene, 'Mando_Jetpack');

    // Store materials for disposal
    this._materials.push(beskarMat, tVisorMat, flightSuitMat, bandolierMat, capeMat, jetpackMat);

    // ====================
    // HELMET ASSEMBLY
    // ====================

    // Helmet base (rounded dome)
    const helmetBase = createCylinder(scene, 'helmet', 0.45, 0.32, 32);
    helmetBase.position.y = 0.68;
    helmetBase.parent = this.root;
    helmetBase.material = beskarMat;
    this.parts.helmet = helmetBase;

    // T-visor (dark recessed eye slit)
    const tVisor = createBox(scene, 'tVisor', 0.22, 0.06, 0.18);
    tVisor.position.set(0, 0.68, 0.24);
    tVisor.rotation.x = -Math.PI / 6;
    tVisor.parent = this.root;
    tVisor.material = tVisorMat;
    this.parts.tVisor = tVisor;

    // Rangefinder stalk (right earcap)
    const rangefinder = createCylinder(scene, 'rangefinder', 0.18, 0.025, 8);
    rangefinder.position.set(0.16, 0.78, 0.22);
    rangefinder.rotation.z = -Math.PI / 4;
    rangefinder.parent = this.root;
    rangefinder.material = beskarMat;
    this.parts.rangefinder = rangefinder;

    // ====================
    // CHESTPLATE ASSEMBLY
    // ====================

    // Chestplate (main torso armor)
    const chestplate = createBox(scene, 'chestplate', 0.38, 0.55, 0.18);
    chestplate.position.set(0, 0.42, 0.08);
    chestplate.parent = this.root;
    chestplate.material = beskarMat;
    this.parts.chestplate = chestplate;

    // Bandolier (brown leather belt across chest)
    const bandolier = createBox(scene, 'bandolier', 0.42, 0.12, 0.08);
    bandolier.position.set(0, 0.32, 0.16);
    bandolier.parent = this.root;
    bandolier.material = bandolierMat;
    this.parts.bandolier = bandolier;

    // ====================
    // PAULDRONS (SHOULDER ARMOR)
    // ====================

    // Left pauldron
    const pauldronLeft = createCylinder(scene, 'pauldronLeft', 0.28, 0.38, 16);
    pauldronLeft.position.set(-0.28, 0.58, 0.02);
    pauldronLeft.rotation.z = Math.PI / 4;
    pauldronLeft.parent = this.root;
    pauldronLeft.material = beskarMat;
    this.parts.pauldronLeft = pauldronLeft;

    // Right pauldron (with Mudhorn-inspired accent - small circular emblem)
    const pauldronRight = createCylinder(scene, 'pauldronRight', 0.28, 0.38, 16);
    pauldronRight.position.set(0.28, 0.58, 0.02);
    pauldronRight.rotation.z = -Math.PI / 4;
    pauldronRight.parent = this.root;
    pauldronRight.material = beskarMat;
    this.parts.pauldronRight = pauldronRight;

    const pauldronAccent = createSphere(scene, 'pauldronAccent', 0.06, 8);
    pauldronAccent.position.set(0.32, 0.58, 0.18);
    pauldronAccent.parent = pauldronRight;
    pauldronAccent.material = beskarMat;

    // ====================
    // CAPE (multi-segment articulated)
    // ====================

    // Cape anchor at upper back
    const capeAnchor = new TransformNode('capeAnchor', scene);
    capeAnchor.position.set(0, 0.55, -0.12);
    capeAnchor.parent = this.root;

    // Cape segments (4 segments for articulation)
    const capeSegments: AbstractMesh[] = [];
    for (let i = 0; i < 4; i++) {
      const segment = createBox(scene, `capeSegment${i}`, 0.32, 0.18 + i * 0.05, 0.02);
      segment.position.set(0, -0.12 - i * 0.22, 0);
      segment.parent = capeAnchor;
      segment.material = capeMat;
      capeSegments.push(segment);
    }

    // Store cape segments for animation
    (this.parts as any).capeSegments = capeSegments;
    this.parts.cape = capeAnchor; // Main cape reference

    // ====================
    // JETPACK ASSEMBLY (Z-6 with twin angled nozzles)
    // ====================

    // Jetpack main body
    const jetpackBody = createCylinder(scene, 'jetpackBody', 0.52, 0.28, 16);
    jetpackBody.position.set(0, 0.38, -0.22);
    jetpackBody.parent = this.root;
    jetpackBody.material = jetpackMat;
    this.parts.jetpack = jetpackBody;

    // Central thruster bell
    const thrusterBell = createCone(scene, 'thrusterBell', 0.18, 0.24, 0.16, 16);
    thrusterBell.position.set(0, 0.12, -0.34);
    thrusterBell.rotation.x = Math.PI; // Point backward
    thrusterBell.parent = this.root;
    thrusterBell.material = jetpackMat;
    this.parts.thrusterBell = thrusterBell;

    // Left nozzle (angled)
    const nozzleLeft = createCylinder(scene, 'nozzleLeft', 0.16, 0.08, 16);
    nozzleLeft.position.set(-0.12, 0.32, -0.28);
    nozzleLeft.rotation.z = Math.PI / 6;
    nozzleLeft.parent = this.root;
    nozzleLeft.material = jetpackMat;
    this.parts.nozzleLeft = nozzleLeft;

    // Right nozzle (angled)
    const nozzleRight = createCylinder(scene, 'nozzleRight', 0.16, 0.08, 16);
    nozzleRight.position.set(0.12, 0.32, -0.28);
    nozzleRight.rotation.z = -Math.PI / 6;
    nozzleRight.parent = this.root;
    nozzleRight.material = jetpackMat;
    this.parts.nozzleRight = nozzleRight;

    // Left thruster cone (emissive)
    const thrusterLeft = createCone(scene, 'thrusterLeft', 0.25, 0.18, 0.02, 16);
    thrusterLeft.position.set(-0.14, 0.38, -0.42);
    thrusterLeft.rotation.x = Math.PI; // Point backward
    thrusterLeft.parent = this.root;
    const thrusterLeftMat = createThrusterMaterial(scene, 'thrusterLeftMat', true);
    thrusterLeft.material = thrusterLeftMat;
    this._thrusterMaterials.push(thrusterLeftMat);
    this.parts.thrusterLeft = thrusterLeft;

    // Right thruster cone (emissive)
    const thrusterRight = createCone(scene, 'thrusterRight', 0.25, 0.18, 0.02, 16);
    thrusterRight.position.set(0.14, 0.38, -0.42);
    thrusterRight.rotation.x = Math.PI; // Point backward
    thrusterRight.parent = this.root;
    const thrusterRightMat = createThrusterMaterial(scene, 'thrusterRightMat', false);
    thrusterRight.material = thrusterRightMat;
    this._thrusterMaterials.push(thrusterRightMat);
    this.parts.thrusterRight = thrusterRight;

    // ====================
    // LIMBS
    // ====================

    // Torso (upper body connection)
    const torso = createCylinder(scene, 'torso', 0.5, 0.28, 16);
    torso.position.set(0, 0.35, 0);
    torso.parent = this.root;
    torso.material = flightSuitMat;
    this.parts.torso = torso;

    // Pelvis (lower body connection)
    const pelvis = createCylinder(scene, 'pelvis', 0.18, 0.26, 16);
    pelvis.position.set(0, 0.1, 0);
    pelvis.parent = this.root;
    pelvis.material = flightSuitMat;
    this.parts.pelvis = pelvis;

    // Head (top of helmet hierarchy)
    const head = new TransformNode('head', scene);
    head.position.set(0, 0.85, 0);
    head.parent = this.root;
    this.parts.head = head;

    // ====================
    // LEFT ARM
    // ====================

    const leftArm = new TransformNode('leftArm', scene);
    leftArm.position.set(-0.26, 0.52, 0);
    leftArm.parent = torso;
    this.parts.leftArm = leftArm;

    const leftUpperArm = createCylinder(scene, 'leftUpperArm', 0.35, 0.11, 16);
    leftUpperArm.position.set(0, -0.12, 0);
    leftUpperArm.parent = leftArm;
    leftUpperArm.material = flightSuitMat;

    const leftShoulderPad = createCylinder(scene, 'leftShoulderPad', 0.18, 0.22, 16);
    leftShoulderPad.position.set(0, -0.02, 0);
    leftShoulderPad.parent = leftArm;
    leftShoulderPad.material = beskarMat;
    this.parts.leftShoulderPad = leftShoulderPad;

    const leftForearm = new TransformNode('leftForearm', scene);
    leftForearm.position.set(0, -0.28, 0);
    leftForearm.parent = leftUpperArm;
    this.parts.leftForearm = leftForearm;

    const leftHand = createCylinder(scene, 'leftHand', 0.15, 0.09, 16);
    leftHand.position.set(0, -0.12, 0);
    leftHand.parent = leftForearm;
    leftHand.material = flightSuitMat;

    // ====================
    // RIGHT ARM
    // ====================

    const rightArm = new TransformNode('rightArm', scene);
    rightArm.position.set(0.26, 0.52, 0);
    rightArm.parent = torso;
    this.parts.rightArm = rightArm;

    const rightUpperArm = createCylinder(scene, 'rightUpperArm', 0.35, 0.11, 16);
    rightUpperArm.position.set(0, -0.12, 0);
    rightUpperArm.parent = rightArm;
    rightUpperArm.material = flightSuitMat;

    const rightShoulderPad = createCylinder(scene, 'rightShoulderPad', 0.18, 0.22, 16);
    rightShoulderPad.position.set(0, -0.02, 0);
    rightShoulderPad.parent = rightArm;
    rightShoulderPad.material = beskarMat;
    this.parts.rightShoulderPad = rightShoulderPad;

    const rightForearm = new TransformNode('rightForearm', scene);
    rightForearm.position.set(0, -0.28, 0);
    rightForearm.parent = rightUpperArm;
    this.parts.rightForearm = rightForearm;

    const rightHand = createCylinder(scene, 'rightHand', 0.15, 0.09, 16);
    rightHand.position.set(0, -0.12, 0);
    rightHand.parent = rightForearm;
    rightHand.material = flightSuitMat;

    // ====================
    // LEFT LEG
    // ====================

    const leftLeg = new TransformNode('leftLeg', scene);
    leftLeg.position.set(-0.12, 0, 0);
    leftLeg.parent = pelvis;
    this.parts.leftLeg = leftLeg;

    const leftUpperLeg = createCylinder(scene, 'leftUpperLeg', 0.45, 0.13, 16);
    leftUpperLeg.position.set(0, -0.18, 0);
    leftUpperLeg.parent = leftLeg;
    leftUpperLeg.material = flightSuitMat;

    const leftGreave = createCylinder(scene, 'leftGreave', 0.42, 0.11, 16);
    leftGreave.position.set(0, -0.32, 0);
    leftGreave.parent = leftUpperLeg;
    leftGreave.material = beskarMat;
    this.parts.leftGreave = leftGreave;

    const leftBoot = createCylinder(scene, 'bootLeft', 0.18, 0.14, 16);
    leftBoot.position.set(0, -0.52, 0);
    leftBoot.parent = leftGreave;
    leftBoot.material = flightSuitMat;
    this.parts.bootLeft = leftBoot;

    // ====================
    // RIGHT LEG
    // ====================

    const rightLeg = new TransformNode('rightLeg', scene);
    rightLeg.position.set(0.12, 0, 0);
    rightLeg.parent = pelvis;
    this.parts.rightLeg = rightLeg;

    const rightUpperLeg = createCylinder(scene, 'rightUpperLeg', 0.45, 0.13, 16);
    rightUpperLeg.position.set(0, -0.18, 0);
    rightUpperLeg.parent = rightLeg;
    rightUpperLeg.material = flightSuitMat;

    const rightGreave = createCylinder(scene, 'rightGreave', 0.42, 0.11, 16);
    rightGreave.position.set(0, -0.32, 0);
    rightGreave.parent = rightUpperLeg;
    rightGreave.material = beskarMat;
    this.parts.rightGreave = rightGreave;

    const rightBoot = createCylinder(scene, 'bootRight', 0.18, 0.14, 16);
    rightBoot.position.set(0, -0.52, 0);
    rightBoot.parent = rightGreave;
    rightBoot.material = flightSuitMat;
    this.parts.bootRight = rightBoot;
  }

  /**
   * Update avatar animation based on physics state.
   * @param state MandoPhysics state
   * @param dt Delta time in seconds
   */
  public update(state: any, dt: number): void {
    // Coordinate mapping: MandoPhysics (x,y,z) with z vertical -> Babylon Y-up (x,z,y)
    this.root.position.set(state.x, state.z, state.y);

    // Set heading (rotation around Y axis)
    this.root.rotation.y = state.heading;

    // Handle jetpack thruster visibility/scale
    const thrusterScale = state.isJetpacking ? 1.0 : 0.0;
    if (this.parts.thrusterLeft) {
      (this.parts.thrusterLeft as AbstractMesh).scaling.set(thrusterScale, thrusterScale, thrusterScale);
    }
    if (this.parts.thrusterRight) {
      (this.parts.thrusterRight as AbstractMesh).scaling.set(thrusterScale, thrusterScale, thrusterScale);
    }

    // ====================
    // ANIMATION STATES
    // ====================

    const isMoving = state.speedRatio > 0.1;
    const isJetpacking = state.isJetpacking;

    if (isJetpacking) {
      // Jetpack flight pose: slight forward pitch, bent knees, arms balanced
      this._updateFlightPose(state, dt);
    } else if (isMoving && state.isGrounded) {
      // Walk/sprint animation
      this._updateWalkPose(state, dt);
    } else {
      // Idle pose with breathing
      this._updateIdlePose(state, dt);
    }

    // Update cape based on speed and jetpack
    this._updateCape(state, dt);
  }

  /**
   * Update flight pose during jetpack usage.
   */
  private _updateFlightPose(state: any, dt: number): void {
    // Slight forward pitch (~12 degrees)
    this.root.rotation.x = -0.21;

    // Bent knees in flight posture
    const kneeBend = 0.35;
    if (this.parts.leftLeg) {
      this.parts.leftLeg.rotation.x = kneeBend;
    }
    if (this.parts.rightLeg) {
      this.parts.rightLeg.rotation.x = kneeBend;
    }

    // Arms balanced outward/aft
    if (this.parts.leftArm) {
      this.parts.leftArm.rotation.set(-0.3, 0.4, -0.2);
      if (this.parts.leftForearm) {
        this.parts.leftForearm.rotation.set(0.15, 0, 0);
      }
    }
    if (this.parts.rightArm) {
      this.parts.rightArm.rotation.set(-0.3, -0.4, 0.2);
      if (this.parts.rightForearm) {
        this.parts.rightForearm.rotation.set(0.15, 0, 0);
      }
    }
  }

  /**
   * Update walk/sprint animation.
   */
  private _updateWalkPose(state: any, dt: number): void {
    // Reset pitch
    this.root.rotation.x = 0;

    const phase = state.stridePhase;
    const speedRatio = Math.min(state.speedRatio, 1.5);
    const swingAmount = 0.8 * speedRatio;

    // Legs alternate with sin(stridePhase)
    const leftLegAngle = Math.sin(phase) * swingAmount;
    const rightLegAngle = Math.sin(phase + Math.PI) * swingAmount;

    if (this.parts.leftLeg) {
      this.parts.leftLeg.rotation.x = leftLegAngle;
    }
    if (this.parts.rightLeg) {
      this.parts.rightLeg.rotation.x = rightLegAngle;
    }

    // Arms counter-swing
    const armSwingAmount = 0.7 * speedRatio;
    const leftArmAngle = Math.sin(phase + Math.PI) * armSwingAmount;
    const rightArmAngle = Math.sin(phase) * armSwingAmount;

    if (this.parts.leftArm) {
      this.parts.leftArm.rotation.x = leftArmAngle;
      // Slight forward lean when moving
      this.parts.leftArm.rotation.z = 0.1;
    }
    if (this.parts.rightArm) {
      this.parts.rightArm.rotation.x = rightArmAngle;
      this.parts.rightArm.rotation.z = -0.1;
    }

    // Subtle body sway
    this.root.rotation.z = Math.sin(phase * 2) * 0.03 * speedRatio;
  }

  /**
   * Update idle pose with breathing animation.
   */
  private _updateIdlePose(state: any, dt: number): void {
    // Reset pitch and rotation
    this.root.rotation.x = 0;
    this.root.rotation.z = 0;

    // Legs straight but with slight knee bend for natural posture
    if (this.parts.leftLeg) {
      this.parts.leftLeg.rotation.x = 0.1;
    }
    if (this.parts.rightLeg) {
      this.parts.rightLeg.rotation.x = 0.1;
    }

    // Arms relaxed at sides
    if (this.parts.leftArm) {
      this.parts.leftArm.rotation.set(0.2, 0.15, 0);
      if (this.parts.leftForearm) {
        this.parts.leftForearm.rotation.set(0.1, 0, 0);
      }
    }
    if (this.parts.rightArm) {
      this.parts.rightArm.rotation.set(0.2, -0.15, 0);
      if (this.parts.rightForearm) {
        this.parts.rightForearm.rotation.set(0.1, 0, 0);
      }
    }

    // Breathing animation (subtle chest expansion)
    const breathPhase = Date.now() * 0.002;
    const chestScaleY = 1 + Math.sin(breathPhase) * 0.015;

    if (this.parts.torso) {
      (this.parts.torso as AbstractMesh).scaling.y = 1 + Math.sin(breathPhase) * 0.02;
    }
    if (this.parts.chestplate) {
      (this.parts.chestplate as AbstractMesh).scaling.y = 1 + Math.sin(breathPhase) * 0.01;
    }
  }

  /**
   * Update cape position and animation.
   */
  private _updateCape(state: any, dt: number): void {
    const segments = (this.parts as any).capeSegments as AbstractMesh[];
    if (!segments || segments.length === 0) return;

    // Cape trailing based on horizontal speed
    const speedRatio = Math.min(state.speedRatio, 1.5);

    // Cape fluttering during jetpack
    const flutterPhase = Date.now() * (state.isJetpacking ? 0.025 : 0.01);

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment) continue;

      // Base offset along negative Y (down the back)
      const baseOffset = -0.12 - i * 0.22;

      // Trailing offset based on speed
      const trailing = -speedRatio * 0.15 * (i + 1);

      // Flutter offset for jetpack flight
      const flutter = state.isJetpacking ? Math.sin(flutterPhase + i * 0.8) * 0.05 : 0;

      // Apply offsets relative to parent
      segment.position.y = baseOffset + trailing;
      segment.position.x = flutter;
    }
  }

  /**
   * Cleanly dispose of all meshes and materials.
   */
  public dispose(): void {
    // Dispose root and all children
    if (this.root) {
      this.root.dispose();
    }

    // Dispose materials
    for (const mat of this._materials) {
      mat.dispose();
    }
    for (const mat of this._thrusterMaterials) {
      mat.dispose();
    }

    // Clear parts reference
    this.parts.pelvis = undefined as any;
    this.parts.torso = undefined as any;
    this.parts.head = undefined as any;
    this.parts.helmet = undefined as any;
    this.parts.tVisor = undefined as any;
    this.parts.rangefinder = undefined as any;
    this.parts.pauldronLeft = undefined as any;
    this.parts.pauldronRight = undefined as any;
    this.parts.chestplate = undefined as any;
    this.parts.bandolier = undefined as any;
    this.parts.cape = undefined as any;
    this.parts.jetpack = undefined as any;
    this.parts.nozzleLeft = undefined as any;
    this.parts.nozzleRight = undefined as any;
    this.parts.thrusterLeft = undefined as any;
    this.parts.thrusterRight = undefined as any;
    this.parts.leftArm = undefined as any;
    this.parts.rightArm = undefined as any;
    this.parts.leftLeg = undefined as any;
    this.parts.rightLeg = undefined as any;
    this.parts.bootLeft = undefined as any;
    this.parts.bootRight = undefined as any;
  }
}
