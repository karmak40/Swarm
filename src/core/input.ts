/**
 * The surface the simulation consumes.
 *
 * Both the desktop keyboard/mouse reader and the on-screen touch controls
 * implement this, so `Game` never learns which one is driving it.
 */
export interface InputSource {
  /** Set while a modal overlay owns the pointer, so the world ignores input. */
  uiCaptured: boolean;
  mouseX: number;
  mouseY: number;
  wheel: number;
  down(code: string): boolean;
  pressed(code: string): boolean;
  released(code: string): boolean;
  mouseDown(button?: number): boolean;
  mouseClicked(button?: number): boolean;
  mouseReleased(button?: number): boolean;
  /** Movement intent, already normalised to at most unit length. */
  axis(): { x: number; y: number };
  endFrame(): void;
}

/**
 * Keyboard + pointer state.
 *
 * Two flavours of query: `down()` is level-triggered (held), `pressed()` is
 * edge-triggered and consumed once per frame via `endFrame()`. Systems that
 * react to a tap use `pressed`; movement uses `down`.
 */
export class Input implements InputSource {
  readonly held = new Set<string>();
  private justDown = new Set<string>();
  private justUp = new Set<string>();

  mouseX = 0;
  mouseY = 0;
  wheel = 0;
  /** Bitfield of held mouse buttons: 1 = left, 2 = right, 4 = middle. */
  buttons = 0;
  private justClicked = 0;
  private justReleased = 0;

  /** Set while any modal DOM overlay owns the pointer, so the world ignores clicks. */
  uiCaptured = false;

  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    addEventListener('keydown', this.onKeyDown, { passive: false });
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.reset);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerdown', this.onDown);
    addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Let the browser keep refresh / devtools / fullscreen.
    if (e.key === 'F5' || e.key === 'F11' || e.key === 'F12') return;
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (e.repeat) return;
    this.held.add(e.code);
    this.justDown.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.held.delete(e.code);
    this.justUp.add(e.code);
  };

  private onMove = (e: PointerEvent) => {
    const r = this.el.getBoundingClientRect();
    this.mouseX = e.clientX - r.left;
    this.mouseY = e.clientY - r.top;
  };

  private onDown = (e: PointerEvent) => {
    const bit = 1 << e.button;
    this.buttons |= bit;
    this.justClicked |= bit;
  };

  private onUp = (e: PointerEvent) => {
    const bit = 1 << e.button;
    this.buttons &= ~bit;
    this.justReleased |= bit;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.wheel += Math.sign(e.deltaY);
  };

  private reset = () => {
    this.held.clear();
    this.buttons = 0;
  };

  down(code: string) { return this.held.has(code); }
  pressed(code: string) { return this.justDown.has(code); }
  released(code: string) { return this.justUp.has(code); }

  /** button: 0 left, 1 middle, 2 right — matching PointerEvent.button. */
  mouseDown(button = 0) { return (this.buttons & (1 << button)) !== 0; }
  mouseClicked(button = 0) { return (this.justClicked & (1 << button)) !== 0; }
  mouseReleased(button = 0) { return (this.justReleased & (1 << button)) !== 0; }

  /** Any of WASD / arrows, normalised to unit length. */
  axis(): { x: number; y: number } {
    let x = 0, y = 0;
    if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
    if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
    if (this.down('KeyW') || this.down('ArrowUp')) y -= 1;
    if (this.down('KeyS') || this.down('ArrowDown')) y += 1;
    if (x && y) { const k = Math.SQRT1_2; x *= k; y *= k; }
    return { x, y };
  }

  endFrame() {
    this.justDown.clear();
    this.justUp.clear();
    this.justClicked = 0;
    this.justReleased = 0;
    this.wheel = 0;
  }
}
