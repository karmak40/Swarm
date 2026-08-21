import type { InputSource } from './input';
import type { SafeInsets } from './platform';

/**
 * On-screen controls for coarse pointers.
 *
 * Implements the same `InputSource` the keyboard reader does, so the simulation
 * is unaware of it. The scheme deliberately does not try to reproduce a
 * twin-stick layout on glass: aiming and mining are automated (see
 * `Game.autoAim` / `autoMine`), which frees the right thumb for the things that
 * genuinely need a decision — dashing, building and starting the wave early.
 *
 * Widget geometry is recomputed on resize and hit-tested here, so the drawing
 * code in `touchHud.ts` and this file share one source of truth.
 */

/**
 * Note there is no 'sell' button. Selling is done by long-pressing the structure
 * itself, which is more precise than a global mode — and a third circle does not
 * fit around the action corner on a 375px-tall screen without overlapping.
 */
export type TouchButtonId = 'dash' | 'build' | 'pause' | 'startWave' | 'map';

export interface TouchButton {
  id: TouchButtonId;
  x: number;
  y: number;
  r: number;
  /** Pressed this frame — edge triggered, consumed by endFrame. */
  tapped: boolean;
  held: boolean;
  visible: boolean;
  enabled: boolean;
}

interface Stick {
  /** Centre of the stick, set where the thumb lands. */
  cx: number;
  cy: number;
  /** Current thumb position. */
  tx: number;
  ty: number;
  active: boolean;
  pointerId: number;
  radius: number;
}

/** Where the movement stick may be summoned from. */
const STICK_ZONE_FRACTION = 0.42;
const LONG_PRESS_MS = 420;
const TAP_SLOP = 14;

export class TouchInput implements InputSource {
  uiCaptured = false;
  /** World-space cursor equivalent: the last map point the player touched. */
  mouseX = 0;
  mouseY = 0;
  wheel = 0;

  /** Layout, in CSS pixels. Rebuilt by `layout()`. */
  buttons: TouchButton[] = [];
  stick: Stick = { cx: 0, cy: 0, tx: 0, ty: 0, active: false, pointerId: -1, radius: 74 };

  /**
   * Set while the build drawer is open.
   *
   * The drawer covers the bottom of the screen, which is where the action cluster
   * lives, so those buttons are hidden while it is up — otherwise they stay
   * tappable underneath it and the player hits Dash aiming for a turret.
   */
  drawerOpen = false;
  /** Non-null while a structure is selected and awaiting placement. */
  placing = false;

  /** A map tap that the game should treat as a click, in screen space. */
  mapTap: { x: number; y: number } | null = null;
  /** A completed long-press on the map, for the context menu. */
  mapLongPress: { x: number; y: number } | null = null;
  /** Continuous placement: true while a finger is held on the map in build mode. */
  mapHeld = false;

  southpaw = false;
  scale = 1;
  private insets: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  private w = 0;
  private h = 0;
  private pointers = new Map<number, { x: number; y: number; startX: number; startY: number; t: number; role: 'stick' | 'button' | 'map'; button?: TouchButtonId }>();
  private pressedButtons = new Set<TouchButtonId>();
  private longPressTimer: number | undefined;
  private el: HTMLElement;
  private hapticsOn = true;

