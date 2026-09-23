/**
 * Lunar Frontier — subterranean + surface rail lines with automated ore carts
 * (TASK-PLAY-048b).
 *
 * Dresses the EXISTING world generator output (`LunarWorldGenerator` →
 * `WorldSnapshot` rail routes) in Babylon.js track geometry and runs ore
 * trains on it. Motion is delegated to EXACTLY ONE `RailCar` instance per
 * cart from ../physics/TraversalPhysics.ts — no gravity, no Davis resistance,
 * no numerical integration and no duplicated physics tuning lives in this
 * file. Route identities, node chains and per-route gauge are consumed
 * verbatim as `RailRoute` / `LunarNode` records.
 *
 * Meshes (procedural only, no GLB):
 *  - Per route, dual steel rails: parallel `CreateTube` ribbons spaced by the
 *    route's own gauge (`RailRoute.gauge`, narrow-gauge 0.75 m) along the 3D
 *    polyline through the route's node positions — surface runs, tunnel ramps
 *    and inclined shaft descents alike — in metallic PBR steel (`rail-rail-*`).
 *  - Per route, transverse ties/sleepers every ~1.2 m: boxes laid
 *    perpendicular to the local track tangent (yaw+pitch from it), merged
 *    into one mesh per route in a weathered dark composite (`rail-tie-*`).
 *  - Per cart (`ore-cart-*`): hopper body box, frame skid, four flanged steel
 *    wheels (tread + twin flanges merged, axle across the gauge) and an
 *    internal cargo payload box whose height scales with load fraction of
 *    RAIL_CAR_MAX_PAYLOAD_KG (bottom-filled: origin baked at the floor).
 *
 * Coordinates: world metres (x, y lateral, z up) map to Babylon (x, z↑, -y)
 * via the shared `worldToBabylon` from CameraRig — track, carts, camera and
 * physics cannot disagree about where a rail line lives. Cart orientation is
 * rebuilt every frame from the track tangent: yaw = atan2(fx, fz),
 * pitch = -asin(fy) composed YXZ, which maps model +z exactly onto the
 * Babylon-frame tangent, straight-down shaft sections included.
 *
 * Note on constants: TraversalPhysics exports no gauge/tare/payload aliases
 * (verified against its export surface), and this module must not modify it —
 * so the drawing-domain trio below is defined once here, DERIVED from the
 * physics module where an anchor exists (tare = `DEFAULT_RAIL_CAR.mass`), and
 * every numerical rail dynamic (Davis A/B/C, gravity, braking, mass clamps)
 * stays exclusively inside `RailCar`.
 *
 * Headless-safe: `init()` accepts a Scene, a raw engine (a scene is created
 * around it), or nothing (self-owned NullEngine fallback). `dispose()` is
 * idempotent and never throws; after disposal `update()` is a safe no-op, all
 * queries answer empty/null, and `init()` refuses with a clear error.
 *
 * Usage:
 *   const world = new LunarWorldGenerator('mala-voyage-2431').generate();
 *   const rails = new RailSystem(world).init(scene);
 *   const cart = rails.spawnCart('rail-001');
 *   rails.update(1 / 60, new Map([['ore-cart-1', { throttle: 4, dynamicBrake: 0, pneumaticBrake: 0 }]]));
 *   if (cart?.isAtTerminal()) unload(cart.getCargoMass());
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';

import { worldToBabylon } from '../engine/CameraRig.ts';
import {
  DEFAULT_RAIL_CAR,
  IDLE_RAIL_COMMAND,
  RailCar,
  type RailCarCommand,
  type RailCarSpec,
  type RailCarState,
} from '../physics/TraversalPhysics.ts';
import type { LunarNode, RailRoute, Vec3, WorldSnapshot } from '../world/LunarWorldGenerator.ts';

// -- drawing-domain constants (physics truths live in TraversalPhysics) --------

/**
 * Narrow-gauge track width (m) used when a route carries no usable gauge of
 * its own — the same 0.75 m the generator routes every `RailRoute.gauge` at.
 */
export const RAIL_GAUGE = 0.75;
/** Empty consist mass the default cart rolls with (kg) = physics default. */
export const RAIL_CAR_TARE_KG = DEFAULT_RAIL_CAR.mass;
/** Hopper capacity the payload visual fills against (kg). */
export const RAIL_CAR_MAX_PAYLOAD_KG = 2_400;
/** Transverse tie/sleeper spacing along the track (m). */
export const RAIL_TIE_SPACING_M = 1.2;
/** Rail head tube radius (m). */
export const RAIL_HEAD_RADIUS = 0.045;
/** Rail polyline sampling pitch for tube paths (m); endpoints always kept. */
export const RAIL_SAMPLE_M = 1.0;
/** Hard cap on ties per route (worst live route needs ~5.2k). */
export const RAIL_MAX_TIES_PER_ROUTE = 6_000;
/** Rail centreline sits this high above the route polyline (wheel radius). */
export const RAIL_LEVEL_M = 0.16;
/** Root/material name prefix when none is supplied (families are fixed). */
export const DEFAULT_NAME_PREFIX = 'rail';

