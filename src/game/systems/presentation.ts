import { audio } from '../../core/audio';
import type { InputSource } from '../../core/input';
import { clamp, damp, rand } from '../../core/math';
import type { DamageNumber, Effect } from '../entities';
import type { Banner, Camera, Game } from '../game';
import { TILE } from '../world';

/** Tiles visible across the short side of the screen on touch. */
const TOUCH_VIEW_TILES = 24;
/** Floor for the fitted zoom — below this, bugs shrink to a few pixels. */
const TOUCH_MIN_ZOOM = 0.42;
/** Pinch range relative to the fitted zoom: ~40 tiles out, ~12 tiles in. */
const PINCH_MIN = 0.6;
const PINCH_MAX = 2;

/**
 * Camera, screen-shake/flash, banners/toasts, damage numbers, and the
 * hitstop/time-scale "feel" layer. Pure presentation: nothing here affects
 * simulation outcomes, so the renderer/HUD can read it at any time.
 */
export class PresentationSystem {
  camera: Camera = { x: 0, y: 0, zoom: 1, shake: 0, shakeX: 0, shakeY: 0 };
  flash = { r: 0, g: 0, b: 0, a: 0 };
  banner: Banner | null = null;
  timeScale = 1;
  hitstop = 0;
  elapsed = 0;
  readonly effects: Effect[] = [];
  readonly damageNumbers: DamageNumber[] = [];
  lastError = { text: '', life: 0 };

  /** Touch build-mode camera offset from the player, in world px. */
  readonly pan = { x: 0, y: 0 };

  private viewportW = 1280;
  private viewportH = 720;

  constructor(private game: Game) {}

  get viewport() { return { w: this.viewportW, h: this.viewportH }; }

  /**
   * Zoom that fits `TOUCH_VIEW_TILES` across the screen's short side.
   *
   * A phone in portrait is ~390 CSS px wide — at zoom 1 that is ~12 tiles,
   * while turrets reach 190–620 px and the player's auto-aim 430 px, so most
   * of the fight happened off-screen. Desktop keeps its wheel-driven zoom.
   */
  get touchZoom() {
    return Math.max(this.fitZoom * this.touchZoomMul, this.mapFillZoom);
  }

  /** The default touch zoom, before any pinch. */
  private get fitZoom() {
    const shortSide = Math.min(this.viewportW, this.viewportH);
    return clamp(shortSide / (TOUCH_VIEW_TILES * TILE), TOUCH_MIN_ZOOM, 1);
  }

  /**
   * Smallest zoom at which the map still covers the whole screen. Zooming out
   * past it only adds empty space beyond the map edge (in portrait, bands
   * above and below it) and nothing more of the map, so pinch stops here.
   */
  private get mapFillZoom() {
    const world = this.game.world;
    if (!world) return 0;
    return Math.max(this.viewportW / world.pxW, this.viewportH / world.pxH);
  }

  /**
   * Player pinch on top of the fitted zoom. Relative to the fit so it means
   * the same on every screen; kept across runs for the session, since how far
   * out someone likes to play doesn't change between sectors.
   */
  private touchZoomMul = 1;

  /** Applies a pinch factor. Immediate — the view tracks the fingers. */
  zoomBy(factor: number) {
    // Floor the multiplier at the map-fill zoom too, so pinching past the
    // edge doesn't bank a deficit the player has to pinch back through
    // before anything moves.
    const lo = Math.max(PINCH_MIN, this.mapFillZoom / this.fitZoom);
    this.touchZoomMul = clamp(this.touchZoomMul * factor, lo, Math.max(PINCH_MAX, lo));
    this.camera.zoom = this.touchZoom;
  }

  setViewport(w: number, h: number) {
    this.viewportW = w;
    this.viewportH = h;
  }

  /** Called once from `startLevel`: snaps the camera to the new core and clears feel state left over from the previous run. */
  reset() {
    const core = this.game.core;
    this.camera.x = core.x;
    this.camera.y = core.y;
    this.camera.zoom = this.game.touchUi ? this.touchZoom : 1;
    this.camera.shake = 0;
    this.pan.x = 0;
    this.pan.y = 0;
    this.camera.shakeX = 0;
    this.camera.shakeY = 0;
    this.flash = { r: 0, g: 0, b: 0, a: 0 };
    this.banner = null;
    this.lastError = { text: '', life: 0 };
    this.timeScale = 1;
    this.hitstop = 0;
    this.elapsed = 0;
    this.effects.length = 0;
    this.damageNumbers.length = 0;
  }

  setBanner(title: string, sub: string, life = 3, color = '#46d8ff') {
    this.banner = { title, sub, life, maxLife: life, color };
  }

  error(text: string) {
    this.lastError = { text, life: 1.6 };
    audio.play('error');
  }