  constructor(el: HTMLElement) {
    this.el = el;
    el.addEventListener('pointerdown', this.onDown, { passive: false });
    el.addEventListener('pointermove', this.onMove, { passive: false });
    addEventListener('pointerup', this.onUp);
    addEventListener('pointercancel', this.onUp);
    // Suppress the browser's own gestures so drags do not scroll or zoom the page.
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setHaptics(on: boolean) { this.hapticsOn = on; }

  private buzz(ms = 12) {
    if (!this.hapticsOn) return;
    try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
  }

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                  */
  /* ---------------------------------------------------------------------- */

  layout(w: number, h: number, opts: { southpaw?: boolean; scale?: number; insets?: SafeInsets } = {}) {
    this.w = w;
    this.h = h;
    this.southpaw = opts.southpaw ?? this.southpaw;
    this.scale = opts.scale ?? this.scale;
    const insets = opts.insets ?? this.insets;
    this.insets = insets;

    const s = this.scale;
    const r = Math.round(34 * s);
    const pad = Math.round(26 * s);
    // Action cluster sits opposite the movement thumb. In landscape the
    // notch/Dynamic Island lands on a side, so whichever edge the cluster
    // hugs needs that side's inset, not just the bottom's.
    const actionX = this.southpaw ? pad + r + insets.left : w - pad - r - insets.right;
    const dir = this.southpaw ? 1 : -1;
    const baseY = h - pad - r - insets.bottom;

    this.stick.radius = Math.round(74 * s);

    this.buttons = [
      { id: 'dash', x: actionX, y: baseY, r, tapped: false, held: false, visible: true, enabled: true },
      {
        // Inward along the bottom edge. Spacing is set so the two circles clear
        // each other and neither reaches the minimap above.
        id: 'build', x: actionX + dir * (r * 2.6), y: baseY,
        r: Math.round(r * 1.05), tapped: false, held: false, visible: true, enabled: true,
      },
      {
        // Lifted a full radius off the bottom edge so it is never clipped.
        id: 'startWave', x: w / 2, y: h - Math.round(40 * s) - insets.bottom,
        r: Math.round(r * 0.9), tapped: false, held: false, visible: false, enabled: true,
      },
      {
        id: 'pause', x: w - Math.round(30 * s) - insets.right, y: Math.round(30 * s) + insets.top,
        r: Math.round(22 * s), tapped: false, held: false, visible: true, enabled: true,
      },
      {
        id: 'map', x: w - Math.round(30 * s) - insets.right, y: Math.round(78 * s) + insets.top,
        r: Math.round(22 * s), tapped: false, held: false, visible: true, enabled: true,
      },
    ];
  }

  button(id: TouchButtonId) {
    return this.buttons.find((b) => b.id === id);
  }

  setVisible(id: TouchButtonId, visible: boolean) {
    const b = this.button(id);
    if (b) b.visible = visible;
  }

  /* ---------------------------------------------------------------------- */
  /* Pointer handling                                                        */
  /* ---------------------------------------------------------------------- */

  private local(e: PointerEvent) {
    const rect = this.el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private hitButton(x: number, y: number): TouchButton | null {
    // Generous hit radius: the drawn circle is the target's centre, not its edge.
    for (const b of this.buttons) {
      if (!b.visible || !b.enabled) continue;
      const grow = b.r * 1.35;
      if ((x - b.x) ** 2 + (y - b.y) ** 2 <= grow * grow) return b;
    }
    return null;
  }

  private inStickZone(x: number, y: number) {
    const zoneW = this.w * STICK_ZONE_FRACTION;
    const inX = this.southpaw ? x > this.w - zoneW : x < zoneW;
    return inX && y > this.h * 0.32;
  }

  private onDown = (e: PointerEvent) => {
    if (this.uiCaptured) return;
    e.preventDefault();
    const { x, y } = this.local(e);

    const btn = this.hitButton(x, y);
    if (btn) {
      btn.tapped = true;
      btn.held = true;
      this.pressedButtons.add(btn.id);
      this.pointers.set(e.pointerId, { x, y, startX: x, startY: y, t: Date.now(), role: 'button', button: btn.id });
      this.buzz(10);
      return;
    }

    if (!this.stick.active && this.inStickZone(x, y)) {
      this.stick.active = true;
      this.stick.pointerId = e.pointerId;
      this.stick.cx = x; this.stick.cy = y;
      this.stick.tx = x; this.stick.ty = y;
      this.pointers.set(e.pointerId, { x, y, startX: x, startY: y, t: Date.now(), role: 'stick' });
      return;
    }

    // The resource readout along the very top isn't a button, but a tap there
    // shouldn't mine or place a structure underneath it either.
    if (y < 92 * this.scale) return;

    // Anything else is a world interaction.
    this.pointers.set(e.pointerId, { x, y, startX: x, startY: y, t: Date.now(), role: 'map' });
    this.mouseX = x;
    this.mouseY = y;
    this.mapHeld = true;
    clearTimeout(this.longPressTimer);
    this.longPressTimer = window.setTimeout(() => {
      const p = this.pointers.get(e.pointerId);
      if (!p || p.role !== 'map') return;
      // Only a stationary finger counts as a long press.
      if (Math.abs(p.x - p.startX) > TAP_SLOP || Math.abs(p.y - p.startY) > TAP_SLOP) return;
      this.mapLongPress = { x: p.x, y: p.y };
      this.buzz(22);
    }, LONG_PRESS_MS);
  };

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const { x, y } = this.local(e);
    p.x = x; p.y = y;

    if (p.role === 'stick') {
      this.stick.tx = x;
      this.stick.ty = y;
      // Drag the origin along once the thumb exceeds the ring, so the stick
      // never runs out of travel mid-sprint.
      const dx = x - this.stick.cx;
      const dy = y - this.stick.cy;
      const d = Math.hypot(dx, dy);
      const R = this.stick.radius;
      if (d > R) {
        this.stick.cx += (dx / d) * (d - R);
        this.stick.cy += (dy / d) * (d - R);
      }
    } else if (p.role === 'map') {
      this.mouseX = x;
      this.mouseY = y;
    }
  };

  private onUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);

