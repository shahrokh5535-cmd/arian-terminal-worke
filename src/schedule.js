export function scheduleInterval(value, minimum, fallback) {
  const parsed = Number(value);
  return Math.max(minimum, Number.isFinite(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : fallback);
}