/** Cart body geometry, metres. Model frame under root: +z travel, +y up. */
const CART = {
  wheelRadius: 0.16,
  wheelTread: { height: 0.12, diameter: 0.32, tessellation: 16 },
  wheelFlange: { height: 0.03, diameter: 0.34 },
  wheelBase: 0.9,
  frame: { width: 1.24, height: 0.08, length: 1.95 },
  hopper: { width: 1.1, height: 0.7, length: 1.6 },
  payloadInsetX: 0.09,
  payloadInsetZ: 0.08,
  payloadFloor: 0.02,
  /** Floor stub so an empty hopper keeps a finite payload bounding box. */
  payloadMinScale: 0.06,
} as const;

/** Anything that carries rail routes + nodes — a `WorldSnapshot` fits. */
export interface RailSystemSource {
  routes?: RailRoute[];
  railRoutes?: RailRoute[];
  /** Snapshots hand nodes as an array; direct callers may pass a Map. */
  nodes?: LunarNode[] | Map<string, LunarNode>;
}

/** Plain-object command form accepted by `update()` alongside `RailCarCommand`. */
export type RailCommandish = Partial<RailCarCommand>;

/** Commands keyed by cart id (`ore-cart-3`) or route id (`rail-001`). */
export type RailSystemCommands = Map<string, RailCarCommand> | Record<string, RailCommandish>;

/** Options for the rail system. */
export interface RailSystemOptions {
  /** Root/material name prefix (default `rail`). */
  namePrefix?: string;
  /** Tie spacing override in metres (default {@link RAIL_TIE_SPACING_M}). */
  tieSpacing?: number;
  /** Rail tube radius override (default {@link RAIL_HEAD_RADIUS}). */
  railRadius?: number;
}

/** Position + world-frame unit forward along a route polyline. */
export interface TrackSample {
  position: Vec3;
  forward: Vec3;
}

/** Polyline stop carrying its cumulative arc length (shape of `RailCar.stops`). */
interface PolyStop {
  position: Vec3;
  distance: number;
}

/** One buildable route: record + resolved, de-duplicated node positions. */
interface RouteGeom {
  route: RailRoute;
  stops: Vec3[];
  /** Cumulative distances matching `stops`. */
  cumulative: number[];
  /** `stops` + `cumulative` fused for the sampler (built once in `load`). */
  poly: PolyStop[];
  length: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Drop consecutive duplicates so polyline maths never divides by zero. */
function dedupeStops(stops: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of stops) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    if (out.length === 0 || dist3(out[out.length - 1], p) > 1e-9) out.push(p);
  }
  return out;
}

/** Cumulative arc lengths matching a stop list ([0, d01, d012, ...]). */
function cumulativeLengths(stops: Vec3[]): { cumulative: number[]; length: number } {
  const cumulative: number[] = [0];
  for (let i = 1; i < stops.length; i++) {
    cumulative.push(cumulative[i - 1] + dist3(stops[i - 1], stops[i]));
  }
  return { cumulative, length: cumulative[cumulative.length - 1] ?? 0 };
}

/**
 * Position + unit forward where `s` metres along a cumulative polyline fall.
 * Forward is the containing segment's direction; degenerate input yields +x.
 */
function pointAlong(stops: ReadonlyArray<PolyStop>, length: number, s: number): TrackSample {
  const fallback: TrackSample = {
    position: stops.length > 0 ? { ...stops[0].position } : { x: 0, y: 0, z: 0 },
    forward: { x: 1, y: 0, z: 0 },
  };
  if (stops.length < 2) return fallback;
  const d = clamp(Number.isFinite(s) ? s : 0, 0, length);
  for (let i = 1; i < stops.length; i++) {
    if (d <= stops[i].distance || i === stops.length - 1) {
      const span = stops[i].distance - stops[i - 1].distance;
      const t = span > 1e-9 ? (d - stops[i - 1].distance) / span : 0;
      const a = stops[i - 1].position;
      const b = stops[i].position;
      return {
        position: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t },
        forward: span > 1e-9
          ? { x: (b.x - a.x) / span, y: (b.y - a.y) / span, z: (b.z - a.z) / span }
          : { x: 1, y: 0, z: 0 },
      };
    }
  }
  return fallback;
}

/** World-frame horizontal unit perpendicular to a track tangent. */
function trackPerp(f: Vec3, side: number): Vec3 {
  const h = Math.hypot(f.x, f.y);
  if (h < 1e-9) return { x: side, y: 0, z: 0 }; // plumb vertical: stable arbitrary side
  return { x: (-f.y / h) * side, y: (f.x / h) * side, z: 0 };
}

