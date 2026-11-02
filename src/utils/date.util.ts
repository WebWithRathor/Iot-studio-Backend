const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** "10m" → 600, "7d" → 604800, "45" → 45. Returns null when malformed. */
export function parseDuration(input: string): number | null {
  const m = /^\s*(\d+)\s*([smhd])?\s*$/i.exec(input);
  if (!m) return null;
  return Number(m[1]) * UNIT_SECONDS[(m[2] ?? 's').toLowerCase()];
}

export const nowMs = (): number => Date.now();

/** Date | number | null → epoch milliseconds (the frontend's timestamp format). */
export function toEpoch(d: Date | number | string | null | undefined): number {
  if (d === null || d === undefined) return 0;
  if (typeof d === 'number') return d;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
}

export const toEpochOrNull = (d: Date | null | undefined): number | null => (d ? toEpoch(d) : null);

export const addSeconds = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);
export const addHours = (d: Date, h: number): Date => new Date(d.getTime() + h * 3_600_000);
