import { App } from '@capacitor/app';
import { StatusBar } from '@capacitor/status-bar';
import { ScreenOrientation } from '@capacitor/screen-orientation';

/**
 * Chrome-level concerns (fullscreen, orientation lock, the Android back
 * button) routed through Capacitor's plugin API instead of raw web APIs.
 *
 * Every plugin here ships a web implementation that either no-ops or falls
 * back to the matching browser API outside a native shell, so call sites
 * never need to branch on platform themselves — this file is the only place
 * that does.
 */

/** Hides the native status bar for full-screen immersion. No-op on web. */
export async function hideStatusBar() {
  try { await StatusBar.hide(); } catch { /* not supported on this platform */ }
}

/** Locks to landscape. Backed by the Screen Orientation Web API on the web. */
export async function lockLandscape() {
  try { await ScreenOrientation.lock({ orientation: 'landscape' }); } catch { /* denied or unsupported */ }
}

/**
 * Registers the Android hardware/gesture back button.
 * Never fires on web or iOS — neither has an equivalent event.
 */
export function onBackButton(handler: () => void) {
  void App.addListener('backButton', handler);
}

/** Backgrounds the app the way the OS back gesture normally would. No-op on web. */
export function minimizeApp() {
  App.minimizeApp().catch(() => { /* nothing to minimize outside a native shell */ });
}
