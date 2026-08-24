/** Display helpers shared by the screens. */

/** "mardi 25 août" — the studio's own way of naming a session. */
export function longDate(iso: string): string {
  const parts = iso.split('-');
  if (parts.length !== 3) return '';
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return date.toLocaleDateString('fr-CH', { weekday: 'long', day: 'numeric', month: 'long' });
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
