/**
 * Mandalorian: Nevarro Frontier — Browser client bootstrap (Spec 40 §2).
 *
 * Phase 1 scaffold: exports physics constants and attaches a readiness flag
 * when running in a browser context while remaining 100% NullEngine/Node-safe.
 */
import {
  MANDO_GRAVITY,
  WALK_SPEED,
  SPRINT_SPEED,
  JETPACK_THRUST,
  createInitialMandoState,
} from '../physics/MandoPhysics.ts';

export const MANDO_CLIENT_BOOTSTRAP = {
  gravity: MANDO_GRAVITY,
  walkSpeed: WALK_SPEED,
  sprintSpeed: SPRINT_SPEED,
  jetpackThrust: JETPACK_THRUST,
};

export function bootstrapMandoClient(): void {
  const initial = createInitialMandoState();
  if (typeof document !== 'undefined') {
    const loading = document.getElementById('loading');
    if (loading) {
      loading.setAttribute('data-physics-ready', String(initial.jetpackFuel));
    }
  }
}

bootstrapMandoClient();
