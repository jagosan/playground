export interface WaveScoreboardEntry {
  id: string;
  name: string;
  rocksDelivered: number;
  fuelGeneratedLiters: number;
  damage: number;
}

export class LunarWaveManager {
  private currentWave: number = 1;
  private maxWaves: number = 5;
  public waveState: 'WAVE_ACTIVE' | 'WAVE_COMPLETE' | 'GAME_OVER' = 'WAVE_ACTIVE';
  private playerRocksDelivered: number = 0;
  private playerFuelLiters: number = 0;

  public constructor() {
    // Initialize
  }

  public initWave(waveNumber: number): void {
    this.currentWave = waveNumber;
    this.waveState = 'WAVE_ACTIVE';
    // Initialize competitors for this wave
    for (let i = 0; i < waveNumber; i++) {
      // We would create competitors here in a real implementation
    }
  }

  public completeWave(): void {
    this.waveState = 'WAVE_COMPLETE';
    console.log(`[LunarWaveManager] Wave ${this.currentWave} Complete! Player collected ${this.playerRocksDelivered} rocks.`);
  }

  public nextWave(): boolean {
    if (this.currentWave >= this.maxWaves) {
      this.waveState = 'GAME_OVER';
      return false;
    }
    this.initWave(this.currentWave + 1);
    return true;
  }

  public getScoreboard(playerDamage: number): WaveScoreboardEntry[] {
    const scoreboard: WaveScoreboardEntry[] = [
      {
        id: 'player',
        name: 'Artemis Pilot (You)',
        rocksDelivered: this.playerRocksDelivered,
        fuelGeneratedLiters: this.playerFuelLiters,
        damage: Math.round(playerDamage),
      },
    ];

    // In a real implementation, we would get competitors from the controller
    /*
    this.competitorController.getCompetitors().forEach((npc) => {
      scoreboard.push({
        id: npc.id,
        name: npc.name,
        rocksDelivered: npc.totalDelivered,
        fuelGeneratedLiters: npc.totalDelivered * 25,
        damage: Math.round(npc.damage),
      });
    });
    */

    scoreboard.sort((a, b) => b.rocksDelivered - a.rocksDelivered);
    return scoreboard;
  }
}