import * as THREE from 'three';

export interface EquipmentConfig {
  id: string;
  name: string;
  description: string;
  minigameId: string;
  position: [number, number, number];
  interactionRadius: number;
  mesh: THREE.Group;
}

export function createDefaultPlaygroundEquipment(): EquipmentConfig[] {
  const equipment: EquipmentConfig[] = [];

  // 1. Swing Set
  const swingGroup = new THREE.Group();
  const poleMat = new THREE.MeshLambertMaterial({ color: 0xef4444 }); // Bright red
  const seatMat = new THREE.MeshLambertMaterial({ color: 0x1f2937 }); // Black rubber

  // A-Frame legs
  const legGeom = new THREE.CylinderGeometry(0.08, 0.08, 4.2);
  const leg1 = new THREE.Mesh(legGeom, poleMat);
  leg1.position.set(-2.5, 2.0, -0.8);
  leg1.rotation.x = 0.25;
  leg1.castShadow = true;
  swingGroup.add(leg1);

  const leg2 = new THREE.Mesh(legGeom, poleMat);
  leg2.position.set(-2.5, 2.0, 0.8);
  leg2.rotation.x = -0.25;
  leg2.castShadow = true;
  swingGroup.add(leg2);

  const leg3 = new THREE.Mesh(legGeom, poleMat);
  leg3.position.set(2.5, 2.0, -0.8);
  leg3.rotation.x = 0.25;
  leg3.castShadow = true;
  swingGroup.add(leg3);

  const leg4 = new THREE.Mesh(legGeom, poleMat);
  leg4.position.set(2.5, 2.0, 0.8);
  leg4.rotation.x = -0.25;
  leg4.castShadow = true;
  swingGroup.add(leg4);

  // Top crossbar
  const crossbarGeom = new THREE.CylinderGeometry(0.1, 0.1, 5.4);
  const crossbar = new THREE.Mesh(crossbarGeom, poleMat);
  crossbar.rotation.z = Math.PI / 2;
  crossbar.position.set(0, 4.0, 0);
  crossbar.castShadow = true;
  swingGroup.add(crossbar);

  // Swings (2 seats)
  [-1.2, 1.2].forEach((offset) => {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.08, 0.35), seatMat);
    seat.position.set(offset, 0.7, 0);
    seat.castShadow = true;
    swingGroup.add(seat);

    // Chains
    const chainGeom = new THREE.CylinderGeometry(0.02, 0.02, 3.3);
    const chainMat = new THREE.MeshLambertMaterial({ color: 0x9ca3af });
    const chainL = new THREE.Mesh(chainGeom, chainMat);
    chainL.position.set(offset - 0.35, 2.35, 0);
    swingGroup.add(chainL);

    const chainR = new THREE.Mesh(chainGeom, chainMat);
    chainR.position.set(offset + 0.35, 2.35, 0);
    swingGroup.add(chainR);
  });

  swingGroup.position.set(-10, 0, -8);
  equipment.push({
    id: 'eq_swings',
    name: 'Swing Set',
    description: 'Classic playground swings. Feel the pendulum physics.',
    minigameId: 'swings',
    position: [-10, 0, -8],
    interactionRadius: 4.5,
    mesh: swingGroup,
  });

  // 2. Playground Slide
  const slideGroup = new THREE.Group();
  const ladderMat = new THREE.MeshLambertMaterial({ color: 0x3b82f6 }); // Blue
  const chuteMat = new THREE.MeshLambertMaterial({ color: 0xfacc15 });  // Yellow

  // Ladder posts
  const postGeom = new THREE.CylinderGeometry(0.06, 0.06, 3.5);
  const post1 = new THREE.Mesh(postGeom, ladderMat);
  post1.position.set(-0.4, 1.75, -2.5);
  slideGroup.add(post1);
  const post2 = new THREE.Mesh(postGeom, ladderMat);
  post2.position.set(0.4, 1.75, -2.5);
  slideGroup.add(post2);

  // Platform at top
  const platform = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, 1.0), ladderMat);
  platform.position.set(0, 3.0, -2.0);
  slideGroup.add(platform);

  // Slide Chute (inclined box)
  const chute = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 4.5), chuteMat);
  chute.position.set(0, 1.5, 0.3);
  chute.rotation.x = -0.7;
  chute.castShadow = true;
  slideGroup.add(chute);

  slideGroup.position.set(10, 0, -8);
  equipment.push({
    id: 'eq_slide',
    name: 'Tower Slide',
    description: 'High-speed downward rush with friction and momentum.',
    minigameId: 'slide',
    position: [10, 0, -8],
    interactionRadius: 4.0,
    mesh: slideGroup,
  });

  // 3. Merry-Go-Round / Roundabout
  const roundaboutGroup = new THREE.Group();
  const baseMat = new THREE.MeshLambertMaterial({ color: 0x10b981 }); // Emerald
  const barMat = new THREE.MeshLambertMaterial({ color: 0xf97316 });  // Orange

  const disc = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.2, 16), baseMat);
  disc.position.y = 0.2;
  disc.receiveShadow = true;
  roundaboutGroup.add(disc);

  // Handles
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.05, 8, 16, Math.PI), barMat);
    handle.position.set(Math.cos(angle) * 1.5, 0.8, Math.sin(angle) * 1.5);
    handle.rotation.y = angle;
    roundaboutGroup.add(handle);
  }

  roundaboutGroup.position.set(-8, 0, 8);
  equipment.push({
    id: 'eq_roundabout',
    name: 'Merry-Go-Round',
    description: 'Angular velocity simulator. Hold on tight!',
    minigameId: 'roundabout',
    position: [-8, 0, 8],
    interactionRadius: 4.0,
    mesh: roundaboutGroup,
  });

  // 4. Moon Buggy Ride (Spec 02 Minigame Portal)
  const buggyGroup = new THREE.Group();
  const roverMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }); // Lunar white
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x0f172a }); // Dark tires
  const goldMat = new THREE.MeshLambertMaterial({ color: 0xf59e0b });  // Gold foil

  // Pedestal
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.5, 0.4, 8), new THREE.MeshLambertMaterial({ color: 0x475569 }));
  pedestal.position.y = 0.2;
  pedestal.receiveShadow = true;
  buggyGroup.add(pedestal);

  // Rover chassis
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2.4), roverMat);
  chassis.position.y = 1.0;
  chassis.castShadow = true;
  buggyGroup.add(chassis);

  // Dish Antenna (Gold)
  const dish = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.3, 8), goldMat);
  dish.position.set(0.4, 1.6, -0.6);
  dish.rotation.x = 0.5;
  dish.castShadow = true;
  buggyGroup.add(dish);

  // Wheels
  const wheelGeom = new THREE.CylinderGeometry(0.35, 0.35, 0.25, 12);
  const wheelOffsets = [
    [-0.9, 0.7, 0.8],
    [0.9, 0.7, 0.8],
    [-0.9, 0.7, -0.8],
    [0.9, 0.7, -0.8],
  ];
  wheelOffsets.forEach(([x, y, z]) => {
    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, y, z);
    wheel.castShadow = true;
    buggyGroup.add(wheel);
  });

  buggyGroup.position.set(8, 0, 8);
  equipment.push({
    id: 'eq_moon_buggy',
    name: 'Moon Buggy Ride',
    description: 'Spec 02: Lunar surface rover, 1/6th gravity rock collection.',
    minigameId: 'moon-buggy',
    position: [8, 0, 8],
    interactionRadius: 4.5,
    mesh: buggyGroup,
  });

  return equipment;
}
