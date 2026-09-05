import * as THREE from 'three';

// Retro downscale: render the drawing buffer at a fraction of CSS pixels and
// let CSS `image-rendering: pixelated` upscale it for a chunky arcade look.
export const PIXEL_SCALE = 0.5;

export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private container: HTMLElement;
  private scene: THREE.Scene | null = null;
  private clock = new THREE.Clock(false);
  private running = false;
  private rafId = 0;
  private frameCallbacks: Array<(delta: number, time: number) => void> = [];
  private persistent: THREE.Object3D[] = [];
  private onResize: () => void;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(PIXEL_SCALE);
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      70,
      (container.clientWidth || window.innerWidth) / (container.clientHeight || window.innerHeight),
      0.1,
      1000,
    );

    this.onResize = this.handleResize.bind(this);
    window.addEventListener('resize', this.onResize);
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setScene(scene: THREE.Scene): void {
    if (this.scene === scene) return;
    if (this.scene) {
      for (const o of this.persistent) this.scene.remove(o);
    }
    this.scene = scene;
    for (const o of this.persistent) scene.add(o);
  }

  /** Keep an object alive across scene switches (e.g. the player rig). */
  addPersistent(object: THREE.Object3D): void {
    this.persistent.push(object);
    if (this.scene) this.scene.add(object);
  }

  onFrame(callback: (delta: number, time: number) => void): this {
    this.frameCallbacks.push(callback);
    return this;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();

    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      const delta = Math.min(this.clock.getDelta(), 0.1);
      const time = this.clock.elapsedTime;
      for (const cb of this.frameCallbacks) cb(delta, time);
      if (this.scene) this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.clock.stop();
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private handleResize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