/** Yaw/pitch quaternion mapping model +z onto a Babylon-frame unit vector. */
function orientToTangent(target: Quaternion, f: Vector3): void {
  const yaw = Math.atan2(f.x, f.z);
  const pitch = -Math.asin(clamp(f.y, -1, 1));
  Quaternion.RotationYawPitchRollToRef(yaw, pitch, 0, target);
}

function disposeQuietly(target: { dispose: () => unknown } | null): void {
  if (target === null) return;
  try {
    target.dispose();
  } catch {
    // Node already gone or engine torn down first — never propagate.
  }
}

// ---------------------------------------------------------------------------
// Ore cart entity — ONE physics RailCar + its procedural dress
// ---------------------------------------------------------------------------

/** Shared PBR materials handed to every cart by the owning RailSystem. */
interface CartMaterials {
  steel: PBRMaterial;
  composite: PBRMaterial;
  hopper: PBRMaterial;
  ore: PBRMaterial;
}

/**
 * One automated ore cart. Wraps exactly one `RailCar` from
 * ../physics/TraversalPhysics.ts (zero duplicate physics) and dresses it in a
 * hopper, frame, four flanged wheels and a load-scaled cargo payload. Every
 * state query reads through to the physics car; mesh work no-ops before
 * `attach()` and after `detach()`.
 */
export class OreCartEntity {
  /** The single source of truth for this cart's motion. Never duplicated. */
  readonly physics: RailCar;
  readonly cartId: string;
  readonly routeId: string;
  readonly kind: 'locomotive' | 'hopper';
  /** Drawing gauge in use (route gauge, floored to the narrow-gauge spec). */
  readonly gauge: number;

  private root: TransformNode | null = null;
  private payload: Mesh | null = null;
  private meshes: Mesh[] = [];
  private wheels: Mesh[] = [];
  private headlight: SpotLight | null = null;
  private beaconMat: StandardMaterial | null = null;

  private cargoMass = 0;
  private wheelPhase = 0;
  private attached = false;
  private detached = false;
  private alarmActive = false;
  private forward: Vec3 = { x: 1, y: 0, z: 0 };

  constructor(sequence: number | string, route: RailRoute, stops: Vec3[], spec?: RailCarSpec) {
    this.kind = spec?.kind ?? 'hopper';
    this.cartId = typeof sequence === 'string' ? sequence : (this.kind === 'locomotive' ? `ore-loco-${sequence}` : `ore-cart-${sequence}`);
    this.routeId = route.id;
    this.gauge = Number.isFinite(route.gauge) && route.gauge > 0 ? route.gauge : RAIL_GAUGE;
    this.physics = new RailCar(route, stops.map((p) => ({ ...p })), spec ?? {});
    this.cargoMass = clamp(spec?.load ?? 0, 0, RAIL_CAR_MAX_PAYLOAD_KG);
    this.physics.setLoad(this.cargoMass); // ledger and physics never disagree
  }

  // -- alarm & styling -------------------------------------------------------------

  /** Trigger or clear the security alarm on a locomotive (Spec 21 §2.3). */
  triggerAlarm(active: boolean = true): void {
    this.alarmActive = active;
    if (this.beaconMat !== null) {
      this.beaconMat.emissiveColor = active ? new Color3(1.0, 0.1, 0.1) : new Color3(1.0, 0.6, 0.1);
    }
  }

  isAlarmActive(): boolean {
    return this.alarmActive;
  }

  // -- physics-facing API --------------------------------------------------------

  /** Full physics state copy (scene-independent, safe after detach). */
  getState(): RailCarState {
    return this.physics.getState();
  }

  /** World-frame cart position on the route polyline (x, y lateral, z up). */
  getPosition(): Vec3 {
    return this.physics.position();
  }

  /** Rail speed along the track (m/s). */
  getSpeed(): number {
    return this.physics.getState().speed;
  }

  /** Distance travelled along the route polyline (m). */
  getDistance(): number {
    return this.physics.getState().distance;
  }

  /** Consist mass aboard, tare + cargo (kg). */
  getTotalMass(): number {
    return this.physics.totalMass;
  }

  /** Cargo mass aboard (kg) — the entity-side ledger, mirrored into physics. */
  getCargoMass(): number {
    return this.cargoMass;
  }

  /**
   * Load or empty the hopper (kg), clamped to `[0, RAIL_CAR_MAX_PAYLOAD_KG]`
   * (the hopper's capacity; the physics module clamps wider on its side and
   * receives the already-clamped value via `setLoad`). Returns the cargo mass
   * now aboard and rescales the payload mesh height.
   */
  setCargoMass(kg: number): number {
    this.cargoMass = Number.isFinite(kg) ? clamp(kg, 0, RAIL_CAR_MAX_PAYLOAD_KG) : 0;
    this.physics.setLoad(this.cargoMass);
    this.applyPayloadScale();
    return this.cargoMass;
  }

