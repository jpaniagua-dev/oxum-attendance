/**
 * Parser tests, run against grids shaped like the real workbooks.
 *
 * Nothing in the sheet is at a fixed address, so these pin down the assumptions
 * the parser is allowed to make about a hand-kept grid — and the ones it is not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, toRange } from './harness.mjs';
import { SESSION, fionaSheet, dianaSheet, groupsOf, plain } from './fixtures.mjs';

function scan(rows, date = SESSION) {
  const script = loadScript();
  return script.scanSheet('book-id', 'Feuille 1', toRange(rows), date);
}

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

  assert.deepEqual(plain(students.map((s) => s.name)),
    ['Amandine R.', 'Bérénice I.', 'Chloé D. J.']);
  assert.deepEqual(plain(students.map((s) => s.present)), [true, true, true]);
  assert.deepEqual(plain(groups['leader:trial'].students.map((s) => s.present)),
    Array(7).fill(false));
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
  courses[0].groups.forEach((group) => {
    assert.equal(group.sessionColumn, null);
    group.students.forEach((student) => assert.equal(student.present, null));
  });
});

test('every course carries the address the app needs to write back', () => {
  const course = scan(dianaSheet())[1];

  assert.equal(course.spreadsheetId, 'book-id');
  assert.equal(course.sheetName, 'Feuille 1');
  assert.equal(course.id, `book-id::Feuille 1::${course.titleRow}`);
  course.groups.forEach((group) => {
    assert.ok(group.nameColumn > 0);
    assert.ok(group.sessionColumn > 0);
  });
});

test('each block exposes the comments column that closes it', () => {
  const groups = groupsOf(scan(fionaSheet())[0]);

  for (const key of ['leader:active', 'leader:trial', 'leader:helper']) {
    assert.equal(groups[key].commentColumn, 10, `${key} should use column J`);
  }
  for (const key of ['follower:active', 'follower:trial', 'follower:helper']) {
    assert.equal(groups[key].commentColumn, 20, `${key} should use column T`);
  }
});

test('an existing note is read back with its student', () => {
  const groups = groupsOf(scan(fionaSheet())[0]);

  assert.equal(groups['leader:trial'].students[0].comment, 'danse en fait follower');
  assert.equal(groups['leader:trial'].students[1].comment, '');
  assert.equal(groups['follower:active'].students[2].comment, 'pas sûre de continuer');
});

test('a block with no notes still reports a comments column', () => {
  const groups = groupsOf(scan(dianaSheet())[1]);

  assert.equal(groups['leader:active'].commentColumn, 10);
  groups['leader:active'].students.forEach((student) => assert.equal(student.comment, ''));
});
