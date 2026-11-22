/**
 * Mandalorian: Nevarro Frontier — Town Layout & Building Colliders (Spec 40 §4.1)
 *
 * Defines the core town structures with walkable rooftops for physics collision:
 * - Central Plaza at `(0, 0)` with stone pad and glowing brazier
 * - The Cantina at `(24, 18)` with adobe/mudbrick dome, archway, warm amber glow, awning, walkable flat rooftop terrace (`roofZ = 5.2`)
 * - Bounty Hunters' Guild Hall at `(-26, 16)` with stepped stone hall, columns, walkable upper balcony/roof (`roofZ = 6.5`)
 * - The Armorer's Forge at `(-22, -24)` with basalt alcove, glowing orange crucible/anvil, Beskar ingot stacks
 * - Market Bazaar stalls at `(18, -22)`, `(6, 26)`, `(-8, -28)` with colorful terracotta/ochre canopies, crates, 3 tall moisture vaporator spires (`z = 9m`)
 * - Durasteel Landing Pad at `(58, -10)` (`R = 14m, roofZ = 1.2m`) with perimeter lights
 *
 * Strict Invariants:
 * - Pure procedural code (100% NullEngine-safe, zero DOM/canvas/GLB dependencies)
 * - TypeScript strict compliance (verbatimModuleSyntax, import type, noUncheckedIndexedAccess)
 * - All building colliders use `MandoStructureCollider` interface for AABB/cylinder wall push-out
 */

// ============================================================================
// TYPES & INTERFACES (imported from MandoPhysics)
// ============================================================================

import type { MandoAabbCollider, MandoCylinderCollider, MandoStructureCollider } from './MandoPhysics.ts';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Central Plaza marker radius (meters). */
export const PLAZA_MARKER_RADIUS = 2.5;

/** Central Plaza stone pad elevation above terrain. */
export const PLAZA_STONE_PAD_ELEVATION = 0.15;

/** Central Plaza brazier glow height above pad. */
export const PLAZA_BRAZIER_HEIGHT = 1.8;

/** Market Bazaar stall canopy height (meters). */
export const MARKET_STALL_CANOPY_HEIGHT = 3.2;

/** Moisture vaporator spire height above ground (meters). */
export const VAPORATOR_SPIRE_HEIGHT = 9.0;

/** Durasteel Landing Pad perimeter light height above pad. */
export const LANDING_PAD_LIGHT_HEIGHT = 0.8;

// ============================================================================
// BUILDING DEFINITIONS
// ============================================================================

/**
 * Central Plaza - Stone pad with glowing brazier at town center.
 * Provides a visual landmark and flat walking surface.
 */
export interface CentralPlaza {
  kind: 'plaza';
  id: string;
  /** Center X coordinate (meters). */
  x: number;
  /** Center Y coordinate (meters). */
  y: number;
  /** Stone pad radius (meters). */
  radius: number;
  /** Stone pad elevation above terrain. */
  padElevation: number;
  /** Brazier glow height above pad. */
  brazierHeight: number;
}

/**
 * The Cantina - Adobe/mudbrick dome structure with archway, warm amber glow,
 * awning, and walkable flat rooftop terrace.
 */
export interface Cantina {
  kind: 'cantina';
  id: string;
  /** Center X coordinate (meters). */
  x: number;
  /** Center Y coordinate (meters). */
  y: number;
  /** Main building radius (meters). */
  radius: number;
  /** Walkable rooftop elevation (meters). */
  roofZ: number;
  /** Archway width (meters). */
  archWidth: number;
  /** Archway height (meters). */
  archHeight: number;
  /** Awning extension from building edge (meters). */
  awningExtension: number;
}

/**
 * Bounty Hunters' Guild Hall - Stepped stone hall with columns and walkable upper balcony/roof.
 */
