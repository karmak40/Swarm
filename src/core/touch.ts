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
export type TouchButtonId = 'dash' | 'build' | 'pause' | 'startWave' | 'map' | 'confirm';

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
/**
 * How far above the aim point Game draws the placement ghost, in screen px.
 * Must match the lift in `Game.updateInteraction`.
 */
export const GHOST_LIFT = 70;
/** Grab radius around the ghost, in CSS px before UI scale. */
const GHOST_GRAB_R = 44;

interface PointerRec {
  x: number;
  y: number;
  startX: number;
  startY: number;
  t: number;
  /** 'pan': a build-mode touch off the ghost — a drag pans, a tap aims. */
  role: 'stick' | 'button' | 'map' | 'pan' | 'pinch';
  button?: TouchButtonId;
  /** Aim-point offset from the finger while dragging a grabbed ghost. */
  grabX: number;
  grabY: number;
  /** A 'pan' touch that has moved past the tap slop. */
  panning?: boolean;
}
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
  /**
   * Placement needs the ✓ button rather than landing on touch.
   *
   * Set for everything except drag-painted structures (walls): a single
   * mis-tap on an expensive turret is a costly mistake, while a wall line is
   * exactly what the drag is for. Touching the map then only aims the ghost.
   */
  confirmPlacement = false;

  /** A map tap that the game should treat as a click, in screen space. */
  mapTap: { x: number; y: number } | null = null;
  /** A completed long-press on the map, for the context menu. */
  mapLongPress: { x: number; y: number } | null = null;
  /** Continuous placement: true while a finger is held on the map in build mode. */
  mapHeld = false;

  southpaw = false;
  scale = 1;
  /** Safe-area insets from the last layout; read by TouchHud for edge readouts. */
  insets: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

  private w = 0;
  private h = 0;
  private pointers = new Map<number, PointerRec>();
  /** Accumulated build-mode pan drag, in screen px; see consumePan. */
  private panX = 0;
  private panY = 0;
  /** Two-finger zoom: finger spacing last frame, and the pending scale factor. */
  private pinchDist = 0;
  private pinchFactor = 1;
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

    const buildR = Math.round(r * 1.05);
    const startR = Math.round(r * 0.9);
    // Room between stacked circles for the label drawn under each one.
    const labelGap = Math.round(28 * s);

    // Landscape: Build sits inward of Dash along the bottom edge. Portrait:
    // a phone is too narrow for that — at ~360px wide (or a larger UI scale)
    // Build reaches into the movement-stick zone on the other half — so the
    // cluster becomes a column hugging the outer edge instead.
    const column = h > w;
    const buildX = column ? actionX : actionX + dir * (r * 2.6);
    const buildY = column ? baseY - r - buildR - labelGap : baseY;
    // START and ✓ share one slot above Build (never visible together): on a
    // ~375px-wide phone a bottom-centre START lands inside Build's circle.
    const slotY = buildY - buildR - startR - labelGap;

    this.buttons = [
      { id: 'dash', x: actionX, y: baseY, r, tapped: false, held: false, visible: true, enabled: true },
      {
        id: 'build', x: buildX, y: buildY,
        r: buildR, tapped: false, held: false, visible: true, enabled: true,
      },
      {
        id: 'startWave', x: buildX, y: slotY,
        r: startR, tapped: false, held: false, visible: false, enabled: true,
      },
      {
        // Shares START's slot: START is hidden while a placement is pending.
        id: 'confirm', x: buildX, y: slotY,
        r: buildR, tapped: false, held: false, visible: false, enabled: true,
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

  /** A quick, stationary release — a tap rather than a drag or a hold. */
  private isTap(p: PointerRec) {
    return Math.hypot(p.x - p.startX, p.y - p.startY) <= TAP_SLOP && Date.now() - p.t < LONG_PRESS_MS;
  }

  /**
   * True when (x, y) is on the pending placement ghost.
   *
   * `mouseX/Y` is the aim point; Game draws the ghost `GHOST_LIFT` px above
   * it so the finger doesn't cover it. Either spot counts as grabbing it.
   */
  private onGhost(x: number, y: number) {
    const r = GHOST_GRAB_R * this.scale;
    return Math.hypot(x - this.mouseX, y - (this.mouseY - GHOST_LIFT)) <= r
      || Math.hypot(x - this.mouseX, y - this.mouseY) <= r;
  }

  private onDown = (e: PointerEvent) => {
    if (this.uiCaptured) return;
    e.preventDefault();
    const { x, y } = this.local(e);
    const rec = (role: PointerRec['role'], extra: Partial<PointerRec> = {}) => {
      const p: PointerRec = { x, y, startX: x, startY: y, t: Date.now(), role, grabX: 0, grabY: 0, ...extra };
      this.pointers.set(e.pointerId, p);
      return p;
    };

    const btn = this.hitButton(x, y);
    if (btn) {
      btn.tapped = true;
      btn.held = true;
      this.pressedButtons.add(btn.id);
      rec('button', { button: btn.id });
      this.buzz(10);
      return;
    }

    // A second finger on the map turns the pair into a pinch. The first
    // finger's gesture (mining hold, pending tap, long press, pan, ghost drag)
    // is abandoned — two fingers down is never a tap.
    const other = this.mapPointer();
    if (other) {
      clearTimeout(this.longPressTimer);
      this.mapHeld = false;
      other.role = 'pinch';
      rec('pinch');
      this.pinchDist = Math.max(1, Math.hypot(x - other.x, y - other.y));
      return;
    }

    // In build mode the ghost wins over the stick zone: otherwise a ghost
    // sitting in the lower-left half could never be picked up again. The grab
    // keeps the finger's offset, so the ghost moves with it instead of
    // jumping under the fingertip.
    if (this.placing && this.onGhost(x, y)) {
      rec('map', { grabX: this.mouseX - x, grabY: this.mouseY - y });
      this.mapHeld = true;
      return;
    }

    // Not while the build drawer is up: it spans the bottom of the screen, and
    // in portrait its left-hand slots sit inside the stick zone — tapping them
    // summoned the stick instead of picking the structure.
    if (!this.stick.active && !this.drawerOpen && this.inStickZone(x, y)) {
      this.stick.active = true;
      this.stick.pointerId = e.pointerId;
      this.stick.cx = x; this.stick.cy = y;
      this.stick.tx = x; this.stick.ty = y;
      rec('stick');
      return;
    }

    // The resource readout along the very top isn't a button, but a tap there
    // shouldn't mine or place a structure underneath it either.
    if (y < 92 * this.scale + this.insets.top) return;

    // Build mode: a drag off the ghost looks around the map; a tap moves the
    // ghost there (resolved on release, once we know it wasn't a drag).
    if (this.placing) {
      rec('pan');
      return;
    }

    // Anything else is a world interaction.
    rec('map');
    this.mouseX = x;
    this.mouseY = y;
    this.mapHeld = true;
    clearTimeout(this.longPressTimer);
    this.longPressTimer = window.setTimeout(() => {
      const p = this.pointers.get(e.pointerId);
      if (!p || p.role !== 'map' || this.placing) return;
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
    const px = p.x, py = p.y;
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
      this.mouseX = x + p.grabX;
      this.mouseY = y + p.grabY;
    } else if (p.role === 'pinch') {
      const pair = this.pinchPair();
      if (pair) {
        const d = Math.max(1, Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y));
        this.pinchFactor *= d / this.pinchDist;
        this.pinchDist = d;
      }
    } else if (p.role === 'pan') {
      // Hold still until it is clearly a drag, so a slightly wobbly tap
      // doesn't nudge the camera.
      if (!p.panning) {
        if (Math.hypot(x - p.startX, y - p.startY) <= TAP_SLOP) return;
        p.panning = true;
        this.panX += x - p.startX;
        this.panY += y - p.startY;
        return;
      }
      this.panX += x - px;
      this.panY += y - py;
    }
  };

  private onUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);

    if (p.role === 'stick') {
      this.stick.active = false;
      this.stick.pointerId = -1;
      // While placing, a tap in the stick zone still aims — the stick owns
      // that half of the screen, but a structure may need to go there.
      if (this.placing && this.isTap(p)) this.tapAt(p.x, p.y);
      return;
    }
    if (p.role === 'button') {
      const b = this.button(p.button!);
      if (b) b.held = false;
      this.pressedButtons.delete(p.button!);
      return;
    }
    if (p.role === 'pan') {
      if (!p.panning && this.isTap(p)) this.tapAt(p.x, p.y);
      return;
    }
    // Lifting one pinch finger ends the pinch; the one left behind stays a
    // 'pinch' pointer (inert) until it lifts too, so it can't suddenly pan,
    // aim or tap from wherever it happens to be.
    if (p.role === 'pinch') return;

    clearTimeout(this.longPressTimer);
    this.mapHeld = false;
    // A quick, stationary touch is a tap; a drag is a camera-look, not a click.
    if (this.isTap(p)) {
      this.mapTap = { x: p.x, y: p.y };
    }
  };

  /**
   * A build-mode map tap: moves the aim so the ghost lands right where the
   * finger touched (the ghost is drawn GHOST_LIFT above the aim point).
   */
  private tapAt(x: number, y: number) {
    this.mouseX = x;
    this.mouseY = y + GHOST_LIFT;
    this.mapTap = { x, y };
  }

  /** The live single-finger map/pan pointer a second finger would pinch with. */
  private mapPointer(): PointerRec | null {
    for (const p of this.pointers.values()) {
      if (p.role === 'map' || p.role === 'pan') return p;
    }
    return null;
  }

  /** Both fingers of an active pinch, or null once either has lifted. */
  private pinchPair(): [PointerRec, PointerRec] | null {
    const ps: PointerRec[] = [];
    for (const p of this.pointers.values()) if (p.role === 'pinch') ps.push(p);
    return ps.length >= 2 ? [ps[0], ps[1]] : null;
  }

  /** Zoom factor from pinching since the last call (>1 = fingers apart = zoom in). */
  consumePinch() {
    const f = this.pinchFactor;
    this.pinchFactor = 1;
    return f;
  }

  /** Screen-space drag since the last call, for build-mode camera panning. */
  consumePan() {
    const v = { x: this.panX, y: this.panY };
    this.panX = 0;
    this.panY = 0;
    return v;
  }

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
   *
   * Button 2 (mine) mirrors the desktop RMB-hold gesture as a plain map-hold,
   * regardless of `placing` — mining only ever fires in `cursorMode === 'normal'`
   * anyway (checked on the `Game` side), so this can't fire mid-placement.
   */
  mouseDown(button = 0) {
    if (button === 2) return this.mapHeld;
    if (this.placing && this.confirmPlacement) return button === 0 && this.confirmTapped;
    return button === 0 && this.placing && (this.mapHeld || this.mapTap !== null);
  }

  mouseClicked(button = 0) {
    if (this.placing && this.confirmPlacement) return button === 0 && this.confirmTapped;
    return button === 0 && this.mapTap !== null;
  }

  mouseReleased() { return false; }

  private get confirmTapped() {
    return this.button('confirm')?.tapped ?? false;
  }

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
    this.panX = 0;
    this.panY = 0;
    this.pinchFactor = 1;
    for (const b of this.buttons) { b.held = false; b.tapped = false; }
    clearTimeout(this.longPressTimer);
  }
}
