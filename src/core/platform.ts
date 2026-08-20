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

/** Landscape is effectively required: the HUD needs the horizontal room. */
export function isPortrait(): boolean {
  return window.innerHeight > window.innerWidth;
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
