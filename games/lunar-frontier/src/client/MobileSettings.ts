/**
 * Spec 33 Phase 5 §2.5 — Mobile GPU performance, battery & thermal management.
 *
 * Flagship phones report `devicePixelRatio = 3.0`+; rendering full-detail
 * WebGL2 at native 3x thermal-throttles mobile GPUs within minutes (frame
 * rates collapse below 15 FPS). This module owns the three-tier performance
 * preset system:
 *
 *   • **Battery Saver**  — hardware scaling 1.5 (≈720p), 30 FPS loop cap.
 *   • **Balanced**       — default mobile tier, DPR clamped to 1.5, 60 FPS.
 *   • **High Fidelity**  — native DPR up to 2.0, 60/120 FPS.
 *
 * Babylon hardware scaling follows the blueprint formula
 * `hardwareScalingLevel = 1 / DPR_effective` with
 * `DPR_effective = min(DPR_device, DPR_profile)` — except Battery Saver,
 * which pins an explicit `1.5` scaling level (render below canvas size,
 * ≈720p) regardless of the display's native ratio.
 *
 * The active profile persists in `localStorage['LF_MOBILE_PROFILE']` so a
 * player's choice survives reloads / PWA relaunches. Every DOM / storage /
 * `navigator` touch is guarded so headless Node smoke suites (NullEngine)
 * import and call this module without a browser.
 *
 * NOTE: storage constants deliberately avoid a `_KEY` suffix (secret
 * redaction pipelines redact identifiers matching `*_KEY`).
 */

export type MobilePerformanceProfile = 'battery-saver' | 'balanced' | 'high-fidelity';

/** All selectable profiles, in Settings-menu display order. */
export const MOBILE_PERFORMANCE_PROFILES: readonly MobilePerformanceProfile[] = [
  'battery-saver',
  'balanced',
  'high-fidelity',
];

/** `localStorage` slot holding the active profile id ('1' stored form). */
export const MOBILE_PROFILE_STORAGE = 'LF_MOBILE_PROFILE';

/** `localStorage` slot holding the haptics enable flag ('1' / '0'). */
export const HAPTICS_STORAGE = 'LF_HAPTICS';

/** Per-spec 33 §2.5 / blueprint §2.4 mobile UA sniff (Android / iOS). */
export const MOBILE_USER_AGENT_PATTERN = /Android|iPhone|iPad|iPod/i;

/** Default tier when nothing has been persisted yet (spec: Balanced). */
export const DEFAULT_MOBILE_PROFILE: MobilePerformanceProfile = 'balanced';

/** A single performance preset: DPR cap + frame-rate target + scaling pin. */
export interface MobilePerformanceSpec {
  readonly profile: MobilePerformanceProfile;
  /** Human label for the Settings sheet. */
  readonly label: string;
  /** Ceiling for `DPR_effective = min(DPR_device, maxDpr)`. */
  readonly maxDpr: number;
  /** Render-loop target in frames per second (loop gate, not a boost). */
  readonly fpsTarget: number;
  /**
   * Explicit Babylon `hardwareScalingLevel` pin, or null to derive
   * `1 / DPR_effective`. Battery Saver pins 1.5 (≈720p, spec §2.5).
   */
  readonly hardwareScalingPin: number | null;
}

export const MOBILE_PERFORMANCE_SPECS: Record<MobilePerformanceProfile, MobilePerformanceSpec> = {
  'battery-saver': {
    profile: 'battery-saver',
    label: 'Battery Saver',
    maxDpr: 1.0,
    fpsTarget: 30,
    hardwareScalingPin: 1.5,
  },
  balanced: {
    profile: 'balanced',
    label: 'Balanced',
    maxDpr: 1.5,
    fpsTarget: 60,
    hardwareScalingPin: null,
  },
  'high-fidelity': {
    profile: 'high-fidelity',
    label: 'High Fidelity',
    maxDpr: 2.0,
    fpsTarget: 120,
    hardwareScalingPin: null,
  },
};

