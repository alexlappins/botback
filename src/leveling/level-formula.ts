/**
 * Standard MEE6/Arcane formula. XP needed to GO FROM level n TO level n+1:
 *   xp_needed(n) = 5 * n^2 + 50 * n + 100
 */
export const MAX_LEVEL = 1000;

export function xpNeededForLevel(level: number): number {
  if (level < 0) return 0;
  return 5 * level * level + 50 * level + 100;
}

/** Cumulative XP required to reach `level` from 0. */
export function xpToReachLevel(level: number): number {
  let total = 0;
  for (let i = 0; i < level; i++) total += xpNeededForLevel(i);
  return total;
}

/**
 * Resolve a totalXp value to a level by iterating forwards (max 1000, fast).
 * Returns the highest level whose cumulative XP threshold is <= totalXp.
 */
export function levelFromTotalXp(totalXp: bigint | number): number {
  const xp = typeof totalXp === 'bigint' ? Number(totalXp) : totalXp;
  if (!Number.isFinite(xp) || xp <= 0) return 0;
  let level = 0;
  let acc = 0;
  while (level < MAX_LEVEL) {
    const next = xpNeededForLevel(level);
    if (acc + next > xp) break;
    acc += next;
    level += 1;
  }
  return level;
}

/** XP within the current level, plus what's needed to reach the next one. */
export function levelProgress(
  totalXp: bigint | number,
  currentLevel: number,
): { current: number; needed: number; percent: number } {
  const xp = typeof totalXp === 'bigint' ? Number(totalXp) : totalXp;
  const floor = xpToReachLevel(currentLevel);
  const needed = xpNeededForLevel(currentLevel);
  const current = Math.max(0, Math.min(needed, xp - floor));
  const percent = needed > 0 ? Math.floor((current / needed) * 100) : 0;
  return { current, needed, percent };
}
