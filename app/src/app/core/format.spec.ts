import { describe, expect, it } from 'vitest';

import { contactLine, isoFromSessionKey, looksLikeEmail } from './format';

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

/**
 * A trial student is a lead the school follows up afterwards, and this is the
 * line it will read in its own Commentaires column.
 */
describe('contactLine', () => {
  it('joins the two halves the way the rest of the app joins a pair of facts', () => {
    expect(contactLine('079 123 45 67', 'camille@exemple.ch')).toBe(
      '079 123 45 67 · camille@exemple.ch',
    );
  });

  it('leaves no dangling separator when only one was given', () => {
    expect(contactLine('079 123 45 67', '')).toBe('079 123 45 67');
    expect(contactLine('', 'camille@exemple.ch')).toBe('camille@exemple.ch');
    expect(contactLine('  ', ' ')).toBe('');
  });

  it('tidies what a phone keyboard produced', () => {
    expect(contactLine('  079   123  45 67 ', '')).toBe('079 123 45 67');
  });
});

describe('looksLikeEmail', () => {
  it('accepts an address', () => {
    expect(looksLikeEmail('camille@exemple.ch')).toBe(true);
    expect(looksLikeEmail(' camille.b@sub.exemple.co.uk ')).toBe(true);
  });

  /** Enough to catch a slip. It is not here to police anybody's address. */
  it('refuses what is plainly not one', () => {
    expect(looksLikeEmail('camille')).toBe(false);
    expect(looksLikeEmail('camille@exemple')).toBe(false);
    expect(looksLikeEmail('camille @exemple.ch')).toBe(false);
    expect(looksLikeEmail('')).toBe(false);
  });
});
