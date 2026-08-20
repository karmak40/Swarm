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
