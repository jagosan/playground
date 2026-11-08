// Spec 37 Phase 5 probe — maintenance bay assembly, proximity + POI (NullEngine).
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { WorldScene, MAINTENANCE_BAY_RADIUS_M } from '/home/jagosan/repos/playground/games/lunar-frontier/src/engine/index.ts';
import { ClientApp, NAV_POI_DIRECTORY } from '/home/jagosan/repos/playground/games/lunar-frontier/src/client/ClientApp.ts';

let fails = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? '✔' : '✘'} ${name}`);
  if (!ok) fails++;
};

const world = new WorldScene({ seed: 'spec37-p5-probe' });
world.init(new NullEngine());

const bay = world.getMaintenanceBay();
check('bay auto-built on init()', bay !== null);
if (bay !== null) {
  check(`assembly has >= 50 meshes (got ${bay.meshes.length})`, bay.meshes.length >= 50);
  check(`4 halogen floodlights (got ${bay.lights.length})`, bay.lights.length === 4);
  check('center is (240, -160)', bay.center.x === 240 && bay.center.y === -160);
  check('radius is 12 m', bay.radiusM === MAINTENANCE_BAY_RADIUS_M);
  const g = world.getGroundHeightAt(240, -160);
  check(`padTopZ >= ground at seat (pad ${bay.padTopZ.toFixed(3)} vs ground ${g.toFixed(3)})`, bay.padTopZ >= g - 1e-9);
  const corners = [[229, -167], [251, -167], [229, -153], [251, -153]] as const;
  const cornerMax = Math.max(...corners.map(([x, y]) => world.getGroundHeightAt(x, y)));
  check(`padTopZ >= max corner ground (${bay.padTopZ.toFixed(3)} vs ${cornerMax.toFixed(3)})`, bay.padTopZ >= cornerMax - 1e-9);
  check('root is parented in scene graph', bay.root.parent !== null && bay.root.parent !== undefined);
  check('idempotent rebuild returns same assembly', world.buildMaintenanceBay() === bay);
  check('mesh count stable after second build call', world.getMaintenanceBay()!.meshes.length === bay.meshes.length);
}
check('isInMaintenanceBay inside', world.isInMaintenanceBay({ x: 243, y: -157 }));
check('isInMaintenanceBay outside', !world.isInMaintenanceBay({ x: 300, y: -160 }));
check('isInMaintenanceBay edge (12 m)', world.isInMaintenanceBay({ x: 252, y: -160 }));

world.render();
console.log('render ok (no throw)');

// POI directory + fuzzy nav.
const poi = NAV_POI_DIRECTORY.find((p) => p.id === 'outpost-garage');
check('outpost-garage in NAV_POI_DIRECTORY at (240,-160)',
  poi !== undefined && poi.position.x === 240 && poi.position.y === -160);
const navOf = (seed: string, q: string): string | undefined => {
  const a = new ClientApp({ seed, autoConnect: false, silent: true });
  a.setNavTarget(q);
  const id = a.getNavTarget()?.id;
  a.dispose();
  return id;
};
check('outpost keyword still resolves to canyon outpost', navOf('p5-a', 'outpost') === 'outpost');
check('trading keyword still resolves to trading-post', navOf('p5-b', 'trading') === 'trading-post');
// Pre-existing fuzzy law: 'outpost'.includes('post') lets the canyon entry
// (earlier in the directory) win 'post' — verify my addition didn't steal it.
check('post keyword not stolen by outpost-garage', navOf('p5-f', 'post') !== 'outpost-garage');
check('bare garage keyword resolves to outpost-garage', navOf('p5-g', 'garage') === 'outpost-garage');
check('garage bay keyword resolves to outpost-garage', navOf('p5-c', 'garage bay') === 'outpost-garage');
check('workshop keyword resolves to outpost-garage', navOf('p5-d', 'workshop') === 'outpost-garage');
check('maintenance bay keyword resolves to outpost-garage', navOf('p5-e', 'maintenance bay') === 'outpost-garage');

// ClientApp proximity + prompt integration (private access via cast, smoke style).
const app = new ClientApp({ seed: 'p5-app', autoConnect: false, silent: true });
app.init(null);
check('client bay present after init', app.world.getMaintenanceBay() !== null);
check('far from bay → not near', !app.isNearMaintenanceBay());
type SuitAny = { teleport: (x: number, y: number) => void };
type AppAny = {
  suit: SuitAny | null;
  hud: unknown;
  refreshHud: () => void;
};
const anyApp = app as unknown as AppAny;
if (anyApp.suit !== null) {
  // Headless tsx has no DOM, so ClientApp.hud is null — inject a recording
  // stub (Proxy: every method a no-op, setPrompts captured) and pump once.
  let captured: Array<{ key?: string; label?: string }> = [];
  anyApp.hud = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'setPrompts'
          ? (p: Array<{ key?: string; label?: string }>) => {
              captured = [...p];
            }
          : prop === 'isTradeDialogOpen' || prop === 'isMapVisible'
            ? () => false
            : () => undefined,
    },
  );
  anyApp.suit.teleport(240, -160);
  check('suit in bay → isNearMaintenanceBay', app.isNearMaintenanceBay());
  anyApp.refreshHud();
  check('HUD prompt strip carries [G] OPEN GARAGE TERMINAL',
    captured.some((p) => p.key === 'G' && p.label === 'OPEN GARAGE TERMINAL'));
  // Step clear of the ring — prompt must drop.
  anyApp.suit.teleport(400, -160);
  anyApp.refreshHud();
  check('outside bay → [G] prompt cleared',
    !captured.some((p) => p.key === 'G' && p.label === 'OPEN GARAGE TERMINAL'));
}
app.dispose();
world.dispose();
check('dispose drains bay', world.getMaintenanceBay() === null);

console.log(fails === 0 ? '\nALL CHECKS GREEN' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