  /** True once the consist ran its route to the destination terminal. */
  isAtTerminal(): boolean {
    return this.physics.getState().terminalReached;
  }

  /** Local unit track tangent last drawn (world frame). */
  getForward(): Vec3 {
    return { ...this.forward };
  }

  // -- scene API -------------------------------------------------------------------

  /** Cart root transform node (`ore-cart-*`; null before attach / after detach). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  getMeshes(): ReadonlyArray<AbstractMesh> {
    return [...this.meshes];
  }

  isAttached(): boolean {
    return this.attached && !this.detached;
  }

  /** Build hopper/frame/wheels/payload under the rail-system root. Idempotent. */
  attach(parent: TransformNode, scene: Scene, mats: CartMaterials): void {
    if (this.detached || this.attached) return;
    const root = new TransformNode(this.cartId, scene);
    root.parent = parent;
    root.rotationQuaternion = new Quaternion();
    this.root = root;

    const floorY = CART.wheelRadius + 0.1; // frame skid rides just above rails
    const frame = MeshBuilder.CreateBox(`${this.cartId}-frame`, {
      width: CART.frame.width,
      height: CART.frame.height,
      depth: CART.frame.length,
    }, scene);
    frame.position.set(0, floorY, 0);
    frame.material = mats.composite;

    const parts: Mesh[] = [frame];

    if (this.kind === 'locomotive') {
      const cab = MeshBuilder.CreateBox(`${this.cartId}-cab`, {
        width: CART.hopper.width * 1.1,
        height: CART.hopper.height * 1.4,
        depth: CART.hopper.length * 1.05,
      }, scene);
      cab.position.set(0, floorY + CART.hopper.height * 0.7, 0);
      cab.material = mats.composite; // Heavy dark chassis for locomotive
      parts.push(cab);

      // Forward headlight
      const headlight = new SpotLight(
        `${this.cartId}-headlight`,
        new Vector3(0, floorY + CART.hopper.height * 0.9, CART.frame.length / 2),
        new Vector3(0, -0.05, 1).normalize(),
        (45 * Math.PI) / 180,
        2,
        scene,
      );
      headlight.range = 60;
      headlight.intensity = 3.5;
      headlight.diffuse = new Color3(1.0, 0.98, 0.92);
      headlight.parent = root;
      this.headlight = headlight;

      // Amber roof beacon
      const beaconMat = new StandardMaterial(`${this.cartId}-beacon-mat`, scene);
      beaconMat.emissiveColor = new Color3(1.0, 0.6, 0.1);
      beaconMat.disableLighting = true;
      const beacon = MeshBuilder.CreateSphere(`${this.cartId}-beacon`, { diameter: 0.35 }, scene);
      beacon.material = beaconMat;
      beacon.position.set(0, floorY + CART.hopper.height * 1.45, 0);
      beacon.parent = root;
      parts.push(beacon);
      this.beaconMat = beaconMat;
    } else {
      const hopper = MeshBuilder.CreateBox(`${this.cartId}-hopper`, {
        width: CART.hopper.width,
        height: CART.hopper.height,
        depth: CART.hopper.length,
      }, scene);
      hopper.position.set(0, floorY + CART.hopper.height / 2, 0);
      hopper.material = mats.hopper;
      parts.push(hopper);

      // Payload box with its ORIGIN baked at the bottom face
      const payload = MeshBuilder.CreateBox(`${this.cartId}-payload`, {
        width: CART.hopper.width - CART.payloadInsetX,
        height: CART.hopper.height - CART.payloadInsetZ,
        depth: CART.hopper.length - CART.payloadInsetZ,
      }, scene);
      payload.position.set(0, (CART.hopper.height - CART.payloadInsetZ) / 2, 0);
      payload.bakeCurrentTransformIntoVertices();
      payload.position.set(0, floorY + CART.payloadFloor, 0);
      payload.material = mats.ore;
      parts.push(payload);
      this.payload = payload;
    }

    const wheels: Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const wheel = OreCartEntity.buildWheel(`${this.cartId}-wheel-${i}`, scene);
      const side = i % 2 === 0 ? 1 : -1;
      const along = i < 2 ? CART.wheelBase / 2 : -CART.wheelBase / 2;
      wheel.position.set((side * this.gauge) / 2, CART.wheelRadius, along);
      wheel.material = mats.steel;
      wheels.push(wheel);
      parts.push(wheel);
    }

