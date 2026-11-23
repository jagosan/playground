// MandoAudioSystem.ts - NullEngine-safe procedural Web Audio API synthesizer
// No external MP3/WAV files - all sound generated procedurally

export class MandoAudioSystem {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private isInitialized = false;

  constructor() {
    if (typeof window !== 'undefined' && window.AudioContext) {
      this.ctx = new window.AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.5;
      this.masterGain.connect(this.ctx.destination);
    }
  }

  async unlock(): Promise<void> {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    this.isInitialized = true;
  }

  update(state: { isGrounded: boolean; jetpackFuel: number }): void {
    // Audio updates based on physics state
    if (!this.ctx || !this.masterGain) return;
  }

  dispose(): void {
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.masterGain = null;
  }
}