export interface GuildHall {
  kind: 'guild-hall';
  id: string;
  /** Center X coordinate (meters). */
  x: number;
  /** Center Y coordinate (meters). */
  y: number;
  /** Main hall width (X-axis, meters). */
  width: number;
  /** Main hall depth (Y-axis, meters). */
  depth: number;
  /** Walkable upper balcony/roof elevation (meters). */
  roofZ: number;
  /** Column height from ground to balcony (meters). */
  columnHeight: number;
  /** Step-up height from ground to main hall floor. */
  stepUpHeight: number;
}

/**
 * The Armorer's Forge - Basalt alcove with glowing orange crucible/anvil and Beskar ingot stacks.
 */
export interface ArmoryForge {
  kind: 'forge';
  id: string;
  /** Center X coordinate (meters). */
  x: number;
  /** Center Y coordinate (meters). */
  y: number;
  /** Forge alcove radius (meters). */
  radius: number;
  /** Workbench/elevation floor (meters). */
  floorZ: number;
  /** Crucible/anvil glow height above floor. */
  forgeHeight: number;
}

/**
 * Market Bazaar Stall - Colorful terracotta/ochre canopy with crates.
 */
export interface MarketStall {
  kind: 'market-stall';
  id: string;
  /** Center X coordinate (meters). */
  x: number;
  /** Center Y coordinate (meters). */
  y: number;
  /** Stall footprint radius (meters). */
  radius: number;
  /** Canopy top elevation (meters). */
  canopyZ: number;
}

/**
 * Moisture Vaporator Spire - Tall tower for moisture collection.
 */
export interface VaporatorSpire {
  kind: 'vaporator';
  id: string;
  /** Center X coordinate (meters). */
  x: number;
  /** Center Y coordinate (meters). */
  y: number;
  /** Spire radius (meters). */
  radius: number;
  /** Total spire height (meters). */
  height: number;
}

/**
 * Durasteel Landing Pad - Large circular landing area with perimeter lights.
 */
export interface DurasteelLandingPad {
  kind: 'landing-pad';
  id: string;
  /** Center X coordinate (meters). */
  x: number;
  /** Center Y coordinate (meters). */
  y: number;
  /** Pad radius (meters). */
  radius: number;
  /** Walkable pad elevation (meters). */
  padZ: number;
  /** Perimeter light height above pad. */
  lightHeight: number;
}

// ============================================================================
// COLLIDER GENERATORS
// ============================================================================

/**
 * Generate AABB collider for Central Plaza stone pad.
 * The plaza is flat and walkable at `padElevation`.
 */
export function createPlazaCollider(plaza: CentralPlaza): MandoAabbCollider {
  const halfSize = plaza.radius;
  return {
    kind: 'aabb',
    id: plaza.id,
    minX: plaza.x - halfSize,
    maxX: plaza.x + halfSize,
    minY: plaza.y - halfSize,
    maxY: plaza.y + halfSize,
    baseZ: 0,
    topZ: plaza.padElevation,
    walkableRoof: true,
  };
}

/**
 * Generate cylinder collider for The Cantina building with walkable rooftop.
 */
export function createCantinaCollider(cantina: Cantina): MandoCylinderCollider {
  return {
    kind: 'cylinder',
    id: cantina.id,
    x: cantina.x,
    y: cantina.y,
    radius: cantina.radius,
    baseZ: 0,
    topZ: cantina.roofZ,
    walkableRoof: true,
  };
}

/**
 * Generate AABB collider for Bounty Hunters' Guild Hall with walkable roof.
 */
export function createGuildHallCollider(guildHall: GuildHall): MandoAabbCollider {
  const halfWidth = guildHall.width / 2;
  const halfDepth = guildHall.depth / 2;
  return {
    kind: 'aabb',
    id: guildHall.id,
    minX: guildHall.x - halfWidth,
    maxX: guildHall.x + halfWidth,
    minY: guildHall.y - halfDepth,
    maxY: guildHall.y + halfDepth,
    baseZ: 0,
    topZ: guildHall.roofZ,
    walkableRoof: true,
  };
}

