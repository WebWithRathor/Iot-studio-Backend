/**
 * Pure chip-binding rules for LMS devices (B1 `device.chipId`, `?replaceChip=true`).
 * A hardware id is bound to the physical ESP32 it was first flashed onto
 * (machine.unique_id() as lowercase hex); a chip is bound to at most one
 * active device (partial unique index uniq_active_chip).
 */

/**
 *   keep      nothing to change: no chipId sent (older LMS), or the same chip
 *   bind      first chip for this hardware id
 *   replace   another chip with replaceChip=true: bind it and rotate the broker
 *             credentials, so the previous chip is locked out
 *   mismatch  another chip without replaceChip → 409 chip_mismatch
 */
export type ChipDecision = 'keep' | 'bind' | 'replace' | 'mismatch';

export function decideChipBinding(bound: string | null | undefined, incoming: string | undefined, replaceChip: boolean): ChipDecision {
  if (!incoming || incoming === bound) return 'keep';
  if (replaceChip) return 'replace';
  return bound ? 'mismatch' : 'bind';
}

/** 409 chip_in_use details: name the other board only to its own owner. */
export function chipInUseDetails(other: { hardwareId: string; ownerId: unknown }, userId: string): { hardwareId: string } | undefined {
  return String(other.ownerId) === userId ? { hardwareId: other.hardwareId } : undefined;
}
