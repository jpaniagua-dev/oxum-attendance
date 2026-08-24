/**
 * Writer tests.
 *
 * The app sends one operation per tap, so these exercise single-cell writes and
 * the checks that stand between a tap and someone else's row.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeBook, makeProperties, toRange } from './harness.mjs';
import { SESSION, fionaSheet, dianaSheet, groupsOf, plain } from './fixtures.mjs';

/** A script wired to one workbook, with its writes recorded. */
function withBook(rows) {
  const { book, sheet, writes, grid } = makeBook(rows);
  const props = makeProperties({ KIOSK_TOKEN: 'test-token' });
  const script = loadScript({
    PropertiesService: props,
    SpreadsheetApp: {
      openById: (id) => {
        if (id !== 'book-id') throw new Error('not found');
        return book;
      },
      flush() {}
    }
  });
  const course = (index = 0) =>
    script.scanSheet('book-id', 'Feuille 1', toRange(rows), SESSION)[index];
  return { script, sheet, writes, grid, props, course };
}

/** Builds a mark operation from a parsed group and student. */
function markOp(group, student, present) {
  return {
    kind: 'mark',
    spreadsheetId: 'book-id',
    sheetName: 'Feuille 1',
    row: student.row,
    nameColumn: group.nameColumn,
    sessionColumn: group.sessionColumn,
    name: student.name,
    present: present
  };
}

test('a tick lands in the session cell of that student’s own half', () => {
  const { script, writes, course } = withBook(fionaSheet());
  const group = groupsOf(course())['follower:trial'];
  const student = group.students[0];

  const results = plain(script.runOperations([markOp(group, student, true)]));

  assert.equal(results[0].ok, true);
  assert.deepEqual(writes, [{ row: student.row, column: 14, value: true }]);
});

test('leaders and followers on the same row write to different columns', () => {
  const { script, writes, course } = withBook(fionaSheet());
  const groups = groupsOf(course());
  const leader = groups['leader:trial'].students[0];
  const follower = groups['follower:trial'].students[0];

  assert.equal(leader.row, follower.row, 'fixture should share a row across halves');

  script.runOperations([
    markOp(groups['leader:trial'], leader, true),
    markOp(groups['follower:trial'], follower, true)
  ]);

  assert.deepEqual(writes.map((w) => w.column), [4, 14]);
});

test('unticking writes FALSE rather than clearing the cell', () => {
  const { script, writes, course } = withBook(fionaSheet());
  const group = groupsOf(course())['follower:active'];
  const student = group.students[0];

  assert.equal(student.present, true, 'fixture should start ticked');
  script.runOperations([markOp(group, student, false)]);

  assert.equal(writes[0].value, false);
});

test('a row whose name changed is refused and nothing is written', () => {
  const { script, writes, course } = withBook(fionaSheet());
  const group = groupsOf(course())['follower:active'];
  const student = group.students[0];

  const results = plain(script.runOperations([
    { ...markOp(group, student, true), name: 'Quelqu’un d’autre' }
  ]));

  assert.equal(results[0].ok, false);
  assert.equal(results[0].stale, true);
  assert.match(results[0].reason, /contient maintenant/);
  assert.equal(writes.length, 0);
});

test('an accent or spacing difference is not treated as a different person', () => {
  const { script, writes, course } = withBook(fionaSheet());
  const group = groupsOf(course())['follower:active'];
  const student = group.students[1];

  assert.equal(student.name, 'Bérénice I.');
  const results = plain(script.runOperations([
    { ...markOp(group, student, true), name: '  berenice   i.  ' }
  ]));

  assert.equal(results[0].ok, true);
  assert.equal(writes.length, 1);
});

test('a walk-in writes name and tick into the free row', () => {
  const { script, writes, course } = withBook(dianaSheet());
  const group = groupsOf(course())['leader:trial'];
  const slot = group.freeSlots[0];

  const results = plain(script.runOperations([{
    kind: 'trial',
    spreadsheetId: 'book-id',
    sheetName: 'Feuille 1',
    row: slot.row,
    nameColumn: group.nameColumn,
    sessionColumn: group.sessionColumn,
    name: 'Camille B.'
  }]));

  assert.equal(results[0].ok, true);
  assert.equal(results[0].added, true);
  assert.deepEqual(writes, [
    { row: slot.row, column: 3, value: 'Camille B.' },
    { row: slot.row, column: 4, value: true }
  ]);
});

test('a walk-in never overwrites a row someone else already took', () => {
  const { script, writes, course } = withBook(dianaSheet());
  const group = groupsOf(course())['leader:trial'];
  const taken = group.students[0];

  const results = plain(script.runOperations([{
    kind: 'trial',
    spreadsheetId: 'book-id',
    sheetName: 'Feuille 1',
    row: taken.row,
    nameColumn: group.nameColumn,
    sessionColumn: group.sessionColumn,
    name: 'Camille B.'
  }]));

  assert.equal(results[0].ok, false);
  assert.equal(results[0].stale, true);
  assert.match(results[0].reason, /a été prise par/);
  assert.equal(writes.length, 0);
});

test('a second walk-in sees the first one and refuses the same row', () => {
  const { script, course } = withBook(dianaSheet());
  const group = groupsOf(course())['leader:trial'];
  const slot = group.freeSlots[0];
  const op = {
    kind: 'trial',
    spreadsheetId: 'book-id',
    sheetName: 'Feuille 1',
    row: slot.row,
    nameColumn: group.nameColumn,
    sessionColumn: group.sessionColumn,
    name: 'Camille B.'
  };

  const results = plain(script.runOperations([op, { ...op, name: 'Autre Personne' }]));

  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
});

test('one failing operation does not stop the rest of the batch', () => {
  const { script, writes, course } = withBook(fionaSheet());
  const group = groupsOf(course())['leader:trial'];
  const [first, second] = group.students;

  const results = plain(script.runOperations([
    { ...markOp(group, first, true), name: 'Personne Inconnue' },
    markOp(group, second, true)
  ]));

  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
  assert.deepEqual(writes, [{ row: second.row, column: 4, value: true }]);
});

test('an operation missing a cell address is refused, not guessed', () => {
  const { script, writes, course } = withBook(fionaSheet());
  const group = groupsOf(course())['leader:trial'];
  const student = group.students[0];

  const results = plain(script.runOperations([
    { ...markOp(group, student, true), sessionColumn: null }
  ]));

  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /Missing sessionColumn/);
  assert.equal(writes.length, 0);
});

test('an unreachable workbook fails only its own operation', () => {
  const { script, writes, course } = withBook(fionaSheet());
  const group = groupsOf(course())['leader:trial'];
  const student = group.students[0];

  const results = plain(script.runOperations([
    { ...markOp(group, student, true), spreadsheetId: 'nope' },
    markOp(group, group.students[1], true)
  ]));

  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
  assert.equal(writes.length, 1);
});