/**
 * Generate cylinder collider for The Armorer's Forge.
 */
export function createForgeCollider(forge: ArmoryForge): MandoCylinderCollider {
  return {
    kind: 'cylinder',
    id: forge.id,
    x: forge.x,
    y: forge.y,
    radius: forge.radius,
    baseZ: 0,
    topZ: forge.floorZ,
    walkableRoof: false,
  };
}

/**
 * Generate cylinder collider for Market Bazaar stall with walkable canopy (for jump-up).
 */
export function createMarketStallCollider(stall: MarketStall): MandoCylinderCollider {
  return {
    kind: 'cylinder',
    id: stall.id,
    x: stall.x,
    y: stall.y,
    radius: stall.radius,
    baseZ: 0,
    topZ: stall.canopyZ,
    walkableRoof: false, // Canopy is fabric/wood, not intended for walking
  };
}

/**
 * Generate cylinder collider for Moisture Vaporator Spire.
 */
export function createVaporatorCollider(spire: VaporatorSpire): MandoCylinderCollider {
  return {
    kind: 'cylinder',
    id: spire.id,
    x: spire.x,
    y: spire.y,
    radius: spire.radius,
    baseZ: 0,
    topZ: spire.height,
    walkableRoof: false,
  };
}

/**
 * Generate cylinder collider for Durasteel Landing Pad with walkable pad.
 */
export function createLandingPadCollider(pad: DurasteelLandingPad): MandoCylinderCollider {
  return {
    kind: 'cylinder',
    id: pad.id,
    x: pad.x,
    y: pad.y,
    radius: pad.radius,
    baseZ: 0,
    topZ: pad.padZ,
    walkableRoof: true,
  };
}

// ============================================================================
// TOWN DEFINITION
// ============================================================================

/** Complete Nevarro town definition with all structures. */
export interface NevarroTown {
  centralPlaza: CentralPlaza;
  cantina: Cantina;
  guildHall: GuildHall;
  armoryForge: ArmoryForge;
  marketStalls: MarketStall[];
  vaporatorSpires: VaporatorSpire[];
  durasteelLandingPad: DurasteelLandingPad;
}

/** Generate the complete Nevarro town layout per Spec 40 §4.1. */
export function createNevarroTown(): NevarroTown {
  return {
    centralPlaza: {
      kind: 'plaza',
      id: 'central-plaza',
      x: 0,
      y: 0,
      radius: PLAZA_MARKER_RADIUS,
      padElevation: PLAZA_STONE_PAD_ELEVATION,
      brazierHeight: PLAZA_BRAZIER_HEIGHT,
    },
    cantina: {
      kind: 'cantina',
      id: 'the-cantina',
      x: 24,
      y: 18,
      radius: 10,
      roofZ: 5.2,
      archWidth: 6,
      archHeight: 4,
      awningExtension: 2.5,
    },
    guildHall: {
      kind: 'guild-hall',
      id: 'bounty-hunters-guild',
      x: -26,
      y: 16,
      width: 18,
      depth: 14,
      roofZ: 6.5,
      columnHeight: 4.5,
      stepUpHeight: 0.4,
    },
    armoryForge: {
      kind: 'forge',
      id: 'armorer-forge',
      x: -22,
      y: -24,
      radius: 5.5,
      floorZ: 0,
      forgeHeight: 2.8,
    },
    marketStalls: [
      {
        kind: 'market-stall',
        id: 'market-stall-1',
        x: 18,
        y: -22,
        radius: 3.5,
        canopyZ: MARKET_STALL_CANOPY_HEIGHT,
      },
      {
        kind: 'market-stall',
        id: 'market-stall-2',
        x: 6,
        y: 26,
        radius: 3.5,
        canopyZ: MARKET_STALL_CANOPY_HEIGHT,
      },
      {
        kind: 'market-stall',
        id: 'market-stall-3',
        x: -8,
        y: -28,
        radius: 3.5,
        canopyZ: MARKET_STALL_CANOPY_HEIGHT,
      },
    ],
    vaporatorSpires: [
      {
        kind: 'vaporator',
        id: 'vaporator-1',
        x: 20,
        y: -24,
        radius: 0.6,
        height: VAPORATOR_SPIRE_HEIGHT,
      },
      {
        kind: 'vaporator',
        id: 'vaporator-2',
        x: 8,
        y: 24,
        radius: 0.6,
        height: VAPORATOR_SPIRE_HEIGHT,
      },
      {
        kind: 'vaporator',
        id: 'vaporator-3',
        x: -6,
        y: -30,
        radius: 0.6,
        height: VAPORATOR_SPIRE_HEIGHT,
      },
    ],
    durasteelLandingPad: {
      kind: 'landing-pad',
      id: 'durasteel-landing-pad',
      x: 58,
      y: -10,
      radius: 14,
      padZ: 1.2,
      lightHeight: LANDING_PAD_LIGHT_HEIGHT,
    },
  };
}

