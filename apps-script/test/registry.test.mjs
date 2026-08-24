/**
 * Workbook registry tests.
 *
 * The school opens classes mid-season, so the list of workbooks is data rather
 * than code. These cover the guards around editing it from the app.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeBook, makeProperties } from './harness.mjs';
import { fionaSheet, dianaSheet, plain } from './fixtures.mjs';

const FIONA = 'fiona-book-id';
const DIANA = 'diana-book-id';

/** A script over a small library of workbooks, with a controllable registry. */
function withLibrary(registry) {
  const books = {
    [FIONA]: makeBook(fionaSheet(), { id: FIONA }).book,
    [DIANA]: makeBook(dianaSheet(), { id: DIANA }).book
  };
  const props = makeProperties({
    KIOSK_TOKEN: 'test-token',
    ...(registry ? { WORKBOOKS: JSON.stringify(registry) } : {})
  });
  const script = loadScript({
    PropertiesService: props,
    SpreadsheetApp: {
      openById: (id) => {
        if (!books[id]) throw new Error('Requested entity was not found.');
        return books[id];
      },
      flush() {}
    }
  });
  const stored = () => JSON.parse(props.store.get('WORKBOOKS'));
  return { script, props, stored };
}

const URL_OF = (id) => `https://docs.google.com/spreadsheets/d/${id}/edit?gid=0#gid=0`;

test('a pasted Sheets URL yields its id', () => {
  const { script } = withLibrary([]);

  assert.equal(script.extractSpreadsheetId(URL_OF(FIONA)), FIONA);
  assert.equal(script.extractSpreadsheetId(`  ${URL_OF(DIANA)}  `), DIANA);
});

test('a bare id is accepted, anything else is not', () => {
  const { script } = withLibrary([]);

  assert.equal(script.extractSpreadsheetId('1E1Zxq-JA3UUVTvA2kqckHmdamZYaUepSZfVyKmChN48'),
    '1E1Zxq-JA3UUVTvA2kqckHmdamZYaUepSZfVyKmChN48');
  assert.equal(script.extractSpreadsheetId('https://example.com/nope'), null);
  assert.equal(script.extractSpreadsheetId('short'), null);
  assert.equal(script.extractSpreadsheetId(''), null);
});

test('adding a workbook stores it and reports what it holds', () => {
  const { script, stored } = withLibrary([{ id: FIONA, label: 'Fiona' }]);

  const workbooks = plain(script.addWorkbook(URL_OF(DIANA)));

  assert.deepEqual(stored().map((entry) => entry.id), [FIONA, DIANA]);
  const added = workbooks.find((entry) => entry.id === DIANA);
  assert.equal(added.reachable, true);
  assert.deepEqual(added.courses, [
    'Julio & Diana - Inter-Avancé 1',
    'Julio & Diana - Faux-Débutant 1'
  ]);
});

test('a workbook the account cannot open is refused before it is stored', () => {
  const { script, stored } = withLibrary([{ id: FIONA, label: 'Fiona' }]);

  assert.throws(() => script.addWorkbook(URL_OF('unknown-book')), /partagé en édition/);
  assert.deepEqual(stored().map((entry) => entry.id), [FIONA]);
});

test('the same workbook cannot be added twice', () => {
  const { script, stored } = withLibrary([{ id: FIONA, label: 'Fiona' }]);

  assert.throws(() => script.addWorkbook(URL_OF(FIONA)), /déjà dans la liste/);
  assert.equal(stored().length, 1);
});

test('a link that is not a Sheets URL is rejected with its own message', () => {
  const { script } = withLibrary([]);

  assert.throws(() => script.addWorkbook('https://example.com/nope'), /non reconnu/);
});

test('removing a workbook leaves the others alone', () => {
  const { script, stored } = withLibrary([
    { id: FIONA, label: 'Fiona' },
    { id: DIANA, label: 'Diana' }
  ]);

  script.removeWorkbook(FIONA);

  assert.deepEqual(stored().map((entry) => entry.id), [DIANA]);
});

test('an unreachable workbook is reported, not hidden', () => {
  const { script } = withLibrary([
    { id: FIONA, label: 'Fiona' },
    { id: 'gone', label: 'Retiré du partage' }
  ]);

  const workbooks = plain(script.describeWorkbooks());

  assert.equal(workbooks[0].reachable, true);
  assert.equal(workbooks[1].reachable, false);
  assert.match(workbooks[1].error, /inaccessible/);
});

test('an unreachable workbook still lets the other classes load', () => {
  const { script } = withLibrary([
    { id: 'gone', label: 'Retiré du partage' },
    { id: DIANA, label: 'Diana' }
  ]);

  const courses = plain(script.readAllCourses(new Date(2026, 7, 25)));

  assert.equal(courses[0].unreachable, true);
  assert.deepEqual(courses.slice(1).map((c) => c.title), [
    'Julio & Diana - Inter-Avancé 1',
    'Julio & Diana - Faux-Débutant 1'
  ]);
});

test('hiding a class flags it without removing it', () => {
  const { script } = withLibrary([{ id: DIANA, label: 'Diana' }]);
  const date = new Date(2026, 7, 25);
  const target = plain(script.readAllCourses(date))[1];

  script.setCourseHidden(target.id, true);
  const after = plain(script.readAllCourses(date));

  assert.equal(after.length, 2);
  assert.equal(after[0].hidden, false);
  assert.equal(after[1].hidden, true);
});

test('unhiding a class removes the flag', () => {
  const { script } = withLibrary([{ id: DIANA, label: 'Diana' }]);
  const date = new Date(2026, 7, 25);
  const target = plain(script.readAllCourses(date))[1];

  script.setCourseHidden(target.id, true);
  script.setCourseHidden(target.id, false);

  assert.deepEqual(plain(script.hiddenCourseIds()), []);
  assert.equal(plain(script.readAllCourses(date))[1].hidden, false);
});

test('an empty registry seeds itself rather than returning nothing', () => {
  const { script, props } = withLibrary(null);

  const seeded = plain(script.listWorkbooks());

  assert.ok(seeded.length >= 1);
  assert.ok(props.store.has('WORKBOOKS'), 'the seed should be persisted');
});
