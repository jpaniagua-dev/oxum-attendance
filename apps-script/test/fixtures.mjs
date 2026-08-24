/**
 * Grids shaped like the school's real workbooks.
 *
 * Names are invented on purpose — the fixtures reproduce the layout, never the
 * roster. What matters is the shape: a class whose leader side is empty while
 * its trial side overflows, two classes stacked in one tab, and date headers
 * stored both as real dates and as typed text.
 */

import { section, sheetOf, roster } from './harness.mjs';

/** 2026-08-25 — the first session column of the season. */
export const SESSION = new Date(2026, 7, 25);

export const DATES = [
  new Date(2026, 7, 25),
  new Date(2026, 8, 1),
  new Date(2026, 8, 8),
  new Date(2026, 8, 15),
  new Date(2026, 8, 22),
  new Date(2026, 8, 29)
];

export const TEXT_DATES = ['25.08', '1.09', '8.09', '15.09', '22.09', '29.09'];

/** One class, no active leaders, nine trial followers. */
export function fionaSheet() {
  return sheetOf(section({
    title: 'Julio & Fiona - débutant 1',
    dates: DATES,
    blocks: {
      'leader:active': roster([]),
      'follower:active': [
        { name: 'Amandine R.', present: [true, false, false, false, false, false] },
        { name: 'Bérénice I.', present: [true, false, false, false, false, false] },
        { name: 'Chloé D. J.', present: [true, false, false, false, false, false] },
        { name: '' }, { name: '' }, { name: '' }, { name: '' }
      ],
      'leader:trial': roster(['Damien N.', 'Émile R.', 'Farid M.', 'Gaspard S.', 'Hugo C.', 'Ismaël F.', 'Joris']),
      'follower:trial': roster(
        ['Karine C.', 'Léa D. S.', 'Maud O.', 'Nadia N.', 'Olivia', 'Prune F.', 'Quiterie', 'Roxane L.', 'Sixtine B.'],
        9
      ),
      'leader:helper': roster([]),
      'follower:helper': roster([])
    }
  }));
}

/** Two classes stacked in one tab, with date headers typed as text. */
export function dianaSheet() {
  return sheetOf(
    section({
      title: 'Julio & Diana - Inter-Avancé 1',
      dates: TEXT_DATES,
      blocks: {
        'leader:active': roster(['Antoine H.', 'Basile P.', 'Cyril A.', 'Damien X.']),
        'follower:active': roster(['Élodie S.', 'Fanny W. K.', 'Garance P.']),
        'leader:trial': roster(['Hector A.', 'Ivan']),
        'follower:trial': roster(['Jeanne O.', 'Karen B.', 'Lucie', 'Manon V.', 'Nine G.']),
        'leader:helper': roster([]),
        'follower:helper': roster([])
      }
    }),
    section({
      title: 'Julio & Diana - Faux-Débutant 1',
      dates: TEXT_DATES,
      blocks: {
        'leader:active': roster(['Olivier P.', 'Pierre S.', 'Quentin S.']),
        'follower:active': roster(['Rose W.']),
        'leader:trial': roster(['Samuel', 'Théo', 'Ulysse H.', 'Victor L.']),
        'follower:trial': roster(['Wanda R.', 'Xénia C.', 'Yara', 'Zoé B.', 'Alix M.', 'Bianca H.', 'Camille J.']),
        'leader:helper': roster([]),
        'follower:helper': roster([])
      }
    })
  );
}

/**
 * Values built inside the vm realm carry that realm's prototypes, so they are
 * never deepStrictEqual to ours however identical they look. Round-tripping
 * through JSON rebuilds them here — which is also what the app gets over the
 * wire.
 */
export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

export function groupsOf(course) {
  return Object.fromEntries(course.groups.map((group) => [group.key, group]));
}