/** Extract all structure colliders from a NevarroTown for physics collision queries. */
export function getTownColliders(town: NevarroTown): MandoStructureCollider[] {
  const colliders: MandoStructureCollider[] = [];

  // Plaza (AABB)
  colliders.push(createPlazaCollider(town.centralPlaza));

  // Buildings with walkable rooftops
  colliders.push(createCantinaCollider(town.cantina));
  colliders.push(createGuildHallCollider(town.guildHall));
  colliders.push(createLandingPadCollider(town.durasteelLandingPad));

  // Structures without walkable rooftops (wall collision only)
  colliders.push(createForgeCollider(town.armoryForge));
  town.marketStalls.forEach((stall) => colliders.push(createMarketStallCollider(stall)));
  town.vaporatorSpires.forEach((spire) => colliders.push(createVaporatorCollider(spire)));

  return colliders;
}

// ============================================================================
// SURFACE QUERY HELPERS
// ============================================================================

/**
 * Create a surface query function for the Nevarro town that returns
 * floor/rooftop elevation and structure ID at any `(x, y)` location.
 */
export function createTownSurfaceQuery(town: NevarroTown): (x: number, y: number, currentZ: number) => {
  floorZ: number;
  terrainZ: number;
  structureId: string | null;
} {
  const colliders = getTownColliders(town);

  return (x: number, y: number, currentZ: number) => {
    let floorZ = 0; // Base terrain elevation
    let structureId: string | null = null;

    for (const col of colliders) {
      if (!col.walkableRoof) continue;

      const baseZ = col.baseZ ?? 0;
      const isInside = col.kind === 'aabb'
        ? x >= col.minX && x <= col.maxX && y >= col.minY && y <= col.maxY
        : (x - col.x) ** 2 + (y - col.y) ** 2 <= col.radius ** 2;

      // Return the highest walkable floor/rooftop at this location
      // A point is considered "on" a structure if it's within the footprint
      if (isInside && currentZ >= baseZ - 2.0) {
        if (col.topZ >= floorZ) {
          floorZ = col.topZ;
          structureId = col.id;
        }
      }
    }

    return { floorZ, terrainZ: 0, structureId };
  };
}

// ============================================================================
// TEST HELPERS
// ============================================================================

/** Verify all town colliders are valid. */
export function verifyTownColliders(town: NevarroTown): boolean {
  const colliders = getTownColliders(town);
  if (colliders.length !== 10) {
    console.error(`Expected 10 colliders, got ${colliders.length}`);
    return false;
  }

  for (const col of colliders) {
    if (col.kind === 'aabb') {
      if (col.minX >= col.maxX || col.minY >= col.maxY) {
        console.error(`Invalid AABB collider: ${col.id}`);
        return false;
      }
    } else {
      if (col.radius <= 0) {
        console.error(`Invalid cylinder collider radius: ${col.id}`);
        return false;
      }
    }
  }

  return true;
}
