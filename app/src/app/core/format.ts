/** Display helpers shared by the screens. */

/** "mardi 25 août" — the studio's own way of naming a session. */
export function longDate(iso: string, locale: string): string {
  const parts = iso.split('-');
  if (parts.length !== 3) return '';
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * Lowercase, accent-free — so searching "elodie" finds "Élodie S.".
 * Students type their own name in a hurry, on a phone keyboard, standing up.
 */
export function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function plural(count: number, one: string, many: string): string {
  return count > 1 ? many : one;
}

/**
 * A trial student's contact details, as the school will read them in its own
 * Commentaires column.
 *
 * Either half on its own is a usable answer — somebody may have a phone and no
 * email, or the reverse — so a missing one leaves no dangling separator.
 */
export function contactLine(phone: string, email: string): string {
  return [phone, email]
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(' · ');
}

/**
 * Enough of an email check to catch a slip, and no more. This is typed
 * standing up, on someone else's phone, with a class waiting: refusing a real
 * address costs the school a lead, and there is nothing here to protect.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/** A Date as the ISO day the rest of the app keys everything on. */
export function isoOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** August: the month a season opens, which is what dates a "MM-DD" column. */
const SEASON_FIRST_MONTH = 8;

/**
 * Turns a workbook's "MM-DD" session key into a full date.
 *
 * The grid names its columns by day and month alone — a header is hand-typed as
 * often as it is a real date — so the year has to be inferred. The backend
 * already leans on the same fact to find a column at all: a season runs from
 * August to June, so a month and day pair names one day and only one within it.
 * August onwards therefore belongs to the year the season opened, January to
 * July to the year after.
 *
 * Returns null for a key that names no real day, February 30th included.
 */
export function isoFromSessionKey(key: string, today: Date = new Date()): string | null {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(key);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const opened =
    today.getMonth() + 1 >= SEASON_FIRST_MONTH ? today.getFullYear() : today.getFullYear() - 1;
  const date = new Date(month >= SEASON_FIRST_MONTH ? opened : opened + 1, month - 1, day);

  // Rolls over on an impossible day: 02-30 comes back as March.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return isoOf(date);
}
