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

  /**
   * Gamepad support merges straight into the same keyboard/mouse state a
   * real keydown or pointerdown would produce, so every consumer (movement,
   * fire, mine, dash) works unmodified — see `pollGamepad`. There's no manual
   * aim stick: `Game.autoAim` (already used by touch) takes over instead, see
   * `gamepadActive` and its use in main.ts.
   */
  private static readonly GAMEPAD_DEADZONE = 0.22;
  /** True once any button/stick has actually moved — distinguishes "connected" from "in use". */
  gamepadActive = false;
  private gpAxisX = 0;
  private gpAxisY = 0;
  private gpFireHeld = false;
  private gpMineHeld = false;
  private gpDashHeld = false;
  private gpStartHeld = false;
  /** Edge-triggered like `pressed()`; Start has no keyboard equivalent to piggyback on. */
  gamepadStartPressed = false;

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
    this.gamepadActive = false;
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
    this.gamepadActive = false;
  };

  private onDown = (e: PointerEvent) => {
    const bit = 1 << e.button;
    this.buttons |= bit;
    this.justClicked |= bit;
    this.gamepadActive = false;
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

  /** Any of WASD / arrows, or the gamepad's left stick — normalised to unit length. */
  axis(): { x: number; y: number } {
    if (this.gpAxisX || this.gpAxisY) return { x: this.gpAxisX, y: this.gpAxisY };
    let x = 0, y = 0;
    if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
    if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
    if (this.down('KeyW') || this.down('ArrowUp')) y -= 1;
    if (this.down('KeyS') || this.down('ArrowDown')) y += 1;
    if (x && y) { const k = Math.SQRT1_2; x *= k; y *= k; }
    return { x, y };
  }

  /**
   * Merges a connected gamepad's state into the same fields a real keyboard/
   * mouse event would set, so every consumer downstream keeps working
   * unmodified. Standard mapping: left stick moves, RT/A fires, LT/X mines,
   * RB/B dashes, Start pauses. There is no bound action for manual aim —
   * see the class doc — `Game.autoAim` covers it via `gamepadActive`.
   * Call once per frame, before the frame's input is read.
   */
  pollGamepad() {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : null;
    const gp = pads ? [...pads].find((p): p is Gamepad => !!p) : undefined;
    if (!gp) {
      this.gpAxisX = 0; this.gpAxisY = 0;
      this.setGamepadFire(false);
      this.setGamepadMine(false);
      this.setGamepadDash(false);
      this.gpStartHeld = false;
      return;
    }

    const held = (i: number) => {
      const b = gp.buttons[i];
      return !!b && (b.pressed || b.value > 0.5);
    };

    const lx = gp.axes[0] ?? 0, ly = gp.axes[1] ?? 0;
    const mag = Math.hypot(lx, ly);
    const active = mag > Input.GAMEPAD_DEADZONE;
    this.gpAxisX = active ? lx : 0;
    this.gpAxisY = active ? ly : 0;

    const fire = held(7) || held(0);
    const mine = held(6) || held(2);
    const dash = held(5) || held(1);
    const start = held(9);

    this.setGamepadFire(fire);
    this.setGamepadMine(mine);
    this.setGamepadDash(dash);
    if (start && !this.gpStartHeld) this.gamepadStartPressed = true;
    this.gpStartHeld = start;

    if (active || fire || mine || dash || start) this.gamepadActive = true;
  }

  private setGamepadFire(down: boolean) {
    if (down === this.gpFireHeld) return;
    this.gpFireHeld = down;
    const bit = 1;
    if (down) { this.buttons |= bit; this.justClicked |= bit; }
    else { this.buttons &= ~bit; this.justReleased |= bit; }
  }

  private setGamepadMine(down: boolean) {
    if (down === this.gpMineHeld) return;
    this.gpMineHeld = down;
    const bit = 1 << 2;
    if (down) { this.buttons |= bit; this.justClicked |= bit; }
    else { this.buttons &= ~bit; this.justReleased |= bit; }
  }

  private setGamepadDash(down: boolean) {
    if (down === this.gpDashHeld) return;
    this.gpDashHeld = down;
    if (down) { this.held.add('ShiftLeft'); this.justDown.add('ShiftLeft'); }
    else { this.held.delete('ShiftLeft'); this.justUp.add('ShiftLeft'); }
  }

  endFrame() {
    this.justDown.clear();
    this.justUp.clear();
    this.justClicked = 0;
    this.justReleased = 0;
    this.wheel = 0;
    this.gamepadStartPressed = false;
  }
}
