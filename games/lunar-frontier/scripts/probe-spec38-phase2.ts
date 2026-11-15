/**
 * Spec 38 Phase 2 probe — procedural subterranean mesh generation.
 *
 * Headless NullEngine run exercising {@link SubterraneanChamberBuilder}:
 * shaft + tier chamber construction, per-tier mesh counts & boundary extents,
 * tier-root transform datums, occlusion-culling visibility transitions and
 * clean disposal. Mirrors the §4 acceptance-gate style of the Phase 1 probe.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import {
  SubterraneanChamberBuilder,
  CHAMBER_TIER_CONFIGS,
  SHAFT_RING_COUNT,
  TIER1_RIB_COUNT,
  TIER1_LIGHT_COUNT,
  TIER2_BEAM_COUNT,
  TIER3_RIB_COUNT,
} from '../src/base/SubterraneanChamberBuilder.ts';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (!cond) {
    failures += 1;
    console.error(`FAIL  ${label}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

/** Approx equality within a small tolerance. */
const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) <= eps;

function main(): void {
  const engine = new NullEngine();
  const scene = new Scene(engine);

  // --- build all three tiers -------------------------------------------------
  const builder = new SubterraneanChamberBuilder(scene);
  builder.build(3);

  check('isBuilt() true after build(3)', builder.isBuilt());
  check('root node present', builder.getRootNode() !== null);

  const meshes = builder.getMeshes();
  // Shaft rings (19) + tier1 (floor+ceiling+4 walls+5 ribs+6 lights = 17)
  // + tier2 (floor+ceiling+4 walls+4 columns+3 beams = 13)
  // + tier3 (floor+2 sidewalls+2 endcaps+7 ribs = 12).
  const expectedTotal = SHAFT_RING_COUNT + 1 * 17 + 13 + 12;
  check(`total meshes == ${expectedTotal}`, meshes.length === expectedTotal);

  // --- part counts per tier --------------------------------------------------
  const shaftRings = builder.getPartMeshes('shaft-ring');
  check(`shaft rings == ${SHAFT_RING_COUNT}`, shaftRings.length === SHAFT_RING_COUNT);
  const tier1Ribs = builder.getPartMeshes('vault-rib').filter((m) => (m.metadata?.tier as number) === 1);
  check(`tier1 ribs == ${TIER1_RIB_COUNT}`, tier1Ribs.length === TIER1_RIB_COUNT);
  const stripLights = builder.getPartMeshes('strip-light');
  check(`tier1 strip lights == ${TIER1_LIGHT_COUNT}`, stripLights.length === TIER1_LIGHT_COUNT);
  const tier2Beams = builder.getPartMeshes('beam');
  check(`tier2 beams == ${TIER2_BEAM_COUNT}`, tier2Beams.length === TIER2_BEAM_COUNT);
  const tier3Ribs = builder.getPartMeshes('arch-rib');
  check(`tier3 arch ribs == ${TIER3_RIB_COUNT}`, tier3Ribs.length === TIER3_RIB_COUNT);

  // --- chamber boundary dimensions (Spec 38 §2.1) ---------------------------
  const t1 = CHAMBER_TIER_CONFIGS[1]!;
  const t2 = CHAMBER_TIER_CONFIGS[2]!;
  const t3 = CHAMBER_TIER_CONFIGS[3]!;

  const tier1Floor = builder.getPartMeshes('floor').find((m) => (m.metadata?.tier as number) === 1);
  check('tier1 floor present', tier1Floor !== undefined);
  if (tier1Floor !== undefined) {
    const bb = tier1Floor.getBoundingInfo().boundingBox;
    // Interior width/length ≈ 24 m × 24 m (slab spans the interior).
    check(`tier1 floor width ~ ${t1.widthM}`, near(bb.extendSizeWorld.x * 2, t1.widthM));
    check(`tier1 floor length ~ ${t1.lengthM}`, near(bb.extendSizeWorld.z * 2, t1.lengthM));
  }

  const tier2Floor = builder.getPartMeshes('floor').find((m) => (m.metadata?.tier as number) === 2);
  check('tier2 floor present', tier2Floor !== undefined);
  if (tier2Floor !== undefined) {
    const bb = tier2Floor.getBoundingInfo().boundingBox;
    check(`tier2 floor width ~ ${t2.widthM}`, near(bb.extendSizeWorld.x * 2, t2.widthM));
    check(`tier2 floor length ~ ${t2.lengthM}`, near(bb.extendSizeWorld.z * 2, t2.lengthM));
  }

  const tier3Floor = builder.getPartMeshes('floor').find((m) => (m.metadata?.tier as number) === 3);
  check('tier3 floor present', tier3Floor !== undefined);
  if (tier3Floor !== undefined) {
    const bb = tier3Floor.getBoundingInfo().boundingBox;
    check(`tier3 floor width ~ ${t3.widthM}`, near(bb.extendSizeWorld.x * 2, t3.widthM));
    check(`tier3 floor length ~ ${t3.lengthM}`, near(bb.extendSizeWorld.z * 2, t3.lengthM));
  }

  // --- tier-root transform positions (chamber-floor datums) --------------------
  const r1 = builder.getTierRoot(1);
  const r2 = builder.getTierRoot(2);
  const r3 = builder.getTierRoot(3);
  check('tier1 root at −15 m', r1 !== null && near(r1.position.y, -15));
  check('tier2 root at −45 m', r2 !== null && near(r2.position.y, -45));
  check('tier3 root at −95 m', r3 !== null && near(r3.position.y, -95));

  // --- occlusion culling: surface vs underground ------------------------------
  builder.updateVisibility(0); // camera on the surface (≥ −2.0 m)
  check('surface: every subterranean mesh hidden', meshes.every((m) => !m.isVisible));

  builder.updateVisibility(-20); // camera below −2.0 m → underground
  const visible = meshes.filter((m) => m.isVisible);
  check(`underground: all ${expectedTotal} meshes revealed`, visible.length === expectedTotal);

  // Partial unlock (tier 1 only): tier 2/3 meshes stay culled.
  const partial = new SubterraneanChamberBuilder(scene);
  partial.build(1);
  partial.updateVisibility(-20);
  const pMeshes = partial.getMeshes();
  const visibleP = pMeshes.filter((m) => m.isVisible);
  const expectedP = SHAFT_RING_COUNT + 17; // shaft + tier1 only
  check(`partial unlock: ${expectedP} meshes revealed`, visibleP.length === expectedP);
  check('partial unlock: no tier2/3 meshes', pMeshes.every((m) => (m.metadata?.tier as number) <= 1 || !m.isVisible));

  // --- idempotent build -----------------------------------------------------
  const before = builder.getMeshes().length;
  builder.build(3); // second call returns immediately
  check('idempotent build: no mesh duplication', builder.getMeshes().length === before);

  // --- clean disposal --------------------------------------------------------
  partial.dispose();
  check('dispose: tier roots nulled', partial.getTierRoot(1) === null);
  check('dispose: isBuilt() false', !partial.isBuilt());
  check('dispose: meshes drained', partial.getMeshes().length === 0);

  builder.dispose();
  check('builder dispose: root nulled', builder.getRootNode() === null);
  check('builder dispose: meshes drained', builder.getMeshes().length === 0);
  check('builder dispose: isBuilt() false', !builder.isBuilt());

  // Double-dispose must never throw.
  let doubleDisposed = true;
  try {
    builder.dispose();
  } catch {
    doubleDisposed = false;
  }
  check('double dispose safe', doubleDisposed);

  engine.dispose();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error('PROBE CRASHED:', err);
  process.exitCode = 1;
}
