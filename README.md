# SWARM — Hold the Line

One reactor core against an endless hive. Mine the seams, wall the approaches,
and render the swarm down into something you can spend. Every wave is a
countdown to the one that ends the sector.

A base-building survival game: TypeScript + Vite, rendered on a single 2D
canvas with no framework or game engine underneath.

## Status

Proprietary, unreleased. See [LICENSE](LICENSE) — all rights reserved.

## Platforms

| Target | Shell | Status |
| --- | --- | --- |
| Web | plain browser build (`vite build`) | active |
| Desktop | Electron, packaged with `electron-builder` (Windows/macOS/Linux) | active — primary release target (Steam) |
| Mobile | Capacitor (Android/iOS) | paused — touch controls need UX work before release |

## Getting started

```bash
npm install
npm run dev
```

Opens the game at `http://localhost:5173` with hot reload.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production web build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | Headless simulation test suite (see below) |
| `npm test` | `typecheck` + `smoke` — run this before committing |
| `npm run electron:dev` | Vite + Electron together, with hot reload |
| `npm run electron:preview` | Build, then run the packaged app locally |
| `npm run electron:build` | Build installers via `electron-builder` (`release/`) |
| `npm run icons:desktop` | Regenerate desktop app icons |
| `npm run cap:sync` | Build the web bundle and sync it into the native Capacitor projects |
| `npm run cap:android` / `cap:ios` | Sync, then open the native project in Android Studio / Xcode |

## Testing

`npm run smoke` bundles `src/dev/smoke.ts` with esbuild and runs it under
Node — no canvas, no audio, no browser. It drives full runs (prep, every
wave, the boss, the win/lose transition) against seeded maps and asserts
invariants that are easy to silently break: NaN positions, unreachable spawn
gates, runaway entity counts, stuck phases, save/resume round-trips. This is
the fast regression net; the browser is for feel, not correctness.

## Project layout

```
src/
  core/     input, audio, save/load, i18n, platform detection
  engine/   generic bits with no game knowledge — particles, flow-field pathing, spatial hash
  game/     the simulation itself (Game, entities, waves, save snapshots)
  render/   canvas drawing — world, HUD, touch HUD
  ui/       DOM screens (menus, briefing, settings) layered over the canvas
  data/     content definitions — buildings, enemies, levels, tech, achievements
  locales/  en (inline fallback in source) + de/es/fr/ru translation tables
  dev/      the smoke test harness
electron/   Electron main process + preload bridge
android/    Capacitor Android project (generated; do not hand-edit generated files)
ios/        Capacitor iOS project (generated; do not hand-edit generated files)
```

## Saves

Progress and settings persist through `src/core/save.ts`. On the web and in
Capacitor this is `localStorage`; under Electron it's a real JSON file in the
OS user-data directory (see `electron/preload.cjs` / `electron/main.cjs`) so
a tool like Steam Cloud can back it up.
