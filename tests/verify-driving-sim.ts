/**
 * Root mirror of the Spec 17 driving-sim acceptance gate (TASK-PLAY-064f).
 *
 * Spec 17 §7.4 lists `npx tsx tests/verify-driving-sim.ts` as an invocation
 * path from the repo root. The suite itself lives with the game it verifies
 * (`games/lunar-frontier/tests/verify-driving-sim.ts`, which owns the
 * relative imports into src/ and node_modules); this thin shim executes it
 * unchanged so both invocations are one and the same 66-check gate.
 *
 * Run from the repo root:  npx tsx tests/verify-driving-sim.ts
 */
import '../games/lunar-frontier/tests/verify-driving-sim.ts';
