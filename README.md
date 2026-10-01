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
| Mobile | Capacitor (Android/iOS) | in progress — portrait touch controls reworked; needs on-device testing before release |

### Replayability

Beyond the campaign, everything runs offline and lives in the save file:

- **Score** — waves survived × 1000 + kills, plus a speed bonus on a win, scaled by
  heat (`data/scoring.ts`). Depth always beats farming.
- **Mutators** — opt-in handicaps for Endless (Swarm Surge, Thin Seams, Frail Core, ...).
  Each carries *heat* that multiplies score, XP and relic payout (`data/mutators.ts`).
  They funnel through `Perks` and the level's difficulty, so the simulation never
  special-cases them. Unlocked by commander rank.
- **Daily challenge** — one shared endless run per UTC day. Sector, map seed and two
  mutators derive from the date alone, so every player fights the same map with no
  server (`data/daily.ts`). First run of the day pays a relic bounty that grows with
  the streak; the run is not resumable.
- **Records** — top 10 runs per board (Endless / Daily / Campaign / Custom), kept in the
  save (`core/save.ts`, `game/runResult.ts`).
- **Commander rank** — XP from every run, win or lose. Each rank adds a small permanent
  perk, a relic bounty and sometimes a mutator unlock (`data/ranks.ts`); it complements
  the Armoury, which is spent on chosen upgrades.

A global leaderboard would need a backend or Steamworks; the local boards store enough
(score, seed, date) to submit from later.

### Touch controls

Phones play in portrait. Aiming is automatic, so the right thumb only makes
decisions:

- **Move** — drag on the lower-left; **Dash / Build / Start / ✓** stack in a
  column on the right edge (`core/touch.ts`, `render/touchHud.ts`).
- **Build** — pick from the drawer (hold a slot for details), tap the map to
  aim the ghost, then **✓** to place; walls go down on tap. While building,
  dragging the map pans the camera; **pinch** zooms at any time.
- **Manage** — long-press a structure for upgrade / repair / targeting / sell
  (sell asks twice). Turrets upgrade to level 2, then fork at level 3 into
  rapid fire or long range (`data/upgrades.ts`); on desktop, U / I over a turret.
- **Orbital strike** — kills charge it; tap ▼ then the map (desktop: F on the
  cursor) and a beam lands a second later (`game/systems/strike.ts`).
- **Fast-forward** — ×1/×2 button left of pause (desktop: R); the simulation
  steps twice per frame rather than taking longer steps.
- **Hive intel** — a card introduces each new enemy type during the build phase
  before its wave (what it is, how to fight it); all of them live in the
  Bestiary (title and pause menus). Advice is derived from the enemy data
  (`data/bestiary.ts`).
- The view auto-fits ~24 tiles across the short side; off-screen enemies and
  structures under attack get edge arrows.
- First-time players are taught in context by `render/coach.ts` (one tip at a
  time, each shown once); the full reference is *How to play* in the pause menu.
- 'Auto' graphics quality steps down if the frame rate stays low
  (`core/autoQuality.ts`).

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
  game/     the simulation itself (Game facade, entities, waves, level setup, save snapshots)
    systems/  one class per concern (buildings, combat, enemies, interaction, strike, ...)
  render/   canvas drawing — world, HUD, touch HUD, touch coach
  ui/       DOM screens layered over the canvas; screens.ts is the facade, panels/ holds one file per screen group
  data/     content definitions — buildings, enemies, levels, tech, achievements
  locales/  en (inline fallback in source) + de/es/fr/pl/ru translation tables
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