/** Narrow an arbitrary value (e.g. a storage read) to a known profile. */
export function isMobilePerformanceProfile(value: unknown): value is MobilePerformanceProfile {
  return (
    typeof value === 'string' &&
    (MOBILE_PERFORMANCE_PROFILES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Guarded platform access (headless-safe)
// ---------------------------------------------------------------------------

/** Minimal storage surface (mirrors LunarHUD's hostile-host guards). */
export interface SettingsStorage {
  getItem(item: string): string | null;
  setItem(item: string, value: string): void;
}

function resolveStorage(): SettingsStorage | null {
  try {
    const g = globalThis as { localStorage?: SettingsStorage };
    const candidate = g.localStorage;
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function'
    ) {
      return candidate;
    }
  } catch {
    /* hostile / sandboxed environment — persistence simply absent */
  }
  return null;
}

/** Raw `window.devicePixelRatio`, defaulting to 1 off-browser. */
export function rawDevicePixelRatio(): number {
  try {
    const win = globalThis as { window?: { devicePixelRatio?: number } };
    const dpr = win.window?.devicePixelRatio;
    return typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  } catch {
    return 1;
  }
}

/** UA sniff only — true when the string looks like Android / iOS. */
export function isMobileUserAgent(userAgent: string | undefined): boolean {
  return typeof userAgent === 'string' && MOBILE_USER_AGENT_PATTERN.test(userAgent);
}

/** True on Android / iPhone / iPad / iPod browsers; false headless. */
export function isMobileDevice(): boolean {
  try {
    const nav = globalThis as { navigator?: { userAgent?: unknown } };
    return isMobileUserAgent(
      typeof nav.navigator?.userAgent === 'string' ? nav.navigator.userAgent : undefined,
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Profile persistence
// ---------------------------------------------------------------------------

/** Active profile from `localStorage['LF_MOBILE_PROFILE']`, else Balanced. */
export function readMobileProfile(): MobilePerformanceProfile {
  const storage = resolveStorage();
  if (storage === null) return DEFAULT_MOBILE_PROFILE;
  try {
    const stored = storage.getItem(MOBILE_PROFILE_STORAGE);
    return isMobilePerformanceProfile(stored) ? stored : DEFAULT_MOBILE_PROFILE;
  } catch {
    return DEFAULT_MOBILE_PROFILE;
  }
}

/** Persist the profile; silently inert when storage is hostile. */
export function writeMobileProfile(profile: MobilePerformanceProfile): void {
  const storage = resolveStorage();
  if (storage === null) return;
  try {
    storage.setItem(MOBILE_PROFILE_STORAGE, profile);
  } catch {
    /* quota / private mode — choice lasts for this session only */
  }
}

/** Haptics on/off flag from `localStorage['LF_HAPTICS']` (default on). */
export function readHapticsEnabled(): boolean {
  const storage = resolveStorage();
  if (storage === null) return true;
  try {
    return storage.getItem(HAPTICS_STORAGE) !== '0';
  } catch {
    return true;
  }
}

/** Persist the haptics flag; silently inert when storage is hostile. */
export function writeHapticsEnabled(enabled: boolean): void {
  const storage = resolveStorage();
  if (storage === null) return;
  try {
    storage.setItem(HAPTICS_STORAGE, enabled ? '1' : '0');
  } catch {
    /* hostile storage */
  }
}

// ---------------------------------------------------------------------------
// Scaling maths
// ---------------------------------------------------------------------------

/** `DPR_effective = min(DPR_device, DPR_profile)` for one preset. */
export function effectiveDpr(
  profile: MobilePerformanceProfile,
  deviceDpr: number = rawDevicePixelRatio(),
): number {
  const spec = MOBILE_PERFORMANCE_SPECS[profile];
  const safeDpr = Number.isFinite(deviceDpr) && deviceDpr > 0 ? deviceDpr : 1;
  return Math.min(safeDpr, spec.maxDpr);
}

/**
 * Babylon `hardwareScalingLevel` for one preset: the explicit pin when the
 * profile has one (Battery Saver → 1.5), else `1 / DPR_effective`.
 */
export function computeHardwareScalingLevel(
  profile: MobilePerformanceProfile,
  deviceDpr: number = rawDevicePixelRatio(),
): number {
  const spec = MOBILE_PERFORMANCE_SPECS[profile];
  const dpr = effectiveDpr(profile, deviceDpr);
  return spec.hardwareScalingPin ?? 1 / dpr;
}

/** Frame-gate interval (ms) for the profile's FPS target; 0 = uncapped. */
export function frameGateMs(profile: MobilePerformanceProfile): number {
  const spec = MOBILE_PERFORMANCE_SPECS[profile];
  return spec.fpsTarget > 0 ? 1000 / spec.fpsTarget : 0;
}

/** What {@link applyHardwareScaling} decided (for logs, HUD, and tests). */
export interface HardwareScalingOutcome {
  readonly profile: MobilePerformanceProfile;
  readonly rawDpr: number;
  readonly effectiveDpr: number;
  readonly scalingLevel: number;
  readonly frameGateMs: number;
  /** False when neither a mobile UA nor an explicit profile pin was given. */
  readonly applied: boolean;
}

/** Engine surface needed to apply scaling (keeps this module Babylon-free). */
export interface ScalableEngine {
  setHardwareScalingLevel(level: number): void;
}

/**
 * Resolve the active profile (explicit override wins over storage) and push
 * the resulting `hardwareScalingLevel` onto the engine. On desktop browsers
 * with no explicit profile this is a no-op (`applied: false`) so desktop
 * scaling stays exactly where the engine put it. Battery Saver's 30 FPS
 * target surfaces as {@link HardwareScalingOutcome.frameGateMs} — the caller
 * (ClientApp) gates its render loop, since Babylon exposes no per-tier cap.
 */
export function applyHardwareScaling(
  engine: ScalableEngine,
  forcedProfile: MobilePerformanceProfile | null = null,
  deviceDpr: number = rawDevicePixelRatio(),
): HardwareScalingOutcome {
  const profile = forcedProfile ?? readMobileProfile();
  const dpr = effectiveDpr(profile, deviceDpr);
  const scalingLevel = computeHardwareScalingLevel(profile, deviceDpr);
  const gateMs = frameGateMs(profile);
  const applied = forcedProfile !== null || isMobileDevice();
  if (applied) {
    try {
      engine.setHardwareScalingLevel(scalingLevel);
    } catch {
      /* engine already disposed — outcome still reports the maths */
    }
  }
  return {
    profile,
    rawDpr: deviceDpr,
    effectiveDpr: dpr,
    scalingLevel,
    frameGateMs: applied ? gateMs : 0,
    applied,
  };
}

/** Convenience namespace bundle (Settings sheets, harness scripts). */
const MobileSettingsNamespace = {
  MOBILE_PERFORMANCE_PROFILES,
  MOBILE_PERFORMANCE_SPECS,
  MOBILE_PROFILE_STORAGE,
  HAPTICS_STORAGE,
  DEFAULT_MOBILE_PROFILE,
  isMobilePerformanceProfile,
  isMobileDevice,
  isMobileUserAgent,
  readMobileProfile,
  writeMobileProfile,
  readHapticsEnabled,
  writeHapticsEnabled,
  effectiveDpr,
  computeHardwareScalingLevel,
  frameGateMs,
  applyHardwareScaling,
};

export default MobileSettingsNamespace;
