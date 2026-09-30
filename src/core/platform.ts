/**
 * Platform capabilities and render quality tiers.
 *
 * The game ships one build for desktop and touch. Rather than branch on "is
 * mobile" all over the codebase, everything reads the two things that actually
 * matter: is the primary pointer coarse (→ touch controls), and how much GPU
 * budget do we have (→ quality tier).
 */

export type Quality = 'low' | 'medium' | 'high';

export interface QualityProfile {
  /** Upper bound on devicePixelRatio. The single biggest perf lever. */
  maxDpr: number;
  /** 0 = off, 1 = single blur pass, 2 = the full two-pass bloom. */
  bloomPasses: number;
  /** Multiplier on emitted particle counts. */
  particleDensity: number;
  /** Resolution scale of the offscreen glow buffer. */
  glowScale: number;
  /** Skip the scanline overlay — a full-screen fill per frame. */
  scanlines: boolean;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { maxDpr: 1, bloomPasses: 0, particleDensity: 0.45, glowScale: 0.25, scanlines: false },
  medium: { maxDpr: 1.5, bloomPasses: 1, particleDensity: 0.7, glowScale: 0.3, scanlines: false },
  high: { maxDpr: 2, bloomPasses: 2, particleDensity: 1, glowScale: 0.34, scanlines: true },
};

/** True when the primary input is a finger rather than a mouse. */
export function detectCoarsePointer(): boolean {
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true;
  // Fall back to touch-point count: some Android browsers misreport the media query.
  return (navigator.maxTouchPoints ?? 0) > 0 && !matchMedia('(pointer: fine)').matches;
}

/**
 * Best-guess starting quality. Deliberately conservative on touch: dropping
 * frames on the first wave is a far worse first impression than soft bloom.
 */
export function detectQuality(): Quality {
  const coarse = detectCoarsePointer();
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 0;

  if (coarse) {
    // A short side under 400 CSS px is a phone; anything bigger is a tablet.
    const shortSide = Math.min(window.innerWidth, window.innerHeight);
    if (cores <= 4 || shortSide < 380) return 'low';
    return 'medium';
  }
  if (cores <= 2 || mem === 1) return 'low';
  return 'high';
}

export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

export function isPortrait(): boolean {
  return window.innerHeight > window.innerWidth;
}

/**
 * Short side, in CSS px, from which a touch screen is a tablet. Phones top
 * out around 430 (even big ones in landscape); tablets start around 600.
 */
export const TABLET_SHORT_SIDE = 600;

/**
 * The window has room to play in landscape. Phones are portrait-only — a
 * ~390px-tall landscape view leaves no room for the HUD and both thumbs —
 * but a tablet's landscape is its natural way up. Window-based, so an iPad
 * in narrow split view is treated like the phone-sized window it is.
 */
export function allowsLandscape(): boolean {
  return Math.min(window.innerWidth, window.innerHeight) >= TABLET_SHORT_SIDE;
}

/**
 * Extra interface scale for the screen size, on top of the player's own
 * setting. The touch HUD is authored for a ~390px-wide phone; on a tablet it
 * came out phone-sized — technically fine, but tiny at arm's length. Grows
 * with the window's short side from the tablet threshold, capped so a big
 * tablet doesn't get cartoonish controls. Window-based, like allowsLandscape.
 */
export function deviceUiScale(): number {
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  if (shortSide < TABLET_SHORT_SIDE) return 1;
  return Math.min(1.35, shortSide / TABLET_SHORT_SIDE);
}

/**
 * The device itself is tablet-sized. Screen-based rather than window-based,
 * for the OS orientation lock, which must not flip as split view resizes us.
 */
export function isTabletDevice(): boolean {
  if (typeof screen === 'undefined') return false;
  return Math.min(screen.width, screen.height) >= TABLET_SHORT_SIDE;
}

export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO_INSETS: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
let insetProbe: HTMLDivElement | null = null;

/**
 * `env(safe-area-inset-*)` in CSS px, for the notch/Dynamic Island/home-indicator
 * a native shell (Capacitor iOS/Android) draws under. The canvas HUD is drawn by
 * hand, so unlike DOM chrome it cannot lean on `env()` in a stylesheet — this
 * reads the same values into JS via a hidden probe element so corner-anchored
 * readouts (top bar, minimap, touch buttons) can offset away from the cutout.
 * In landscape the notch sits on a *side*, so this is a left/right concern as
 * often as top/bottom.
 */
export function readSafeAreaInsets(): SafeInsets {
  if (typeof document === 'undefined') return ZERO_INSETS;
  if (!insetProbe) {
    insetProbe = document.createElement('div');
    insetProbe.style.cssText =
      'position:fixed;inset:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) ' +
      'env(safe-area-inset-bottom) env(safe-area-inset-left);';
    document.body.appendChild(insetProbe);
  }
  const cs = getComputedStyle(insetProbe);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}
