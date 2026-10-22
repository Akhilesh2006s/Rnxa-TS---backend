// Work dates are plain calendar dates (YYYY-MM-DD). All arithmetic is done in
// UTC on those strings so server time zone never shifts a date.

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const parse = (date: string) => new Date(`${date}T00:00:00Z`);
const format = (d: Date) => d.toISOString().slice(0, 10);

export function isValidDate(date: string): boolean {
  return ISO_DATE.test(date) && format(parse(date)) === date;
}

export function today(now = new Date()): string {
  // Server local calendar date.
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return format(local);
}

export function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return format(d);
}

/** ISO weekday, Monday = 1 ... Sunday = 7. */
export function isoWeekday(date: string): number {
  const day = parse(date).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}
