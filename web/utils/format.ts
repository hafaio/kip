const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Format an ISO calendar date (YYYY-MM-DD) without constructing a Date, so it
// never shifts across timezones. Returns "" for empty/malformed input.
export function formatDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return "";
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!month || !day) return "";
  return `${MONTHS[month - 1]} ${day}`;
}

export function formatDateRange(start: string, end: string): string {
  const left = formatDate(start);
  const right = formatDate(end);
  if (!left) return right;
  if (!right) return left;
  return `${left} – ${right}`;
}

// Number of nights between two ISO dates (end exclusive).
export function nights(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  return Math.max(0, Math.round((endMs - startMs) / 86_400_000));
}

// A slot is over once its checkout day has passed. `end` is exclusive and trips
// use the same boundary (`end >= today` is still upcoming), so availability and
// stays agree on when something is done rather than drifting a day apart.
export function isExpired(end: string): boolean {
  return end < todayIso();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