    for (const part of parts) part.parent = root;
    this.meshes = parts;
    this.wheels = wheels;
    this.attached = true;
    this.applyPayloadScale();
    // Sit the cart on the polyline immediately — the mesh is truthful from
    // spawn, not only after the first update().
    this.draw(
      pointAlong(this.physics.stops, this.physics.routeLength, this.physics.getState().distance),
      0,
      0,
    );
  }

  /** Drop this cart's meshes (physics instance survives). Idempotent. */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.attached = false;
    for (const mesh of this.meshes) disposeQuietly(mesh);
    this.meshes = [];
    this.wheels = [];
    disposeQuietly(this.headlight);
    this.headlight = null;
    disposeQuietly(this.beaconMat);
    this.beaconMat = null;
    disposeQuietly(this.root);
    this.root = null;
    this.payload = null;
  }

  /**
   * Re-draw root transform and wheel roll from a track sample + post-step
   * speed. No-ops before attach / after detach; integrates no physics.
   */
  draw(sample: TrackSample, speed: number, dt: number): void {
    if (!this.attached || this.root === null) return;
    const b = worldToBabylon(sample.position);
    this.root.position.set(b.x, b.y, b.z); // root sits ON the route polyline
    // Tangent through the SAME linear map worldToBabylon applies to points:
    // world (fx, fy, fz) → Babylon (fx, fz, -fy).
    const fx = sample.forward.x;
    const fy = sample.forward.y;
    const fz = sample.forward.z;
    const len = Math.hypot(fx, fz, -fy);
    if (len > 1e-9 && this.root.rotationQuaternion !== null) {
      orientToTangent(this.root.rotationQuaternion, new Vector3(fx / len, fz / len, -fy / len));
    }
    this.root.computeWorldMatrix(true);
    this.forward = sample.forward;

    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.wheelPhase += (Math.abs(Number.isFinite(speed) ? speed : 0) * step) / CART.wheelRadius;
    for (const wheel of this.wheels) wheel.rotation.x = this.wheelPhase;
  }

  private applyPayloadScale(): void {
    if (this.payload === null || this.payload.isDisposed()) return;
    const fraction = clamp(this.cargoMass / RAIL_CAR_MAX_PAYLOAD_KG, 0, 1);
    this.payload.scaling.set(1, Math.max(CART.payloadMinScale, fraction), 1);
  }

  /** Tread + twin flanges merged into one wheel; axle lies across local x. */
  private static buildWheel(name: string, scene: Scene): Mesh {
    const parts: Mesh[] = [];
    const tread = MeshBuilder.CreateCylinder(`${name}-t`, {
      height: CART.wheelTread.height,
      diameter: CART.wheelTread.diameter,
      tessellation: CART.wheelTread.tessellation,
    }, scene);
    tread.rotation.z = Math.PI / 2; // cylinder +y axis → axle axis +x
    tread.bakeCurrentTransformIntoVertices();
    parts.push(tread);
    for (const side of [1, -1]) {
      const flange = MeshBuilder.CreateCylinder(`${name}-f`, {
        height: CART.wheelFlange.height,
        diameter: CART.wheelFlange.diameter,
        tessellation: CART.wheelTread.tessellation,
      }, scene);
      flange.rotation.z = Math.PI / 2;
      flange.position.set(side * (CART.wheelTread.height + CART.wheelFlange.height) / 2, 0, 0);
      flange.bakeCurrentTransformIntoVertices();
      parts.push(flange);
    }
    const merged = Mesh.MergeMeshes(parts, true, true);
    const wheel = merged ?? parts[0];
    wheel.name = name;
    wheel.isPickable = true;
    return wheel;
  }
}

// ---------------------------------------------------------------------------
// RailSystem — track geometry + cart fleet
// ---------------------------------------------------------------------------

/**
 * Rail-line infrastructure over `RailRoute` records: builds the twin-rail +
 * tie geometry once per route, owns the ore-cart fleet, and steps every
 * cart's `RailCar` exactly once per `update(dt)` — the carts' meshes then
 * ride the polyline tangent via `worldToBabylon`.
 */
export class RailSystem {
  private routes: RailRoute[] = [];
  private routeGeoms: RouteGeom[] = [];
  private geomByRoute = new Map<string, RouteGeom>();

  private readonly prefix: string;
  private readonly tieSpacing: number;
  private readonly railRadius: number;

  private scene: Scene | null = null;
  /** Engine created by `init()` (NullEngine fallback) — ours to dispose. */
  private ownedEngine: AbstractEngine | null = null;

  private root: TransformNode | null = null;
  private railMeshes: Mesh[] = [];
  private tieMeshes: Mesh[] = [];
  private materials: PBRMaterial[] = [];
  private mats: CartMaterials | null = null;

  private carts: OreCartEntity[] = [];
  private cartSeq = 0;

  private built = false;
  private disposed = false;

  /**
   * Accepts a `WorldSnapshot` (anything with `railRoutes` + `nodes`), a bare
   * `{ routes, nodes }` pair (nodes as array or Map), or nothing for an empty
   * system filled later by `load()`. References are held, not cloned.
   */
  constructor(
    source?: WorldSnapshot | RailSystemSource | null,
    options: RailSystemOptions = {},
  ) {
    this.prefix = options.namePrefix ?? DEFAULT_NAME_PREFIX;
    this.tieSpacing = Number.isFinite(options.tieSpacing) && (options.tieSpacing ?? 0) > 0
      ? (options.tieSpacing as number)
      : RAIL_TIE_SPACING_M;
    this.railRadius = Number.isFinite(options.railRadius) && (options.railRadius ?? 0) > 0
      ? (options.railRadius as number)
      : RAIL_HEAD_RADIUS;
    if (source !== null && source !== undefined) this.load(source);
  }

