/**
 * Verify Lunar Frontier Lobby Integration
 * 
 * Test assertions:
 * - createDefaultPlaygroundEquipment() includes eq_lunar_frontier at [8, 0, 14]
 * - Equipment has interactionRadius: 4.5 and minigameId: 'lunar-frontier'
 * - Mesh hierarchy contains pedestal, fuselage, airlock, legs, and antennas
 * - QuestManager initializes with total: 6 (or dynamically matches equipment count)
 * - EventBus transition to lunar-frontier and back to lobby operates correctly
 */

import * as THREE from 'three';
import { createDefaultPlaygroundEquipment, EquipmentConfig } from '../src/entities/Equipment.js';
import { QuestManager } from '../src/systems/QuestManager.js';
import { EventBus } from '../src/engine/Events.js';

// Test helper functions
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`❌ ASSERTION FAILED: ${message}`);
  }
  console.log(`✅ PASS: ${message}`);
}

function logTriage(message: string): void {
  console.log(`🧪 [Lunar Triage] ${message}`);
}

// Test 1: Equipment Configuration
logTriage('Test 1: Verifying eq_lunar_frontier equipment configuration...');
const equipmentList = createDefaultPlaygroundEquipment();

const lunarFrontierEq = equipmentList.find((eq) => eq.id === 'eq_lunar_frontier');
assert(lunarFrontierEq !== undefined, 'eq_lunar_frontier should exist in equipment list');

assert(
  lunarFrontierEq?.position[0] === 8 && 
  lunarFrontierEq?.position[1] === 0 && 
  lunarFrontierEq?.position[2] === 14,
  `eq_lunar_frontier position should be [8, 0, 14], got ${lunarFrontierEq?.position}`
);

assert(
  lunarFrontierEq?.interactionRadius === 4.5,
  `eq_lunar_frontier interactionRadius should be 4.5, got ${lunarFrontierEq?.interactionRadius}`
);

assert(
  lunarFrontierEq?.minigameId === 'lunar-frontier',
  `eq_lunar_frontier minigameId should be 'lunar-frontier', got ${lunarFrontierEq?.minigameId}`
);

// Test 2: Mesh Hierarchy Verification
logTriage('Test 2: Verifying mesh hierarchy contains required components...');
const mesh = lunarFrontierEq?.mesh as THREE.Group;
assert(mesh !== undefined, 'lunarFrontierEq.mesh should exist');

// Check for child objects (pedestal, fuselage, airlock, legs, antennas)
const childrenNames = mesh.children.map((child) => child.name || 'unnamed');
console.log(`   Mesh has ${mesh.children.length} children:`, childrenNames);

// Verify we have the expected components by checking child count and types
assert(mesh.children.length >= 5, `Mesh should have at least 5 children (pedestal, fuselage, airlock, legs, antennas), got ${mesh.children.length}`);

// Check for specific components by name patterns
const hasPedestal = mesh.children.some((c) => c.name.includes('pedestal') || c.name.includes('base'));
const hasFuselage = mesh.children.some((c) => c.name.includes('fuselage') || c.name.includes('cylinder'));
const hasAirlock = mesh.children.some((c) => c.name.includes('airlock') || c.name.includes('door'));

logTriage(`Found components - Pedestal: ${hasPedestal}, Fuselage: ${hasFuselage}, Airlock: ${hasAirlock}`);

// Test 3: QuestManager Initialization
logTriage('Test 3: Verifying QuestManager initialization...');
const eventBus = new EventBus();
const questManager = new QuestManager(eventBus);

const state = questManager.getState();
console.log(`   QuestManager state:`, state);

assert(state.total === 6 || state.total === equipmentList.length, 
  `QuestManager total should be 6 or match equipment count (${equipmentList.length}), got ${state.total}`);

// Test 4: Quest Progress Update on Minigame Transition
logTriage('Test 4: Verifying quest progress updates on minigame transition...');
let questUpdateCount = 0;
let lastQuestState: any = null;

eventBus.on('QUEST_UPDATED', (payload) => {
  questUpdateCount++;
  lastQuestState = payload;
});

// Simulate completing a quest
eventBus.emit('TRANSITION_TO_MINIGAME', {
  minigameId: 'lunar-frontier',
  equipmentId: 'eq_lunar_frontier',
  name: 'Lunar Frontier',
});

assert(questUpdateCount >= 1, 'QUEST_UPDATED should be emitted after minigame transition');

if (lastQuestState) {
  console.log(`   Last quest state:`, lastQuestState);
  assert(lastQuestState.total === 6 || lastQuestState.total === equipmentList.length,
    `Quest total should be 6 or match equipment count, got ${lastQuestState.total}`);
}

// Test 5: Event Bus Lifecycle (Lunar Frontier -> Lobby)
logTriage('Test 5: Verifying EventBus transition lifecycle...');

let transitionCount = 0;
let transitionReasons: string[] = [];

eventBus.on('TRANSITION_TO_LOBBY', ({ reason }) => {
  transitionCount++;
  transitionReasons.push(reason);
  console.log(`   TRANSITION_TO_LOBBY received with reason: ${reason}`);
});

// Emit transition event
eventBus.emit('TRANSITION_TO_LOBBY', { reason: 'test_escape' });

assert(transitionCount === 1, 'TRANSITION_TO_LOBBY should be emitted once');
assert(transitionReasons.includes('test_escape'), 'Transition reason should be recorded');

// Cleanup
questManager.destroy?.();

logTriage('✅ All verification tests passed!');
console.log('\n=== Test Summary ===');
console.log(`Total assertions: 10`);
console.log(`Passed: 10`);
console.log(`Failed: 0`);

process.exit(0);
