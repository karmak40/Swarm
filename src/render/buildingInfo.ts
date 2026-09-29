import { t as tr } from '../core/i18n';
import type { BuildingDef } from '../data/buildings';
import type { Game } from '../game/game';

/**
 * A structure's stat readout, perk-adjusted, as short localised chips
 * ("46 dmg", "250 range", "anti-air", …). Cost is left out: each caller
 * shows it in its own place.
 *
 * Shared by the desktop build tooltip and the touch drawer / placement card
 * so the two can never disagree about what a turret does.
 */
export function buildingStats(game: Game, d: BuildingDef): string[] {
  const stats: string[] = [];
  if (d.power) stats.push(d.power < 0
    ? tr('hud.tooltip.powerSupply', '+{n} power', { n: -d.power })
    : tr('hud.tooltip.powerDraw', '{n} power draw', { n: d.power }));
  if (d.damage) stats.push(tr('hud.tooltip.dmg', '{n} dmg', { n: Math.round(d.damage * game.perks.turretDamage) }));
  if (d.fireRate) stats.push(tr('hud.tooltip.fireRate', '{n}/s', { n: (d.fireRate * game.perks.turretFireRate).toFixed(1) }));
  if (d.range) stats.push(tr('hud.tooltip.range', '{n} range', { n: Math.round(d.range * game.perks.turretRange) }));
  if (d.splash) stats.push(tr('hud.tooltip.splash', '{n} splash', { n: d.splash }));
  if (d.chains) stats.push(tr('hud.tooltip.chains', '{n} chain', { n: d.chains }));
  if (d.beam) stats.push(d.pierce && d.pierce > 1
    ? tr('hud.tooltip.beamPierces', 'beam · pierces {n}', { n: d.pierce })
    : tr('hud.tooltip.beamNeverMisses', 'beam · never misses'));
  if (d.homing) stats.push(tr('hud.tooltip.guided', 'guided'));
  if (d.armorPierce === 999) stats.push(tr('hud.tooltip.ignoresArmour', 'ignores armour'));
  else if (d.armorPierce) stats.push(tr('hud.tooltip.armourPierce', '{n} armour pierce', { n: d.armorPierce }));
  if (d.burst && d.burst > 1) stats.push(tr('hud.tooltip.burst', '{n}-round burst', { n: d.burst }));
  if (d.minRange) stats.push(tr('hud.tooltip.minRange', 'min range {n}', { n: d.minRange }));
  // Targeting only engages fliers when `antiAir` is set (see
  // BuildingSystem's target scan). Every weapon states which it is, derived
  // from that rule rather than the two flags separately, so a future turret
  // with neither flag can't silently read as air-capable.
  if (d.damage) stats.push(canHitAir(d)
    ? tr('hud.tooltip.antiAir', 'anti-air')
    : tr('hud.tooltip.groundOnly', 'ground only'));
  if (d.droneSlots) {
    stats.push(tr('hud.tooltip.droneSlots', '{n} drones', { n: d.droneSlots }));
    stats.push(tr('hud.tooltip.droneRate', '{n}/s each', { n: (d.droneMineRate! * game.perks.extractorRate).toFixed(1) }));
    stats.push(tr('hud.tooltip.droneCargo', '{n} cargo', { n: d.droneCargo ?? 0 }));
  }
  stats.push(tr('hud.tooltip.hp', '{n} hp', { n: Math.round(d.hp * game.perks.structureHp) }));
  return stats;
}

/** Mirrors the target scan: fliers are skipped unless `antiAir` is set. */
export function canHitAir(d: BuildingDef): boolean {
  return d.antiAir === true && !d.groundOnly;
}