  /** Hitstop: a few frames of near-freeze sells big impacts. */
  advanceTimeScale(rawDt: number) {
    if (this.hitstop > 0) {
      this.hitstop -= rawDt;
      this.timeScale = damp(this.timeScale, 0.08, 22, rawDt);
    } else {
      this.timeScale = damp(this.timeScale, 1, 9, rawDt);
    }
  }

  updateBanner(dt: number) {
    if (this.banner) {
      this.banner.life -= dt;
      if (this.banner.life <= 0) this.banner = null;
    }
    if (this.lastError.life > 0) this.lastError.life -= dt;
    this.flash.a = Math.max(0, this.flash.a - dt * 3.4);
  }

  updateEffects(dt: number) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= dt;
      if (e.life <= 0) this.effects.splice(i, 1);
    }
  }

  spawnDamageNumber(x: number, y: number, value: number, crit: boolean, color: number) {
    if (this.damageNumbers.length > 90) this.damageNumbers.shift();
    this.damageNumbers.push({
      x: x + rand(-6, 6), y, vy: -46, life: 0.75, value, crit, color,
    });
  }

  updateDamageNumbers(dt: number) {
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const d = this.damageNumbers[i];
      d.life -= dt;
      d.y += d.vy * dt;
      d.vy += 60 * dt;
      if (d.life <= 0) this.damageNumbers.splice(i, 1);
    }
  }

  /**
   * Touch build-mode pan: moves the camera 1:1 with the finger (the camera
   * itself shifts too, not only its target, so the map doesn't lag behind).
   */
  panBy(dx: number, dy: number) {
    this.pan.x += dx;
    this.pan.y += dy;
    this.camera.x += dx;
    this.camera.y += dy;
  }

  updateCamera(dt: number, input: InputSource) {
    const g = this.game;
    const cam = this.camera;
    const p = g.player;

    // Touch has no wheel: track the fitted zoom so rotation and a controls
    // switch mid-run settle smoothly instead of snapping.
    if (g.touchUi) cam.zoom = damp(cam.zoom, this.touchZoom, 6, dt);
    const halfW = this.viewportW / (2 * cam.zoom);
    const halfH = this.viewportH / (2 * cam.zoom);

    let lookX = 0, lookY = 0;
    if (g.touchUi) {
      // Touch "cursor" is just wherever the last tap landed, so a cursor
      // bias would leave the view stuck off-centre. Instead the view can be
      // panned while building, and eases back to the player afterwards.
      if (!g.buildCamHold) {
        this.pan.x = damp(this.pan.x, 0, 4, dt);
        this.pan.y = damp(this.pan.y, 0, 4, dt);
      }
      // Never pan past the map edge — a drag back would otherwise have to
      // unwind a dead zone before the view moved at all.
      this.pan.x = g.world.pxW > halfW * 2 ? clamp(p.x + this.pan.x, halfW, g.world.pxW - halfW) - p.x : 0;
      this.pan.y = g.world.pxH > halfH * 2 ? clamp(p.y + this.pan.y, halfH, g.world.pxH - halfH) - p.y : 0;
    } else {
      // Bias the camera toward the cursor so you can see what you're shooting.
      lookX = clamp((g.mouseWorldX - p.x) * 0.22, -190, 190);
      lookY = clamp((g.mouseWorldY - p.y) * 0.22, -190, 190);
    }
    const tx = p.x + lookX + this.pan.x;
    const ty = p.y + lookY + this.pan.y;

    cam.x = damp(cam.x, tx, 7, dt);
    cam.y = damp(cam.y, ty, 7, dt);

    if (g.world.pxW > halfW * 2) cam.x = clamp(cam.x, halfW, g.world.pxW - halfW);
    else cam.x = g.world.pxW / 2;
    if (g.world.pxH > halfH * 2) cam.y = clamp(cam.y, halfH, g.world.pxH - halfH);
    else cam.y = g.world.pxH / 2;

    const amp = cam.shake * g.progress.data.settings.screenShake;
    cam.shakeX = rand(-amp, amp);
    cam.shakeY = rand(-amp, amp);
    cam.shake = damp(cam.shake, 0, 8, dt);
    void input;
  }

  shake(amount: number) {
    this.camera.shake = Math.min(34, this.camera.shake + amount);
  }

  addFlash(r: number, g: number, b: number, a: number) {
    if (a <= this.flash.a) return;
    this.flash = { r, g, b, a };
  }

  updateAudioMix(dt: number) {
    const g = this.game;
    let intensity = 0;
    if (g.phase === 'combat' || g.phase === 'incoming') {
      const threat = Math.min(1, g.enemies.length / 40);
      const waveT = g.waveIndex / Math.max(1, g.level.waves - 1);
      intensity = 0.35 + threat * 0.35 + waveT * 0.2;
    } else if (g.phase === 'boss') {
      intensity = 1;
    } else if (g.phase === 'prep' || g.phase === 'cleared') {
      intensity = 0.1;
    }
    if (g.core.pct < 0.35) intensity = Math.max(intensity, 0.85);
    audio.setIntensity(intensity);
    audio.update(dt);
  }
}
