import * as THREE from 'three';
import { SceneManager } from './engine/SceneManager';
import { EventBus } from './engine/Events';
import { Player } from './entities/Player';
import { createDefaultPlaygroundEquipment, EquipmentConfig } from './entities/Equipment';
import { ProximitySystem } from './systems/ProximitySystem';
import { QuestManager } from './systems/QuestManager';
import { HUD } from './ui/HUD';

function createPlaygroundEnvironment(scene: THREE.Scene): void {
  // Retro sky color
  scene.background = new THREE.Color(0x87ceeb); // Sky blue
  scene.fog = new THREE.Fog(0x87ceeb, 40, 100);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambientLight);

  const sunLight = new THREE.DirectionalLight(0xfff7ed, 1.2);
  sunLight.position.set(20, 40, 20);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 1024;
  sunLight.shadow.mapSize.height = 1024;
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 100;
  sunLight.shadow.camera.left = -25;
  sunLight.shadow.camera.right = 25;
  sunLight.shadow.camera.top = 25;
  sunLight.shadow.camera.bottom = -25;
  scene.add(sunLight);

  // Stylized ground plane (Retro green rubber playground tile)
  const groundGeom = new THREE.PlaneGeometry(60, 60, 15, 15);
  groundGeom.rotateX(-Math.PI / 2);
  const groundMat = new THREE.MeshLambertMaterial({
    color: 0x4ade80, // Soft vibrant turf green
  });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.receiveShadow = true;
  scene.add(ground);

  // Border fence / rubber curbs
  const curbMat = new THREE.MeshLambertMaterial({ color: 0x64748b });
  const curbGeomX = new THREE.BoxGeometry(60, 0.4, 0.4);
  const curbGeomZ = new THREE.BoxGeometry(0.4, 0.4, 60);

  const curbN = new THREE.Mesh(curbGeomX, curbMat);
  curbN.position.set(0, 0.2, -30);
  scene.add(curbN);

  const curbS = new THREE.Mesh(curbGeomX, curbMat);
  curbS.position.set(0, 0.2, 30);
  scene.add(curbS);

  const curbW = new THREE.Mesh(curbGeomZ, curbMat);
  curbW.position.set(-30, 0.2, 0);
  scene.add(curbW);

  const curbE = new THREE.Mesh(curbGeomZ, curbMat);
  curbE.position.set(30, 0.2, 0);
  scene.add(curbE);
}

function bootstrap(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('Missing #app root element');

  const eventBus = new EventBus();
  const sceneManager = new SceneManager(app);
  const lobbyScene = new THREE.Scene();

  // Environment & equipment
  createPlaygroundEnvironment(lobbyScene);

  const equipmentList: EquipmentConfig[] = createDefaultPlaygroundEquipment();
  for (const eq of equipmentList) {
    lobbyScene.add(eq.mesh);
  }

  sceneManager.setScene(lobbyScene);

  // Player & Systems
  const player = new Player(sceneManager, eventBus);
  const proximitySystem = new ProximitySystem(eventBus, equipmentList);
  new QuestManager(eventBus);
  new HUD(eventBus);

  // Equipment interaction trigger ('E' key)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyE') {
      const active = proximitySystem.getActiveEquipment();
      if (active) {
        eventBus.emit('TRANSITION_TO_MINIGAME', {
          minigameId: active.minigameId,
          equipmentId: active.id,
          name: active.name,
        });
      }
    }
  });

  // Game Loop
  sceneManager.onFrame((delta) => {
    player.update(delta);
    proximitySystem.update(player.position);

    // Subtle idle animation for Merry-Go-Round
    const roundabout = equipmentList.find((eq) => eq.id === 'eq_roundabout');
    if (roundabout) {
      roundabout.mesh.rotation.y += 0.3 * delta;
    }
  });

  sceneManager.start();
}

bootstrap();
