/** Compare validated JSON snapshots across the Prisma/Postgres round trip.
 * Decimal serialization can change the last few bits of derived minutes. Keep
 * identity, text, structure, array order and integer values exact; allow only
 * floating-point round-off, never a training-volume or baseline adjustment.
 */
export function planningSnapshotsEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "number") {
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (Number.isInteger(left) && Number.isInteger(right)) return false;
    return Math.abs(left - right) <= 8 * Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => planningSnapshotsEqual(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const before = left as Record<string, unknown>;
  const after = right as Record<string, unknown>;
  const keys = Object.keys(before);
  return keys.length === Object.keys(after).length &&
    keys.every(key => Object.hasOwn(after, key) && planningSnapshotsEqual(before[key], after[key]));
}
