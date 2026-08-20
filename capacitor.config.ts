import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Wraps the existing Vite build (`dist/`) in a native shell for Android/iOS.
 * The web app itself needs no changes to run here — only chrome-level
 * concerns (fullscreen, orientation lock, the Android back button) get
 * native equivalents, added incrementally as each platform comes online.
 */
const config: CapacitorConfig = {
  appId: 'com.onyxsystems.swarm',
  appName: 'SWARM',
  webDir: 'dist',
  backgroundColor: '#05070c',
  android: {
    backgroundColor: '#05070c',
  },
  ios: {
    backgroundColor: '#05070c',
  },
};

export default config;