  // -- data ----------------------------------------------------------------------

  /** Replace routes/nodes wholesale (queries + rebuild-ready). */
  load(source: WorldSnapshot | RailSystemSource): this {
    // Widened view: snapshots hand `railRoutes`, bare callers hand `routes`.
    const src = source as WorldSnapshot & RailSystemSource;
    const routes = src.railRoutes ?? src.routes ?? [];
    this.routes = Array.isArray(routes) ? [...routes] : [];
    const nodes = src.nodes;
    let nodeIndex: Map<string, LunarNode>;
    if (nodes instanceof Map) {
      nodeIndex = new Map(nodes);
    } else if (Array.isArray(nodes)) {
      nodeIndex = new Map(nodes.map((n) => [n.id, n]));
    } else {
      nodeIndex = new Map();
    }

    this.routeGeoms = [];
    this.geomByRoute = new Map();
    for (const route of this.routes) {
      const stops = dedupeStops(
        route.nodeIds.map((id) => nodeIndex.get(id)?.position).filter((p): p is Vec3 => p !== undefined),
      );
      if (stops.length < 2) continue; // unroutable without at least two node positions
      const { cumulative, length } = cumulativeLengths(stops);
      if (!(length > 1e-6)) continue;
      const poly = stops.map((position, i) => ({ position, distance: cumulative[i] }));
      const geom: RouteGeom = { route, stops, cumulative, poly, length };
      this.routeGeoms.push(geom);
      this.geomByRoute.set(route.id, geom);
    }
    return this;
  }

  /** All rail routes as supplied (read-only view). */
  getRoutes(): ReadonlyArray<RailRoute> {
    return this.routes;
  }

  /** Resolved node positions of one route's polyline (copy; [] when unknown). */
  getRouteStops(routeId: string): Vec3[] {
    const geom = this.geomByRoute.get(routeId);
    return geom === undefined ? [] : geom.stops.map((p) => ({ ...p }));
  }

  /** Track sample (position + tangent) at `s` metres along a route. */
  sampleRoute(routeId: string, s: number): TrackSample | null {
    const geom = this.geomByRoute.get(routeId);
    return geom === undefined ? null : pointAlong(geom.poly, geom.length, s);
  }

  // -- lifecycle -------------------------------------------------------------------

  /**
   * Build the track geometry. Accepts an existing `Scene`, a raw engine (a
   * scene is created around it), or nothing — falling back to a self-owned
   * `NullEngine`, exactly what CI wants. Idempotent; refuses after `dispose()`.
   * Carts spawned before `init()` attach their meshes here too.
   */
  init(sceneOrEngine?: Scene | AbstractEngine | null): this {
    if (this.disposed) throw new Error('RailSystem: init() after dispose()');
    if (this.built) return this;

    if (sceneOrEngine instanceof Scene) {
      this.scene = sceneOrEngine;
    } else if (sceneOrEngine !== null && sceneOrEngine !== undefined) {
      // Bare engine (typically a shared NullEngine): wrap it, never own it.
      this.scene = new Scene(sceneOrEngine);
    } else if (typeof window === 'undefined') {
      const engine = new NullEngine();
      this.ownedEngine = engine;
      this.scene = new Scene(engine);
    } else {
      throw new Error('RailSystem.init: browser needs a Scene or Engine');
    }

    this.root = new TransformNode(`${this.prefix}-system`, this.scene);
    this.buildMaterials(this.scene);
    for (const geom of this.routeGeoms) this.buildTrack(geom);
    for (const cart of this.carts) {
      if (!cart.isAttached()) cart.attach(this.root, this.scene, this.mats as CartMaterials);
    }
    this.built = true;
    return this;
  }

  /** True once `init()` has built meshes (false again after dispose). */
  isBuilt(): boolean {
    return this.built && !this.disposed;
  }

