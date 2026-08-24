/**
 * Parser and writer tests, run against fixtures shaped like the real workbooks.
 *
 * Names here are invented on purpose — the fixtures reproduce the school's
 * layout, never its roster. What matters is the shape: a course whose leader
 * side is empty while its trial side overflows, two courses stacked in one
 * sheet, and date headers stored both as real dates and as typed text.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, section, sheetOf, toRange, roster } from './harness.mjs';

const SESSION = new Date(2026, 7, 25); // 2026-08-25, the first session column
const DATES = [
  new Date(2026, 7, 25),
  new Date(2026, 8, 1),
  new Date(2026, 8, 8),
  new Date(2026, 8, 15),
  new Date(2026, 8, 22),
  new Date(2026, 8, 29)
];
const TEXT_DATES = ['25.08', '1.09', '8.09', '15.09', '22.09', '29.09'];

/** Fiona's workbook: one course, no active leaders, nine trial followers. */
function fionaSheet() {
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

/** Diana's workbook: two courses stacked in one tab, dates typed as text. */
function dianaSheet() {
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

function scan(rows, date = SESSION) {
  const script = loadScript();
  return script.scanSheet('book-id', 'Feuille 1', toRange(rows), date);
}

/**
 * Values built inside the vm realm carry that realm's prototypes, so they are
 * never deepStrictEqual to ours however identical they look. Round-tripping
 * through JSON rebuilds them here — which is also exactly what the kiosk gets
 * over the wire.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function groupsOf(course) {
  return Object.fromEntries(course.groups.map((group) => [group.key, group]));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('reads a single-course sheet with all six blocks', () => {
  const courses = scan(fionaSheet());

  assert.equal(courses.length, 1);
  assert.equal(courses[0].title, 'Julio & Fiona - débutant 1');
  assert.equal(courses[0].groups.length, 6);
  assert.equal(courses[0].hasSession, true);
});

test('an empty block yields no students but keeps its free slots', () => {
  const groups = groupsOf(scan(fionaSheet())[0]);

  assert.equal(groups['leader:active'].students.length, 0);
  assert.equal(groups['leader:active'].freeSlots.length, 7);
  assert.equal(groups['follower:active'].students.length, 3);
  assert.equal(groups['follower:active'].freeSlots.length, 4);
});

test('block heights are read per block, not assumed', () => {
  const groups = groupsOf(scan(fionaSheet())[0]);

  assert.equal(groups['leader:trial'].students.length, 7);
  assert.equal(groups['follower:trial'].students.length, 9);
});

test('leaders and followers resolve to their own session column', () => {
  const groups = groupsOf(scan(fionaSheet())[0]);

  for (const key of ['leader:active', 'leader:trial', 'leader:helper']) {
    assert.equal(groups[key].sessionColumn, 4, `${key} should use column D`);
  }
  for (const key of ['follower:active', 'follower:trial', 'follower:helper']) {
    assert.equal(groups[key].sessionColumn, 14, `${key} should use column N`);
  }
});

test('name columns follow the same split', () => {
  const groups = groupsOf(scan(fionaSheet())[0]);

  assert.equal(groups['leader:trial'].nameColumn, 3);
  assert.equal(groups['follower:trial'].nameColumn, 13);
});

test('existing ticks are read back', () => {
  const groups = groupsOf(scan(fionaSheet())[0]);
  const students = groups['follower:active'].students;

  assert.deepEqual(plain(students.map((s) => s.name)), ['Amandine R.', 'Bérénice I.', 'Chloé D. J.']);
  assert.deepEqual(plain(students.map((s) => s.present)), [true, true, true]);
  assert.deepEqual(plain(groups['leader:trial'].students.map((s) => s.present)), Array(7).fill(false));
});

test('two courses stacked in one tab stay separate', () => {
  const courses = scan(dianaSheet());

  assert.equal(courses.length, 2);
  assert.deepEqual(plain(courses.map((c) => c.title)), [
    'Julio & Diana - Inter-Avancé 1',
    'Julio & Diana - Faux-Débutant 1'
  ]);
  courses.forEach((course) => assert.equal(course.groups.length, 6));

  const first = groupsOf(courses[0]);
  const second = groupsOf(courses[1]);
  assert.deepEqual(plain(first['leader:active'].students.map((s) => s.name)),
    ['Antoine H.', 'Basile P.', 'Cyril A.', 'Damien X.']);
  assert.deepEqual(plain(second['leader:active'].students.map((s) => s.name)),
    ['Olivier P.', 'Pierre S.', 'Quentin S.']);
});

test('a totals row is never mistaken for a course banner', () => {
  const courses = scan(dianaSheet());

  courses.forEach((course) => {
    assert.ok(!/^total/i.test(course.title), `bad banner: ${course.title}`);
    assert.ok(course.title.startsWith('Julio'), `bad banner: ${course.title}`);
  });
});

test('date headers typed as text resolve like real dates', () => {
  const groups = groupsOf(scan(dianaSheet())[0]);

  assert.equal(groups['leader:active'].sessionColumn, 4);
  assert.equal(groups['follower:active'].sessionColumn, 14);
  assert.deepEqual(plain(groups['leader:active'].sessionColumns.map((c) => c.key)),
    ['08-25', '09-01', '09-08', '09-15', '09-22', '09-29']);
});

test('a date with no column is reported, not guessed', () => {
  const courses = scan(fionaSheet(), new Date(2026, 9, 6)); // 06.10, not in the sheet

  assert.equal(courses[0].hasSession, false);
  courses[0].groups.forEach((group) => assert.equal(group.sessionColumn, null));
  courses[0].groups.forEach((group) => {
    group.students.forEach((student) => assert.equal(student.present, null));
  });
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A spreadsheet stub that records every range write instead of performing it. */
function writableBook(rows) {
  const writes = [];
  const range = toRange(rows);
  const sheet = {
    getName: () => 'Feuille 1',
    getDataRange: () => range,
    getRange: (row, column, numRows) => ({
      setValues: (values) => {
        writes.push({ row, column, numRows, values: values.map((v) => v[0]) });
      }
    })
  };
  const book = {
    getId: () => 'book-id',
    getSheets: () => [sheet],
    getSheetByName: (name) => (name === 'Feuille 1' ? sheet : null)
  };
  const script = loadScript({
    SpreadsheetApp: { openById: () => book, flush() {} }
  });
  return { script, writes };
}

/** Flattens recorded range writes into one entry per cell. */
function cellsOf(writes) {
  return writes.flatMap((write) =>
    write.values.map((value, i) => ({ row: write.row + i, column: write.column, value }))
  );
}

test('a follower is written to the follower column, never the leader one', () => {
  const { script, writes } = writableBook(fionaSheet());
  const course = script.scanSheet('book-id', 'Feuille 1', toRange(fionaSheet()), SESSION)[0];
  const followers = groupsOf(course)['follower:active'].students;

  const result = script.applySession({
    courseId: course.id,
    marks: followers.map((student) => ({
      group: 'follower:active',
      row: student.row,
      name: student.name,
      present: true
    }))
  }, SESSION);

  assert.equal(result.written, 3);
  assert.deepEqual(plain(result.rejected), []);
  cellsOf(writes).forEach((cell) => {
    assert.equal(cell.column, 14);
    assert.equal(cell.value, true);
  });
});

test('leaders and followers of one submission land in their own columns', () => {
  const { script, writes } = writableBook(dianaSheet());
  const course = script.scanSheet('book-id', 'Feuille 1', toRange(dianaSheet()), SESSION)[0];
  const groups = groupsOf(course);

  script.applySession({
    courseId: course.id,
    marks: [
      { group: 'leader:active', row: groups['leader:active'].students[0].row, name: 'Antoine H.', present: true },
      { group: 'follower:active', row: groups['follower:active'].students[0].row, name: 'Élodie S.', present: true }
    ]
  }, SESSION);

  const cells = cellsOf(writes);
  assert.equal(cells.length, 2);
  assert.deepEqual(cells.map((c) => c.column).sort((a, b) => a - b), [4, 14]);
});

test('an unticked student is written as FALSE', () => {
  const { script, writes } = writableBook(fionaSheet());
  const course = script.scanSheet('book-id', 'Feuille 1', toRange(fionaSheet()), SESSION)[0];
  const trials = groupsOf(course)['leader:trial'].students;

  script.applySession({
    courseId: course.id,
    marks: trials.map((student, i) => ({
      group: 'leader:trial',
      row: student.row,
      name: student.name,
      present: i === 0
    }))
  }, SESSION);

  const cells = cellsOf(writes);
  assert.equal(cells.length, 7);
  assert.equal(cells[0].value, true);
  cells.slice(1).forEach((cell) => assert.equal(cell.value, false));
});

test('a row whose name moved is rejected and nothing is written for it', () => {
  const { script, writes } = writableBook(fionaSheet());
  const course = script.scanSheet('book-id', 'Feuille 1', toRange(fionaSheet()), SESSION)[0];
  const student = groupsOf(course)['follower:active'].students[0];

  const result = script.applySession({
    courseId: course.id,
    marks: [{ group: 'follower:active', row: student.row, name: 'Quelqu’un d’autre', present: true }]
  }, SESSION);

  assert.equal(result.written, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /row now holds/);
  assert.equal(writes.length, 0);
});

test('a row outside the block is rejected even if it exists elsewhere', () => {
  const { script, writes } = writableBook(fionaSheet());
  const course = script.scanSheet('book-id', 'Feuille 1', toRange(fionaSheet()), SESSION)[0];
  const trial = groupsOf(course)['leader:trial'].students[0];

  const result = script.applySession({
    courseId: course.id,
    // Right row number, wrong block: the active block has no such roster row.
    marks: [{ group: 'leader:active', row: trial.row, name: trial.name, present: true }]
  }, SESSION);

  assert.equal(result.written, 0);
  assert.match(result.rejected[0].reason, /no longer a roster row/);
  assert.equal(writes.length, 0);
});

test('a walk-in fills the first free trial row, name and tick together', () => {
  const { script, writes } = writableBook(dianaSheet());
  const course = script.scanSheet('book-id', 'Feuille 1', toRange(dianaSheet()), SESSION)[0];
  const expectedRow = groupsOf(course)['leader:trial'].freeSlots[0].row;

  const result = script.applySession({
    courseId: course.id,
    additions: [{ role: 'leader', name: 'Walk In' }]
  }, SESSION);

  assert.deepEqual(plain(result.added), [{ row: expectedRow, name: 'Walk In', role: 'leader' }]);
  const cells = cellsOf(writes);
  assert.deepEqual(
    cells.map((c) => ({ row: c.row, column: c.column, value: c.value })).sort((a, b) => a.column - b.column),
    [
      { row: expectedRow, column: 3, value: 'Walk In' },
      { row: expectedRow, column: 4, value: true }
    ]
  );
});

test('two walk-ins of the same role take two different rows', () => {
  const { script } = writableBook(dianaSheet());
  const course = script.scanSheet('book-id', 'Feuille 1', toRange(dianaSheet()), SESSION)[0];

  const result = script.applySession({
    courseId: course.id,
    additions: [
      { role: 'leader', name: 'First In' },
      { role: 'leader', name: 'Second In' }
    ]
  }, SESSION);

  assert.equal(result.added.length, 2);
  assert.notEqual(result.added[0].row, result.added[1].row);
});

test('a walk-in beyond the free rows is refused, not written elsewhere', () => {
  const { script, writes } = writableBook(fionaSheet());
  const course = script.scanSheet('book-id', 'Feuille 1', toRange(fionaSheet()), SESSION)[0];

  const result = script.applySession({
    courseId: course.id,
    // The leader trial block is full: seven names, zero free rows.
    additions: [{ role: 'leader', name: 'Too Late' }]
  }, SESSION);

  assert.equal(result.added.length, 0);
  assert.match(result.rejected[0].reason, /no free row left/);
  assert.equal(writes.length, 0);
});

test('submitting for a date with no column fails loudly and writes nothing', () => {
  const { script, writes } = writableBook(fionaSheet());
  const october = new Date(2026, 9, 6);
  const course = script.scanSheet('book-id', 'Feuille 1', toRange(fionaSheet()), SESSION)[0];

  assert.throws(
    () => script.applySession({ courseId: course.id, marks: [] }, october),
    /No column for 2026-10-06/
  );
  assert.equal(writes.length, 0);
});

test('writes only ever touch roster rows, never a totals or header row', () => {
  const rows = fionaSheet();
  const { script, writes } = writableBook(rows);
  const course = script.scanSheet('book-id', 'Feuille 1', toRange(rows), SESSION)[0];

  const marks = [];
  course.groups.forEach((group) => {
    group.students.forEach((student) => {
      marks.push({ group: group.key, row: student.row, name: student.name, present: true });
    });
  });

  script.applySession({ courseId: course.id, marks }, SESSION);

  const rosterRows = new Set();
  course.groups.forEach((group) => group.students.forEach((s) => rosterRows.add(s.row)));

  const touched = cellsOf(writes);
  assert.equal(touched.length, marks.length);
  touched.forEach((cell) => {
    assert.ok(rosterRows.has(cell.row), `wrote outside the roster at row ${cell.row}`);
    const label = String(rows[cell.row - 1][1] ?? '') + String(rows[cell.row - 1][11] ?? '');
    assert.ok(!/total|N°|Nom/i.test(label), `wrote on a structural row: ${label}`);
  });
});

test('contiguous rows are written as one range call', () => {
  const { script, writes } = writableBook(fionaSheet());
  const course = script.scanSheet('book-id', 'Feuille 1', toRange(fionaSheet()), SESSION)[0];
  const trials = groupsOf(course)['leader:trial'].students;

  script.applySession({
    courseId: course.id,
    marks: trials.map((student) => ({
      group: 'leader:trial', row: student.row, name: student.name, present: true
    }))
  }, SESSION);

  assert.equal(writes.length, 1, 'seven contiguous rows should cost one write');
  assert.equal(writes[0].numRows, 7);
});
