/**
 * Chrome-level concerns (fullscreen, orientation lock, the Android back
 * button) routed through Capacitor's plugin API instead of raw web APIs.
 *
 * Every plugin here ships a web implementation that either no-ops or falls
 * back to the matching browser API outside a native shell, so call sites
 * never need to branch on platform themselves — this file is the only place
 * that does.
 *
 * Imports are dynamic and each wrapped in its own try/catch. These plugins
 * are enhancements the game runs fine without; a static top-level import
 * would run as part of evaluating this module, before any try/catch of ours
 * gets a chance to run, so a single misbehaving plugin on some browser could
 * silently abort every statement after it in main.ts — the boot screen, the
 * render loop, all of it. A dynamic import turns that into an ordinary
 * rejected promise we already catch.
 */

/** Hides the native status bar for full-screen immersion. No-op on web. */
export async function hideStatusBar() {
  try {
    const { StatusBar } = await import('@capacitor/status-bar');
    await StatusBar.hide();
  } catch { /* not supported on this platform */ }
}

/**
 * Locks orientation. Backed by the Screen Orientation Web API on the web.
 * Currently 'portrait' for the layout experiment — was 'landscape'; flip
 * this one string back to revert (matches AndroidManifest.xml's
 * screenOrientation and Info.plist's UISupportedInterfaceOrientations).
 */
export async function lockOrientation() {
  try {
    const { ScreenOrientation } = await import('@capacitor/screen-orientation');
    await ScreenOrientation.lock({ orientation: 'portrait' });
  } catch { /* denied or unsupported */ }
}

/**
 * Registers the Android hardware/gesture back button.
 * Never fires on web or iOS — neither has an equivalent event.
 */
export async function onBackButton(handler: () => void) {
  try {
    const { App } = await import('@capacitor/app');
    void App.addListener('backButton', handler);
  } catch { /* no native bridge for this plugin on this platform */ }
}

/** Backgrounds the app the way the OS back gesture normally would. No-op on web. */
export async function minimizeApp() {
  try {
    const { App } = await import('@capacitor/app');
    await App.minimizeApp();
  } catch { /* nothing to minimize outside a native shell */ }
}
