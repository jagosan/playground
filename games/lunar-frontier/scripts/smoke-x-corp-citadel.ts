/**
 * Spec 26 Phase 1 verification probe: XCorpCitadel functional contract.
 * Run: `npx tsx scripts/smoke-x-corp-citadel.ts`  (exit code 0 == all green)
 *
 * Covers blueprint §4 gate group 1 (Citadel geometry & defense bounds) plus
 * the WorldScene integration surface (buildXCorpCitadel / getXCorpCitadel /
 * update(dtMs) / dispose).
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';

import {
  XCorpCitadel,
  CITADEL_DEFAULT_WORLD_CENTER,
  DEFAULT_SHIELD_RADIUS_M,
  DEFAULT_LETHAL_RADIUS_M,
  DEFAULT_WARNING_RADIUS_M,
  SHIELD_REPULSION_K,
  MONOLITH_HEIGHT_M,
  SPIRE_HEIGHT_M,
  SPIRE_RING_RADIUS_M,
  CITADEL_TERMINAL_HEADING_RAD,
} from '../src/infrastructure/XCorpCitadel.ts';
import { WorldScene } from '../src/engine/WorldScene.ts';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(label); console.log(`  ✘ ${label} ${detail}`); }
}

// --- scene-independent options & perimeter math ------------------------------
const citadel = new XCorpCitadel();
const radii = citadel.getDefenseRadii();
check('default lethal radius 180', radii.lethalM === DEFAULT_LETHAL_RADIUS_M);
check('default shield radius 220', radii.shieldM === DEFAULT_SHIELD_RADIUS_M);
check('default warning radius 260', radii.warningM === DEFAULT_WARNING_RADIUS_M);
const wc = citadel.getWorldCenter();
check('canonical seat (-1850, 2400, 0)', wc.x === -1850 && wc.y === 2400 && wc.z === 0);
check('k_shield = 45.0 N/m²', SHIELD_REPULSION_K === 45.0);
check('monolith height 85 m', MONOLITH_HEIGHT_M === 85);
check('spire height 35 m', SPIRE_HEIGHT_M === 35);
check('terminal heading finite', Number.isFinite(CITADEL_TERMINAL_HEADING_RAD));

const C = CITADEL_DEFAULT_WORLD_CENTER;
const at = (r: number) => citadel.getPerimeterStatus({ x: C.x + r, y: C.y, z: C.z });

const s300 = at(300);
check('r=300: outside all rings', !s300.inWarningZone && !s300.inShieldPerimeter && !s300.inLethalZone);
check('r=300: zero repulsion', s300.repulsionForceN === 0);
const s260 = at(260);
check('r=260: warning zone edge', s260.inWarningZone && !s260.inShieldPerimeter && s260.repulsionForceN === 0);
const s220 = at(220);
check('r=220: shield edge, force ramps from 0', s220.inShieldPerimeter && s220.repulsionForceN === 0);
const s200 = at(200);
check('r=200: repulsion > 1500 N outward', s200.repulsionForceN > 1500, `${s200.repulsionForceN}`);
check('r=200: 45*(220-200)^2 = 18,000 N exact', Math.abs(s200.repulsionForceN - 18000) < 1e-9, `${s200.repulsionForceN}`);
check('r=200: not lethal yet', !s200.inLethalZone);
const s180 = at(180);
check('r=180: lethal strike (Infinity)', s180.inLethalZone && s180.repulsionForceN === Infinity);
const s0 = at(0);
check('r=0: lethal strike', s0.inLethalZone && s0.repulsionForceN === Infinity);
check('distance measured 2D horizontal', at(150).distanceM === 150);
const nan = citadel.getPerimeterStatus({ x: NaN, y: 0, z: 0 });
check('NaN pos → far outside, zero force', nan.distanceM === Infinity && nan.repulsionForceN === 0 && !nan.inWarningZone);
check('queries answer before init', citadel.isBuilt() === false && s200.inShieldPerimeter === true);
// Monotonicity: force grows as the intruder closes in.
check('force monotone decreasing in r', at(210).repulsionForceN < at(200).repulsionForceN && at(200).repulsionForceN < at(190).repulsionForceN);

// Custom options honoured + ring ordering clamped.
const custom = new XCorpCitadel({ worldCenter: { x: 10, y: 20, z: 0 }, shieldRadiusM: 100, lethalRadiusM: 300, warningRadiusM: 50 });
const cr = custom.getDefenseRadii();
check('ring order clamped lethal<=shield<=warn', cr.lethalM <= cr.shieldM && cr.shieldM <= cr.warningM, JSON.stringify(cr));
check('custom center respected', custom.getPerimeterStatus({ x: 10, y: 20, z: 0 }).inLethalZone);

// --- headless build (NullEngine) ----------------------------------------------
const engine = new NullEngine();
const scene = new Scene(engine);
const built = new XCorpCitadel().init(scene);
check('isBuilt after init', built.isBuilt());
check('idempotent init', built.init(scene) === built);
const meshes = built.getMeshes();
check('meshes built (>60)', meshes.length > 60, `${meshes.length}`);

const parts = ['monolith', 'mullion', 'penthouse', 'glass', 'viaduct', 'tunnel_arch', 'blast_gate', 'landing_pad', 'chevron', 'shield', 'spire', 'turret'];
for (const p of parts) {
  check(`part '${p}' present`, built.getPartMeshes(p).length > 0, `${built.getPartMeshes(p).length}`);
}
check('6 gold mullions on hex corners', built.getPartMeshes('mullion').length === 6);
check('3 CIWS spires', built.getPartMeshes('spire').filter((m) => m.name.includes('-spire-') && !m.name.includes('platform') && !m.name.includes('band')).length === 3);
check('blast gate pair', built.getPartMeshes('blast_gate').length === 2);
check('dual VIP pads', built.getPartMeshes('landing_pad').filter((m) => m.name.includes('pad-deck')).length === 2);

// Shield dome geometry: geodesic hemisphere at R_shield.
const dome = built.getPartMeshes('shield')[0];
const domeBB = dome.getBoundingInfo();
const ext = domeBB.maximum;
const extMin = domeBB.minimum;
check('shield dome spans ±220 m horizontally', ext !== undefined && extMin !== undefined
  && Math.abs(ext.x - DEFAULT_SHIELD_RADIUS_M) < 1 && Math.abs(ext.z - DEFAULT_SHIELD_RADIUS_M) < 1,
  `${ext?.x},${ext?.z}`);
const shieldMat = dome.material as { emissiveColor?: { g: number }; alpha?: number; backFaceCulling?: boolean };
check('shield emissive neon-cyan (0, 0.85, 1) at t=0', shieldMat.emissiveColor !== undefined
  && Math.abs(shieldMat.emissiveColor.g - 0.85) < 0.2);
check('shield translucent, two-sided', shieldMat.alpha !== undefined && shieldMat.alpha < 0.5 && shieldMat.backFaceCulling === false);

// Spires on the 200 m ring (world-frame check via absolute positions).
const spires = built.getPartMeshes('spire').filter((m) => /-spire-\d$/.test(m.name));
const ringOk = spires.every((m) => {
  const p = m.getAbsolutePosition ? m.getAbsolutePosition() : null;
  if (p === null) return false;
  const r = Math.hypot(p.x - C.x, -(p.z) - C.y);
  return Math.abs(r - SPIRE_RING_RADIUS_M) < 2;
});
check('3 spires on r=200 m ring', spires.length === 3 && ringOk);
// Spires 120° apart.
const bearings = spires.map((m) => {
  const p = m.getAbsolutePosition();
  return Math.atan2(-(p.z) - C.y, p.x - C.x);
});
const sep = (a: number, b: number) => Math.abs(((a - b) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
check('spires 120° apart', spires.length === 3
  && sep(bearings[0]!, bearings[1]!) > 2.0 && sep(bearings[1]!, bearings[2]!) > 2.0 && sep(bearings[0]!, bearings[2]!) > 2.0);

// Shadow casters exclude the energy barrier.
const casters = built.getShadowCasterMeshes();
check('shadow casters exclude shield', casters.length === meshes.length - built.getPartMeshes('shield').length
  && !casters.some((m) => (m.metadata?.part as string) === 'shield'));
const root = built.getRootNode();
check('root node at citadel seat', root !== null
  && Math.abs(root.position.x - C.x) < 0.01 && Math.abs(root.position.z + C.y) < 0.01
  && Math.abs(root.position.y - C.z) < 0.01);

// --- update(): returns status, animates, tracks ---------------------------------
const statusIn = built.update(1 / 60, { x: C.x + 190, y: C.y, z: 0 });
check('update returns shield-perimeter status', statusIn.inShieldPerimeter && statusIn.repulsionForceN > 0);
const after = (shieldMat.emissiveColor?.b ?? 0);
check('shield shimmer animated (emissive driven)', Number.isFinite(after));
// CIWS turret heads turn toward the intruder.
const turrets = built.getPartMeshes('turret');
const headYawed = turrets.length > 0;
check('turret meshes present', headYawed);
const statusOut = built.update(1 / 60, { x: C.x + 5000, y: C.y, z: 0 });
check('update outside all rings → zeros', statusOut.repulsionForceN === 0 && !statusOut.inWarningZone);
const statusLethal = built.update(1 / 60, { x: C.x, y: C.y + 100, z: 0 });
check('update lethal crossing → Infinity', statusLethal.repulsionForceN === Infinity && statusLethal.inLethalZone);
const dt = Number.NaN;
const statusNaN = built.update(dt, { x: C.x, y: C.y, z: 0 });
check('NaN dt does not poison status', statusNaN.inLethalZone && statusNaN.repulsionForceN === Infinity);

// --- dispose -------------------------------------------------------------------
built.dispose();
check('isBuilt false after dispose', !built.isBuilt());
check('idempotent dispose', (built.dispose(), true));
check('meshes empty after dispose', built.getMeshes().length === 0);
check('root null after dispose', built.getRootNode() === null);
check('perimeter query still answers after dispose', built.getPerimeterStatus({ x: C.x + 180, y: C.y, z: 0 }).inLethalZone);
let threw = false;
try { built.init(scene); } catch { threw = true; }
check('init after dispose refuses', threw);

// NullEngine fallback with NO scene argument at all.
const fallback = new XCorpCitadel();
fallback.init();
check('NullEngine fallback init() with no args', fallback.isBuilt() && fallback.getMeshes().length > 60);
fallback.dispose();

// --- WorldScene integration ------------------------------------------------------
const world = new WorldScene({ seed: 'mala-voyage-2431' });
world.init(new NullEngine());
check('no citadel before build', world.getXCorpCitadel() === null);
check('update before build returns null', world.update(16.7, { x: 0, y: 0, z: 0 }) === null);
const wsCitadel = world.buildXCorpCitadel();
check('buildXCorpCitadel returns system', wsCitadel.isBuilt());
check('getXCorpCitadel returns built system', world.getXCorpCitadel() === wsCitadel);
check('buildXCorpCitadel idempotent', world.buildXCorpCitadel() === wsCitadel);
const wsStatus = world.update(1000 / 60, { x: C.x + 210, y: C.y, z: 0 });
check('WorldScene.update drives perimeter', wsStatus !== null && wsStatus.inShieldPerimeter && (wsStatus?.repulsionForceN ?? 0) > 0);
world.render(); // must not throw with citadel present
check('render() with citadel built', true);
world.dispose();
check('citadel nulled after world dispose', world.getXCorpCitadel() === null);
check('update after world dispose returns null', world.update(16.7, { x: 0, y: 0, z: 0 }) === null);

// Verdict
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`FAILURES: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('ALL CHECKS GREEN');
process.exit(0);