  /** Tear down track, carts, materials, root and any self-owned engine. Never throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.built = false;

    for (const cart of this.carts) cart.detach();
    this.carts = [];
    for (const mesh of this.railMeshes) disposeQuietly(mesh);
    this.railMeshes = [];
    for (const mesh of this.tieMeshes) disposeQuietly(mesh);
    this.tieMeshes = [];
    for (const material of this.materials) disposeQuietly(material);
    this.materials = [];
    this.mats = null;
    disposeQuietly(this.root);
    this.root = null;

    const engine = this.ownedEngine;
    this.ownedEngine = null;
    if (engine !== null) disposeQuietly(engine);
    // A caller-supplied Scene/engine is theirs to dispose; we just drop refs.
    this.scene = null;
  }

  // -- carts -------------------------------------------------------------------------

  /**
   * Spawn an automated ore cart at the origin terminal of `routeId` (head of
   * the node chain). Physics: one fresh `RailCar` over the route's resolved
   * node positions. Null for unknown/unroutable routes or after `dispose()`;
   * spawning before `init()` is legal and the cart attaches on build.
   */
  spawnCart(routeId: string, spec?: RailCarSpec): OreCartEntity | null {
    if (this.disposed) return null;
    const geom = this.geomByRoute.get(routeId);
    if (geom === undefined) return null;
    const cart = new OreCartEntity(++this.cartSeq, geom.route, geom.stops, spec);
    this.carts.push(cart);
    if (this.built && this.scene !== null && this.root !== null) {
      cart.attach(this.root, this.scene, this.mats as CartMaterials);
    }
    return cart;
  }

  /** All spawned carts (read-only view, spawn order). Empty after dispose. */
  getCarts(): ReadonlyArray<OreCartEntity> {
    return this.carts;
  }

  /** One spawned cart by cart id (`ore-cart-3`) or route id; else null. */
  getCart(id: string): OreCartEntity | null {
    return (
      this.carts.find((c) => c.cartId === id || c.routeId === id) ?? null
    );
  }

  /**
   * Step every cart exactly once and redraw it on the track. Commands may be
   * a Map or plain object keyed by cart id (`ore-cart-1`) or route id
   * (`rail-001`); carts without a command run the idle consist (park brake,
   * auto-stop at terminal). Safe no-op after `dispose()`; non-finite `dt` is
   * clamped away by the physics module.
   */
  update(dt: number, commands?: RailSystemCommands): void {
    if (this.disposed) return;
    for (const cart of this.carts) {
      const command = RailSystem.resolveCommand(cart, commands);
      const state = cart.physics.step(dt, command);
      if (!this.built) continue;
      const geom = this.geomByRoute.get(cart.routeId);
      if (geom === undefined) continue;
      const sample = pointAlong(geom.poly, geom.length, state.distance);
      cart.draw(sample, state.speed, dt);
    }
  }

  // -- accessors -----------------------------------------------------------------------

  /** Root transform node (`rail-system`; null before init, after dispose). */
  getRootNode(): TransformNode | null {
    return this.root;
  }

  /** Every mesh — rails, ties, cart parts (shadow/picking registration). */
  getMeshes(): ReadonlyArray<AbstractMesh> {
    const cartMeshes: AbstractMesh[] = [];
    for (const cart of this.carts) cartMeshes.push(...cart.getMeshes());
    return [...this.railMeshes, ...this.tieMeshes, ...cartMeshes];
  }

  /** Just the rail-head tubes (`rail-rail-*`) — two per buildable route. */
  getRailMeshes(): ReadonlyArray<Mesh> {
    return [...this.railMeshes];
  }

  /** Just the merged sleeper meshes (`rail-tie-*`) — one per buildable route. */
  getTieMeshes(): ReadonlyArray<Mesh> {
    return [...this.tieMeshes];
  }

  // -- internals -------------------------------------------------------------------------

  /** Steel / weathered-composite / hopper / ore PBR set, built once. */
  private buildMaterials(scene: Scene): void {
    const steel = new PBRMaterial(`${this.prefix}-steel`, scene);
    steel.albedoColor = new Color3(0.62, 0.63, 0.66); // polished rail head
    steel.metallic = 0.92;
    steel.roughness = 0.3;
    steel.environmentIntensity = 0.1;

    const composite = new PBRMaterial(`${this.prefix}-tie`, scene);
    composite.albedoColor = new Color3(0.16, 0.14, 0.12); // weathered dark composite
    composite.metallic = 0.05;
    composite.roughness = 0.95;
    composite.environmentIntensity = 0.03;

    const hopper = new PBRMaterial(`${this.prefix}-hopper`, scene);
    hopper.albedoColor = new Color3(0.42, 0.34, 0.2); // dusted manganese steel
    hopper.metallic = 0.7;
    hopper.roughness = 0.55;
    hopper.environmentIntensity = 0.06;

    const ore = new PBRMaterial(`${this.prefix}-ore`, scene);
    ore.albedoColor = new Color3(0.3, 0.27, 0.24); // haulage cargo
    ore.metallic = 0.12;
    ore.roughness = 0.9;
    ore.environmentIntensity = 0.04;

    this.materials = [steel, composite, hopper, ore];
    this.mats = { steel, composite, hopper, ore };
  }

