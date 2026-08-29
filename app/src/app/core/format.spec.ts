import { describe, expect, it } from 'vitest';

import { isoFromSessionKey } from './format';

/**
 * The workbook dates its columns by day and month, and the app keys its own
 * memory — announcements above all — on a full ISO date. Everything the date
 * list offers goes through here, so a wrong year would silently point the app
 * at another season's storage.
 */
describe('isoFromSessionKey', () => {
  const inSeason = new Date(2026, 7, 29); // 29 August 2026, season 2026-2027
  const afterNewYear = new Date(2027, 0, 5); // 5 January 2027, same season

  it('dates an autumn column to the year the season opened', () => {
    expect(isoFromSessionKey('08-25', inSeason)).toBe('2026-08-25');
    expect(isoFromSessionKey('11-03', inSeason)).toBe('2026-11-03');
  });

  it('dates a spring column to the year after', () => {
    expect(isoFromSessionKey('01-12', inSeason)).toBe('2027-01-12');
    expect(isoFromSessionKey('06-10', inSeason)).toBe('2027-06-10');
  });

  /** Same season, read from the other side of New Year: same answers. */
  it('does not move a date when the season is read in January', () => {
    expect(isoFromSessionKey('08-25', afterNewYear)).toBe('2026-08-25');
    expect(isoFromSessionKey('06-10', afterNewYear)).toBe('2027-06-10');
  });

  it('accepts the unpadded form a hand-typed header produces', () => {
    expect(isoFromSessionKey('9-1', inSeason)).toBe('2026-09-01');
  });

  it('refuses anything that is not a real day', () => {
    expect(isoFromSessionKey('02-30', inSeason)).toBeNull();
    expect(isoFromSessionKey('13-01', inSeason)).toBeNull();
    expect(isoFromSessionKey('mardi', inSeason)).toBeNull();
    expect(isoFromSessionKey('', inSeason)).toBeNull();
  });
});
