import * as THREE from 'three';
import { EventBus } from '../engine/Events';
import { EquipmentConfig } from '../entities/Equipment';

export class ProximitySystem {
  private eventBus: EventBus;
  private equipmentList: EquipmentConfig[];
  private activeEquipment: EquipmentConfig | null = null;

  constructor(eventBus: EventBus, equipmentList: EquipmentConfig[]) {
    this.eventBus = eventBus;
    this.equipmentList = equipmentList;
  }

  public update(playerPosition: THREE.Vector3): void {
    let closest: EquipmentConfig | null = null;
    let minDistance = Infinity;

    for (const eq of this.equipmentList) {
      const eqPos = new THREE.Vector3(...eq.position);
      const dist = playerPosition.distanceTo(eqPos);

      if (dist <= eq.interactionRadius && dist < minDistance) {
        minDistance = dist;
        closest = eq;
      }
    }

    if (closest !== this.activeEquipment) {
      if (this.activeEquipment) {
        this.eventBus.emit('EQUIPMENT_UNFOCUSED', { id: this.activeEquipment.id });
      }

      this.activeEquipment = closest;

      if (this.activeEquipment) {
        this.eventBus.emit('EQUIPMENT_FOCUSED', {
          id: this.activeEquipment.id,
          name: this.activeEquipment.name,
          minigameId: this.activeEquipment.minigameId,
          distance: minDistance,
        });
      }
    }
  }

  public getActiveEquipment(): EquipmentConfig | null {
    return this.activeEquipment;
  }
}
