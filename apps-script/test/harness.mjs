/**
 * Loads Code.gs outside Apps Script so the parser can be tested.
 *
 * The file is plain ES5 in a global scope, so it evaluates cleanly in a vm
 * context once the handful of Apps Script globals it touches are stubbed.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Only the two patterns Code.gs actually asks for; time zone is ignored. */
function formatDate(date, _timeZone, format) {
  const parts = {
    'yyyy-MM-dd': `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    'MM-dd': `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  };
  if (!(format in parts)) throw new Error(`unsupported format: ${format}`);
  return parts[format];
}

export function loadScript(overrides = {}) {
  const context = vm.createContext({
    console,
    Utilities: { formatDate },
    Session: { getScriptTimeZone: () => 'Europe/Zurich' },
    PropertiesService: makeProperties({ KIOSK_TOKEN: 'test-token' }),
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => ({ setMimeType: () => ({ text }) })
    },
    SpreadsheetApp: { flush() {} },
    ...overrides
  });
  vm.runInContext(SOURCE, context);
  return context;
}

/** Script properties backed by a Map, so registry writes are observable. */
export function makeProperties(initial = {}) {
  const store = new Map(Object.entries(initial));
  const api = {
    getProperty: (key) => (store.has(key) ? store.get(key) : null),
    setProperty: (key, value) => { store.set(key, String(value)); return api; },
    deleteProperty: (key) => { store.delete(key); return api; }
  };
  return { getScriptProperties: () => api, store };
}

/**
 * A sheet stub addressed one cell at a time, the way the writer works.
 *
 * It mutates the same grid it reads from, so a test can assert that a write
 * landed and that a later read sees it — which is how the stale-row checks are
 * exercised.
 */
export function makeSheet(rows, name = 'Feuille 1') {
  const writes = [];
  const grid = rows.map((row) => {
    const copy = row.slice();
    while (copy.length < WIDTH) copy.push('');
    return copy;
  });

  const sheet = {
    getName: () => name,
    getDataRange: () => toRange(grid),
    getRange: (row, column) => ({
      getValue: () => grid[row - 1][column - 1],
      getDisplayValue: () => {
        const value = grid[row - 1][column - 1];
        if (value === '' || value === null || value === undefined) return '';
        if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
        return String(value);
      },
      setValue: (value) => {
        writes.push({ row, column, value });
        grid[row - 1][column - 1] = value;
      }
    })
  };

  return { sheet, writes, grid };
}

/** A spreadsheet holding one sheet, wired into a loadScript override. */
export function makeBook(rows, { id = 'book-id', name = 'Feuille 1' } = {}) {
  const { sheet, writes, grid } = makeSheet(rows, name);
  const book = {
    getId: () => id,
    getName: () => 'Classeur de test',
    getSheets: () => [sheet],
    getSheetByName: (wanted) => (wanted === name ? sheet : null)
  };
  return { book, sheet, writes, grid };
}

// ---------------------------------------------------------------------------
// Fixture building
// ---------------------------------------------------------------------------

export const WIDTH = 20;

export function emptyRow() {
  return new Array(WIDTH).fill('');
}

/** Mirrors how Sheets renders a cell, which is all getDisplayValues gives us. */
function toDisplay(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (value instanceof Date) return `${value.getDate()}.${pad2(value.getMonth() + 1)}`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/**
 * Wraps a grid of raw values into the range shape Code.gs consumes.
 *
 * A merged cell holds its value in the top-left cell only — the rest read back
 * empty — so fixtures write block titles once, exactly like the real sheets.
 */
export function toRange(values) {
  const padded = values.map((row) => {
    const copy = row.slice();
    while (copy.length < WIDTH) copy.push('');
    return copy;
  });
  return {
    getValues: () => padded.map((row) => row.slice()),
    getDisplayValues: () => padded.map((row) => row.map(toDisplay))
  };
}

/**
 * Builds one course section: banner, then the three category blocks, each
 * split into a leader half at column 1 and a follower half at column 11.
 *
 * `dates` are the session column headers — pass Date objects to exercise the
 * real-date path, strings for the hand-typed path. Both occur in the wild.
 */
export function section({ title, dates, blocks }) {
  const rows = [];
  const banner = emptyRow();
  banner[1] = title;
  rows.push(banner);

  const layout = [
    { key: 'active', left: 'Leaders actifs', right: 'Followers actifs', total: 'Total inscrits' },
    { key: 'trial', left: 'Essais Leader', right: 'Essais Follower', total: 'Total tests' },
    { key: 'helper', left: 'Aide Leader', right: 'Aide Follower', total: 'Total aides' }
  ];

  layout.forEach((part, index) => {
    const titles = emptyRow();
    titles[1] = part.left;
    titles[11] = part.right;
    rows.push(titles);

    const header = emptyRow();
    header[1] = 'N°';
    header[2] = 'Nom';
    dates.forEach((date, i) => { header[3 + i] = date; });
    header[9] = 'Commentaires';
    header[11] = 'N°';
    header[12] = 'Nom';
    dates.forEach((date, i) => { header[13 + i] = date; });
    header[19] = 'Commentaires';
    rows.push(header);

    const leaders = blocks[`leader:${part.key}`] || [];
    const followers = blocks[`follower:${part.key}`] || [];
    const height = Math.max(leaders.length, followers.length);

    for (let i = 0; i < height; i++) {
      const row = emptyRow();
      if (i < leaders.length) {
        row[1] = i + 1;
        row[2] = leaders[i].name || '';
        dates.forEach((_, d) => { row[3 + d] = (leaders[i].present || [])[d] ?? false; });
      }
      if (i < followers.length) {
        row[11] = i + 1;
        row[12] = followers[i].name || '';
        dates.forEach((_, d) => { row[13 + d] = (followers[i].present || [])[d] ?? false; });
      }
      rows.push(row);
    }

    rows.push(emptyRow());

    const totals = emptyRow();
    totals[1] = part.total;
    totals[11] = part.total;
    rows.push(totals);

    if (index === layout.length - 1) {
      const grand = emptyRow();
      grand[1] = 'Total présences';
      grand[11] = 'Total présences';
      rows.push(grand);
    }
  });

  return rows;
}

/** Stacks sections into a sheet, with the two leading blank rows both files have. */
export function sheetOf(...sections) {
  const rows = [emptyRow(), emptyRow()];
  sections.forEach((rowsOfSection, index) => {
    if (index > 0) rows.push(emptyRow());
    rowsOfSection.forEach((row) => rows.push(row));
  });
  return rows;
}

/** Seven numbered rows, named from `names`, the rest left as free slots. */
export function roster(names, count = 7) {
  return Array.from({ length: Math.max(count, names.length) }, (_, i) => ({
    name: names[i] || ''
  }));
}
