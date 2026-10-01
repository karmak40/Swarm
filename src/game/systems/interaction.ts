import { audio } from '../../core/audio';
import type { InputSource } from '../../core/input';
import { clamp } from '../../core/math';
import { GHOST_LIFT } from '../../core/touch';
import { BUILDINGS, BUILD_CATEGORIES, CATEGORY_KEY_CODE, HOTKEY_CODES } from '../../data/buildings';
import type { Game } from '../game';
import { TILE } from '../world';

/**
 * Player interaction with the map: cursor → world, zoom, build-bar hotkeys,
 * placement ghost, selling, repair, targeting, strike and upgrade keys.
 *
 * Touch drives the same state (cursorMode, buildKind, aimOverride) from
 * `core/touch.ts`, so anything here that touch also needs must stay reachable
 * through a public `Game` method rather than being inlined into this key handler.
 */
export class InteractionSystem {
  constructor(private readonly game: Game) {}

  update(input: InputSource, dt: number) {
    const g = this.game;
    // Cursor → world.
    const view = g.viewport;
    g.mouseWorldX = g.camera.x + (input.mouseX - view.w / 2) / g.camera.zoom;
    g.mouseWorldY = g.camera.y + (input.mouseY - view.h / 2) / g.camera.zoom;
    if (g.aimOverride) {
      g.mouseWorldX = g.aimOverride.x;
      g.mouseWorldY = g.aimOverride.y;
    }

    if (input.uiCaptured) return;

    // Zoom.
    if (input.wheel !== 0) {
      g.camera.zoom = clamp(g.camera.zoom * (input.wheel > 0 ? 0.9 : 1.111), 0.55, 1.9);
    }

    // Section keys first: they change what the digits mean.
    for (const cat of BUILD_CATEGORIES) {
      if (!input.pressed(CATEGORY_KEY_CODE[cat])) continue;
      if (g.categoryBuildings(cat).length === 0) break;
      g.buildCategory = cat;
      // Switching sections cancels a pending placement rather than silently
      // leaving a ghost from the section you just left.
      g.buildKind = null;
      g.cursorMode = 'normal';
      audio.play('uiClick');
      break;
    }

    // Digits select a slot inside the active section.
    for (const kind of g.categoryBuildings(g.buildCategory)) {
      const def = BUILDINGS[kind];
      const code = HOTKEY_CODES[def.hotkey];
      if (!code || !input.pressed(code)) continue;
      g.buildKind = g.buildKind === kind ? null : kind;
      g.cursorMode = g.buildKind ? 'build' : 'normal';
      audio.play('uiClick');
      break;
    }

    if (input.pressed('KeyQ')) {
      g.cursorMode = g.cursorMode === 'sell' ? 'normal' : 'sell';
      g.buildKind = null;
      audio.play('uiClick');
    }

    if (input.pressed('Escape') && g.cursorMode !== 'normal') {
      g.cursorMode = 'normal';
      g.buildKind = null;
      audio.play('uiBack');
    }

    // Hover resolution.
    const htx = Math.floor(g.mouseWorldX / TILE);
    const hty = Math.floor(g.mouseWorldY / TILE);
    g.hoverBuilding = g.buildingAtTile(htx, hty);
    g.hoverNode = g.world.nodeAtTile(htx, hty) ?? null;

    // Cycle targeting mode of the hovered turret.
    if (input.pressed('KeyT') && g.hoverBuilding) g.cycleTargeting(g.hoverBuilding);

    if (input.pressed('KeyR')) g.toggleSpeed();

    // Orbital strike: F drops it on the cursor; on touch the strike button
    // arms 'strike' mode and the next map tap lands it (see TouchInput).
    if (input.pressed('KeyF') && g.cursorMode === 'normal') {
      g.strike.call(g.mouseWorldX, g.mouseWorldY);
    } else if (g.cursorMode === 'strike' && input.mouseClicked(0)) {
      if (g.strike.call(g.mouseWorldX, g.mouseWorldY)) g.cursorMode = 'normal';
    }

    // Upgrade the hovered turret: U takes it to level 2; at level 2 the fork
    // is U = rapid fire, I = long range (spelled out in the hover tooltip).
    const hb = g.hoverBuilding;
    if (hb && g.cursorMode === 'normal') {
      if (input.pressed('KeyU')) g.upgradeBuilding(hb, hb.level === 2 ? 'rapid' : undefined);
      else if (input.pressed('KeyI') && hb.level === 2) g.upgradeBuilding(hb, 'range');
    }

    // Repair while E held.
    if (input.down('KeyE') && g.hoverBuilding && g.hoverBuilding.hp < g.hoverBuilding.maxHp) {
      g.buildingSystem.repairBuilding(g.hoverBuilding, dt);
    }

    if (g.cursorMode === 'build' && g.buildKind) {
      const def = BUILDINGS[g.buildKind];
      // On touch, the placement point sits right under the thumb doing the
      // pointing — lift it clear so the ghost (and what's behind it) is
      // actually visible. Desktop has a real cursor, so it needs none of this.
      // The lift is in screen px (≈ a fingertip), so it holds at any zoom.
      const pty = g.touchUi ? Math.floor((g.mouseWorldY - GHOST_LIFT / g.camera.zoom) / TILE) : hty;
      // Centre the footprint on the cursor for multi-tile structures.
      const off = Math.floor((def.size - 1) / 2);
      g.buildTx = htx - off;
      g.buildTy = pty - off;
      g.buildValid = g.canPlace(def, g.buildTx, g.buildTy) === null;

      if (input.mouseDown(0)) {
        const reason = g.canPlace(def, g.buildTx, g.buildTy);
        if (reason === null) g.buildingSystem.place(def, g.buildTx, g.buildTy);
        else if (input.mouseClicked(0)) g.presentation.error(reason);
      }
      if (input.mouseClicked(2)) {
        g.cursorMode = 'normal';
        g.buildKind = null;
        audio.play('uiBack');
      }
    } else if (g.cursorMode === 'sell') {
      if (input.mouseClicked(0) && g.hoverBuilding) g.sellBuilding(g.hoverBuilding);
      if (input.mouseClicked(2)) { g.cursorMode = 'normal'; audio.play('uiBack'); }
    }

    // Skip the build phase for a bonus.
    if (input.pressed('Space')) g.skipBuildPhase();
  }
}