  /** Twin rails + merged ties along one route polyline. */
  private buildTrack(geom: RouteGeom): void {
    const scene = this.scene as Scene;
    const root = this.root as TransformNode;
    const mats = this.mats as CartMaterials;
    const halfGauge = (Number.isFinite(geom.route.gauge) && geom.route.gauge > 0
      ? geom.route.gauge
      : RAIL_GAUGE) / 2;

    const poly = geom.poly;
    // Sample the polyline at a fixed pitch, always keeping both endpoints.
    const sampleCount = geom.length > 2 * RAIL_SAMPLE_M
      ? Math.max(2, Math.ceil(geom.length / RAIL_SAMPLE_M))
      : 1;
    const distances: number[] = [];
    for (let i = 0; i <= sampleCount; i++) distances.push(Math.min((i * geom.length) / sampleCount, geom.length));

    for (const side of [1, -1]) {
      const path: Vector3[] = [];
      for (const d of distances) {
        const at = pointAlong(poly, geom.length, d);
        const perp = trackPerp(at.forward, side);
        path.push(
          worldToBabylon({
            x: at.position.x + perp.x * halfGauge,
            y: at.position.y + perp.y * halfGauge,
            z: at.position.z + perp.z * halfGauge + RAIL_LEVEL_M,
          }),
        );
      }
      const rail = MeshBuilder.CreateTube(
        `rail-rail-${geom.route.id}-${side > 0 ? 'l' : 'r'}`,
        { path, radius: this.railRadius, tessellation: 6, cap: Mesh.NO_CAP },
        scene,
      );
      rail.material = mats.steel;
      rail.isPickable = true;
      rail.metadata = { routeId: geom.route.id, part: 'rail' };
      rail.parent = root;
      this.railMeshes.push(rail);
    }

    this.buildTies(geom, poly, root, scene, mats);
  }

  /** Ties every `tieSpacing` metres, perpendicular to the local tangent, merged. */
  private buildTies(
    geom: RouteGeom,
    poly: PolyStop[],
    root: TransformNode,
    scene: Scene,
    mats: CartMaterials,
  ): void {
    const tieCount = Math.min(
      RAIL_MAX_TIES_PER_ROUTE,
      Math.floor(geom.length / this.tieSpacing) + 1,
    );
    if (tieCount < 1) return;
    const boxes: Mesh[] = [];
    for (let i = 0; i < tieCount; i++) {
      const d = Math.min(i * this.tieSpacing, geom.length);
      const at = pointAlong(poly, geom.length, d);
      const box = MeshBuilder.CreateBox(`rail-tie-${geom.route.id}-${i}`, {
        width: halfTieWidth(geom) * 2, // along local x → perpendicular to tangent
        height: 0.09,
        depth: 0.22,
      }, scene);
      const b = worldToBabylon(at.position);
      box.position.set(b.x, b.y, b.z);
      const fx = at.forward.x;
      const fy = at.forward.y;
      const fz = at.forward.z;
      const len = Math.hypot(fx, fy, fz);
      if (len > 1e-9) {
        box.rotationQuaternion = new Quaternion();
        orientToTangent(box.rotationQuaternion, new Vector3(fx / len, fz / len, -fy / len));
      }
      boxes.push(box);
    }
    const merged = Mesh.MergeMeshes(boxes, true, true);
    const ties = merged ?? boxes[0];
    ties.name = `rail-tie-${geom.route.id}`;
    ties.material = mats.composite;
    ties.isPickable = true;
    ties.metadata = { routeId: geom.route.id, part: 'ties', count: tieCount };
    ties.parent = root;
    this.tieMeshes.push(ties);
    // MergeMeshes disposes the sources; if it refused, clean them up manually.
    if (merged === null) for (const box of boxes.slice(1)) disposeQuietly(box);
  }

  /** Command for one cart: cart-id key first, route-id key second, else idle. */
  private static resolveCommand(cart: OreCartEntity, commands?: RailSystemCommands): RailCarCommand {
    if (commands === undefined || commands === null) return IDLE_RAIL_COMMAND;
    const raw = commands instanceof Map ? commands.get(cart.cartId) ?? commands.get(cart.routeId)
      : (commands as Record<string, RailCommandish>)[cart.cartId]
        ?? (commands as Record<string, RailCommandish>)[cart.routeId];
    if (raw === undefined || raw === null) return IDLE_RAIL_COMMAND;
    return {
      throttle: Number.isFinite(raw.throttle) ? (raw.throttle as number) : 0,
      dynamicBrake: Number.isFinite(raw.dynamicBrake) ? (raw.dynamicBrake as number) : 0,
      pneumaticBrake: Number.isFinite(raw.pneumaticBrake) ? (raw.pneumaticBrake as number) : 0,
      stopAtTerminal: raw.stopAtTerminal ?? true,
    };
  }
}

/** Half-width of a sleeper across the gauge (route gauge + shoulder). */
function halfTieWidth(geom: RouteGeom): number {
  const gauge = Number.isFinite(geom.route.gauge) && geom.route.gauge > 0
    ? geom.route.gauge
    : RAIL_GAUGE;
  return gauge / 2 + 0.28;
}

export default RailSystem;