    if (p.role === 'stick') {
      this.stick.active = false;
      this.stick.pointerId = -1;
      return;
    }
    if (p.role === 'button') {
      const b = this.button(p.button!);
      if (b) b.held = false;
      this.pressedButtons.delete(p.button!);
      return;
    }

    clearTimeout(this.longPressTimer);
    this.mapHeld = false;
    const moved = Math.hypot(p.x - p.startX, p.y - p.startY);
    const heldMs = Date.now() - p.t;
    // A quick, stationary touch is a tap; a drag is a camera-look, not a click.
    if (moved <= TAP_SLOP && heldMs < LONG_PRESS_MS) {
      this.mapTap = { x: p.x, y: p.y };
    }
  };

  /* ---------------------------------------------------------------------- */
  /* InputSource                                                             */
  /* ---------------------------------------------------------------------- */

  axis() {
    if (!this.stick.active) return { x: 0, y: 0 };
    const dx = this.stick.tx - this.stick.cx;
    const dy = this.stick.ty - this.stick.cy;
    const d = Math.hypot(dx, dy);
    if (d < 6) return { x: 0, y: 0 };          // small dead zone
    const R = this.stick.radius;
    const mag = Math.min(1, d / R);
    return { x: (dx / d) * mag, y: (dy / d) * mag };
  }

  /** Keyboard queries map onto the on-screen buttons where they overlap. */
  down(code: string) {
    if (code === 'ShiftLeft') return this.button('dash')?.held ?? false;
    return false;
  }

  pressed(code: string) {
    if (code === 'ShiftLeft') return this.button('dash')?.tapped ?? false;
    if (code === 'Space') return this.button('startWave')?.tapped ?? false;
    return false;
  }

  released() { return false; }

  /**
   * Placement taps are surfaced as left clicks so the build system is unchanged.
   *
   * A pending tap counts as held: the finger is already up by the time the game
   * polls, and requiring a live contact would make quick taps place nothing while
   * only slow drags worked.
   */
  mouseDown(button = 0) {
    return button === 0 && this.placing && (this.mapHeld || this.mapTap !== null);
  }

  mouseClicked(button = 0) {
    return button === 0 && this.mapTap !== null;
  }

  mouseReleased() { return false; }

  /** True for one frame after a long press, for the structure context menu. */
  consumeLongPress() {
    const v = this.mapLongPress;
    this.mapLongPress = null;
    return v;
  }

  consumeTap() {
    const v = this.mapTap;
    this.mapTap = null;
    return v;
  }

  endFrame() {
    for (const b of this.buttons) b.tapped = false;
    this.mapTap = null;
    this.wheel = 0;
  }

  /** Drops all state — used when a modal opens so nothing is left stuck down. */
  reset() {
    this.pointers.clear();
    this.pressedButtons.clear();
    this.stick.active = false;
    this.mapHeld = false;
    this.mapTap = null;
    this.mapLongPress = null;
    for (const b of this.buttons) { b.held = false; b.tapped = false; }
    clearTimeout(this.longPressTimer);
  }
}
