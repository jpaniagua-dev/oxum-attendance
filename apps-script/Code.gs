/**
 * Attendance backend — Bachata Geneva Dance Studio.
 *
 * Reads the school's attendance workbooks and writes presence checkboxes.
 * Deployed as a web app running as the deploying user (Julio), who already has
 * edit rights on the workbooks — so there is no service account and no OAuth
 * secret anywhere in this repo.
 *
 * Two things drive the shape of this API:
 *
 * - Students arrive one at a time, over the whole hour, and whoever is teaching
 *   may never press a "send" button. So a tick is written the moment it happens
 *   (`mark`), not gathered into an end-of-class submission.
 * - The school opens new classes mid-season. So the workbook list lives in
 *   script properties and is edited from the app (`addWorkbook`), not in this
 *   file.
 *
 * The workbook layout this parser expects is documented in README.md. Nothing
 * is read from a fixed address: blocks are located by their titles and every
 * other cell is resolved relative to them.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Seeds the registry the first time the script runs. Not secrets: these ids
 * only open for accounts the school shared them with. After the first read the
 * registry in script properties is authoritative and this list is ignored.
 */
var SEED_WORKBOOKS = [
  { id: '1gA1lbZNnaxmZ79s5GFTLTZDhuJh9wmCIZmc6akp0EFY', label: 'Julio & Diana - mardi' },
  { id: '1E1Zxq-JA3UUVTvA2kqckHmdamZYaUepSZfVyKmChN48', label: 'Julio & Fiona - débutant 1' }
];

var TOKEN_PROPERTY = 'KIOSK_TOKEN';
var WORKBOOKS_PROPERTY = 'WORKBOOKS';
var HIDDEN_PROPERTY = 'HIDDEN_COURSES';

/** Column header that closes the run of session-date columns in a block. */
var COMMENTS_HEADER = 'commentaires';

/**
 * Block titles, as they appear in the merged cell above each block header.
 * Matching is accent- and case-insensitive.
 */
var BLOCK_TITLES = [
  { pattern: /^leaders? actifs$/, role: 'leader', category: 'active' },
  { pattern: /^followers? actifs$/, role: 'follower', category: 'active' },
  { pattern: /^essais? leader$/, role: 'leader', category: 'trial' },
  { pattern: /^essais? follower$/, role: 'follower', category: 'trial' },
  { pattern: /^aides? leader$/, role: 'leader', category: 'helper' },
  { pattern: /^aides? follower$/, role: 'follower', category: 'helper' }
];

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  return respond(function () {
    var params = (e && e.parameter) || {};
    requireToken(params.token);

    switch (params.action || 'session') {
      case 'ping':
        return { pong: true, timeZone: scriptTimeZone() };
      case 'workbooks':
        return { workbooks: describeWorkbooks() };
      case 'session':
        var date = parseRequestedDate(params.date);
        return {
          date: formatIsoDate(date),
          dateKey: monthDayKey(date),
          courses: readAllCourses(date)
        };
      default:
        throw new Error('Unknown action "' + params.action + '".');
    }
  });
}

function doPost(e) {
  return respond(function () {
    var body = parseJsonBody(e);
    requireToken(body.token);

    switch (body.action) {
      case 'mark':
      case 'trial':
        // Single-operation convenience: the app taps one name at a time.
        return { results: runOperations([body]) };
      case 'batch':
        return { results: runOperations(body.ops || []) };
      case 'addWorkbook':
        return { workbooks: addWorkbook(body.url || body.id) };
      case 'removeWorkbook':
        return { workbooks: removeWorkbook(body.id) };
      case 'setHidden':
        return { hidden: setCourseHidden(body.courseId, body.hidden === true) };
      default:
        throw new Error('Unknown action "' + body.action + '".');
    }
  });
}

/**
 * Runs `work`, and turns whatever comes out of it — value or exception — into
 * a JSON response. Every endpoint answers 200 with {ok: …}: Apps Script web
 * apps cannot set a status code, so the flag in the body is the only signal
 * the app can rely on.
 */
function respond(work) {
  var payload;
  try {
    payload = work();
    payload.ok = true;
  } catch (err) {
    payload = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * The web app is reachable without a Google login, so its URL alone would be a
 * write credential. The token turns it into two independent things to know.
 * Set it once from the editor: Project settings → Script properties.
 */
function requireToken(candidate) {
  var expected = PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY);
  if (!expected) {
    throw new Error('Script property ' + TOKEN_PROPERTY + ' is not set.');
  }
  if (candidate !== expected) {
    throw new Error('Invalid token.');
  }
}

function parseJsonBody(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Empty request body.');
  }
  return JSON.parse(e.postData.contents);
}

// ---------------------------------------------------------------------------
// Workbook registry
// ---------------------------------------------------------------------------

function properties() {
  return PropertiesService.getScriptProperties();
}

function readJsonProperty(key, fallback) {
  var raw = properties().getProperty(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function writeJsonProperty(key, value) {
  properties().setProperty(key, JSON.stringify(value));
}

/** The registry, seeded on first use so a fresh deployment is not empty. */
function listWorkbooks() {
  var stored = readJsonProperty(WORKBOOKS_PROPERTY, null);
  if (stored && stored.length) return stored;
  writeJsonProperty(WORKBOOKS_PROPERTY, SEED_WORKBOOKS);
  return SEED_WORKBOOKS;
}

/** Registry plus what each workbook actually contains, for the settings page. */
function describeWorkbooks() {
  return listWorkbooks().map(function (entry) {
    var described = { id: entry.id, label: entry.label };
    try {
      var book = SpreadsheetApp.openById(entry.id);
      described.title = book.getName();
      described.courses = countCoursesIn(book);
      described.reachable = true;
    } catch (err) {
      described.reachable = false;
      described.error = 'Classeur inaccessible — vérifie le partage.';
    }
    return described;
  });
}

function countCoursesIn(book) {
  var titles = [];
  book.getSheets().forEach(function (sheet) {
    scanSheet(book.getId(), sheet.getName(), sheet.getDataRange(), new Date())
      .forEach(function (course) { titles.push(course.title); });
  });
  return titles;
}

/**
 * Registers a workbook from a pasted Sheets URL or a bare id.
 *
 * The workbook is opened before it is stored: a link that the deploying account
 * cannot reach must fail here, where someone is watching, rather than silently
 * producing a class list with a hole in it.
 */
function addWorkbook(reference) {
  var id = extractSpreadsheetId(reference);
  if (!id) throw new Error('Lien Google Sheets non reconnu.');

  var registry = listWorkbooks();
  var already = registry.some(function (entry) { return entry.id === id; });
  if (already) throw new Error('Ce classeur est déjà dans la liste.');

  var book;
  try {
    book = SpreadsheetApp.openById(id);
  } catch (err) {
    throw new Error(
      'Impossible d’ouvrir ce classeur. Il doit être partagé en édition avec le ' +
      'compte qui a déployé le script.'
    );
  }

  var courses = countCoursesIn(book);
  if (!courses.length) {
    throw new Error(
      'Aucun cours reconnu dans « ' + book.getName() + ' ». La grille doit contenir ' +
      'des blocs « Leaders actifs » / « Followers actifs ».'
    );
  }

  registry = registry.concat([{ id: id, label: book.getName() }]);
  writeJsonProperty(WORKBOOKS_PROPERTY, registry);
  return describeWorkbooks();
}

function removeWorkbook(id) {
  var registry = listWorkbooks().filter(function (entry) { return entry.id !== id; });
  writeJsonProperty(WORKBOOKS_PROPERTY, registry);
  return describeWorkbooks();
}

/** Accepts a full Sheets URL or the bare id. */
function extractSpreadsheetId(reference) {
  var text = cleanText(reference);
  if (!text) return null;
  var fromUrl = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(text) ? text : null;
}

// ---------------------------------------------------------------------------
// Course visibility
// ---------------------------------------------------------------------------

/**
 * A workbook can hold classes taught by other teachers. Hiding is a per-course
 * flag rather than a filter on the title, because course names repeat across
 * the school and only a human knows which ones are theirs.
 */
function hiddenCourseIds() {
  return readJsonProperty(HIDDEN_PROPERTY, []);
}

function setCourseHidden(courseId, hidden) {
  if (!courseId) throw new Error('Missing courseId.');
  var current = hiddenCourseIds().filter(function (id) { return id !== courseId; });
  if (hidden) current.push(courseId);
  writeJsonProperty(HIDDEN_PROPERTY, current);
  return current;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Reads every course of every registered workbook against one session date. */
function readAllCourses(date) {
  var hidden = hiddenCourseIds();
  var courses = [];

  listWorkbooks().forEach(function (entry) {
    var book;
    try {
      book = SpreadsheetApp.openById(entry.id);
    } catch (err) {
      // One unreachable workbook must not take the whole class list down.
      courses.push({
        id: entry.id + '::?::0',
        spreadsheetId: entry.id,
        title: entry.label || entry.id,
        unreachable: true,
        hidden: false,
        hasSession: false,
        sessionLabels: [],
        groups: []
      });
      return;
    }

    book.getSheets().forEach(function (sheet) {
      scanSheet(book.getId(), sheet.getName(), sheet.getDataRange(), date)
        .forEach(function (course) {
          course.workbookLabel = book.getName();
          course.hidden = hidden.indexOf(course.id) !== -1;
          courses.push(course);
        });
    });
  });

  return courses;
}

/**
 * Parses one sheet into courses.
 *
 * A sheet is a vertical stack of course sections. A section is a banner row
 * followed by six blocks: three categories, each duplicated for leaders on the
 * left and followers on the right. The two halves are separate grids that only
 * share their row numbers — they have their own name and date columns, which
 * is why every column lives on the block and never on the course.
 *
 * Takes the range rather than the sheet so the parser can be tested off Apps
 * Script against a fixture.
 */
function scanSheet(spreadsheetId, sheetName, range, date) {
  var values = range.getValues();
  var display = range.getDisplayValues();
  if (!values.length) return [];

  var blocks = findBlocks(display);
  if (!blocks.length) return [];

  var sections = findSections(display, blocks);
  if (!sections.length) return [];

  var courses = sections.map(function (section) {
    return {
      id: [spreadsheetId, sheetName, section.titleRow + 1].join('::'),
      spreadsheetId: spreadsheetId,
      sheetName: sheetName,
      title: section.title,
      titleRow: section.titleRow + 1,
      hasSession: false,
      sessionLabels: [],
      groups: []
    };
  });

  blocks.forEach(function (block) {
    var course = courses[sectionIndexFor(sections, block.row)];
    var group = readBlock(values, display, block, date);
    if (group.sessionColumn) course.hasSession = true;
    if (!course.sessionLabels.length) {
      course.sessionLabels = group.sessionColumns.map(function (c) { return c.label; });
    }
    course.groups.push(group);
  });

  return courses;
}

/** Locates every block title cell in the sheet. */
function findBlocks(display) {
  var blocks = [];
  for (var r = 0; r < display.length; r++) {
    for (var c = 0; c < display[r].length; c++) {
      var text = normalize(display[r][c]);
      if (!text) continue;
      for (var i = 0; i < BLOCK_TITLES.length; i++) {
        if (BLOCK_TITLES[i].pattern.test(text)) {
          blocks.push({
            row: r,
            col: c,
            label: cleanText(display[r][c]),
            role: BLOCK_TITLES[i].role,
            category: BLOCK_TITLES[i].category
          });
          break;
        }
      }
    }
  }
  return blocks;
}

/**
 * A new course starts at every row carrying an "actifs" block — that pair is
 * always the first of a section. Its banner is the nearest row above holding
 * text that is not another block title and not one of the totals lines that
 * separate the blocks.
 *
 * Looking for "the nearest non-empty row above" without those exclusions would
 * land on a totals row, or worse on a roster row whose leading cell is just a
 * sequence number.
 */
function findSections(display, blocks) {
  var blockRows = {};
  blocks.forEach(function (block) { blockRows[block.row] = true; });

  var starts = [];
  blocks.forEach(function (block) {
    if (block.category === 'active' && starts.indexOf(block.row) === -1) {
      starts.push(block.row);
    }
  });
  starts.sort(function (a, b) { return a - b; });

  return starts.map(function (startRow) {
    var titleRow = startRow;
    var title = '';
    for (var r = startRow - 1; r >= 0; r--) {
      if (blockRows[r]) continue;
      var text = cleanText(firstNonEmpty(display[r]));
      if (!text) continue;
      if (isTotalsLabel(text)) continue;
      titleRow = r;
      title = text;
      break;
    }
    return {
      startRow: startRow,
      titleRow: titleRow,
      title: title || ('Cours ligne ' + (startRow + 1))
    };
  });
}

/** Index of the section a block at `row` belongs to: the last one that opened. */
function sectionIndexFor(sections, row) {
  var index = 0;
  for (var i = 0; i < sections.length; i++) {
    if (sections[i].startRow <= row) index = i;
  }
  return index;
}

function isTotalsLabel(text) {
  return normalize(text).indexOf('total') === 0;
}

/**
 * Reads one block: the header row below the title gives the session columns,
 * the rows below it give the roster. Numbered rows with no name are the
 * school's spare slots — they are kept, because a walk-in trial student is
 * written into the first one.
 */
function readBlock(values, display, block, date) {
  var headerRow = block.row + 1;
  var numberCol = block.col;
  var nameCol = block.col + 1;

  var sessionColumns = readSessionColumns(values, display, headerRow, nameCol + 1);
  var commentIndex = findCommentColumn(display, headerRow, nameCol + 1);
  var wanted = monthDayKey(date);
  var sessionColumn = null;
  var sessionIndex = -1;
  sessionColumns.forEach(function (column) {
    if (!sessionColumn && column.key === wanted) {
      sessionColumn = column.column;
      sessionIndex = column.index;
    }
  });

  var students = [];
  var freeSlots = [];
  for (var r = headerRow + 1; r < values.length; r++) {
    var number = values[r][numberCol];
    // Totals rows and the blank line that closes a block both fail this test.
    if (typeof number !== 'number' || number <= 0) break;

    var name = cleanText(display[r][nameCol]);
    if (!name) {
      freeSlots.push({ row: r + 1, number: number });
      continue;
    }
    students.push({
      row: r + 1,
      number: number,
      name: name,
      present: sessionIndex === -1 ? null : values[r][sessionIndex] === true,
      comment: commentIndex === -1 ? '' : cleanText(display[r][commentIndex])
    });
  }

  return {
    key: block.role + ':' + block.category,
    label: block.label,
    role: block.role,
    category: block.category,
    nameColumn: nameCol + 1,
    commentColumn: commentIndex === -1 ? null : commentIndex + 1,
    sessionColumn: sessionColumn,
    sessionColumns: sessionColumns.map(function (column) {
      return { column: column.column, key: column.key, label: column.label };
    }),
    students: students,
    freeSlots: freeSlots
  };
}

/**
 * Collects the session-date columns of a block: everything between the name
 * column and the "Commentaires" column that closes the run.
 */
function readSessionColumns(values, display, headerRow, startCol) {
  var columns = [];
  var header = values[headerRow] || [];
  for (var c = startCol; c < header.length; c++) {
    var label = cleanText(display[headerRow][c]);
    if (!label || normalize(label) === COMMENTS_HEADER) break;
    var key = sessionKey(header[c], label);
    if (!key) continue;
    columns.push({ index: c, column: c + 1, key: key, label: label });
  }
  return columns;
}

/**
 * The "Commentaires" column that closes a block, scanning rightwards from the
 * name column so the left half never picks up the right half's one.
 */
function findCommentColumn(display, headerRow, startCol) {
  var header = display[headerRow] || [];
  for (var c = startCol; c < header.length; c++) {
    if (normalize(header[c]) === COMMENTS_HEADER) return c;
  }
  return -1;
}

/**
 * Canonical key for a session column: "MM-DD".
 *
 * The header may be a real date (displayed as 25.08) or the literal text — the
 * workbook is hand-made and both happen. A season runs August to June, so a
 * month/day pair is unambiguous within it, and the text form carries no year
 * to compare anyway.
 */
function sessionKey(value, label) {
  if (value instanceof Date) return monthDayKey(value);
  var match = String(label).trim().match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-]\d{2,4})?$/);
  if (!match) return null;
  return pad2(match[2]) + '-' + pad2(match[1]);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Applies a list of operations, each verified and reported on its own.
 *
 * The app sends one operation per tap and replays the same shapes from its
 * offline queue, so a batch is just several taps that happened while the room
 * had no network. One failing operation never blocks the others: a student who
 * ticked before the school inserted a row should not stop the next student
 * being recorded.
 */
function runOperations(ops) {
  var books = {};
  var sheets = {};

  var openSheet = function (spreadsheetId, sheetName) {
    var key = spreadsheetId + '::' + sheetName;
    if (sheets[key]) return sheets[key];
    if (!books[spreadsheetId]) books[spreadsheetId] = SpreadsheetApp.openById(spreadsheetId);
    var sheet = books[spreadsheetId].getSheetByName(sheetName);
    if (!sheet) throw new Error('Onglet « ' + sheetName + ' » introuvable.');
    sheets[key] = sheet;
    return sheet;
  };

  var results = ops.map(function (op) {
    try {
      var sheet = openSheet(op.spreadsheetId, op.sheetName);
      var kind = op.kind || op.action;
      if (kind === 'trial') return writeTrial(sheet, op);
      if (kind === 'comment') return writeComment(sheet, op);
      return writeMark(sheet, op);
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  });

  SpreadsheetApp.flush();
  return results;
}

/**
 * Ticks one existing student.
 *
 * Only two cells are touched: the name is read back to confirm the row still
 * holds the person the app thinks it does, then the session cell is written.
 * Re-scanning the whole grid for every tap would make each student wait on a
 * full sheet read for no extra safety.
 */
function writeMark(sheet, op) {
  requireCell(op, 'sessionColumn');
  var mismatch = nameMismatch(sheet, op);
  if (mismatch) return mismatch;

  sheet.getRange(op.row, op.sessionColumn).setValue(op.present === true);
  return { ok: true, row: op.row, name: op.name, present: op.present === true };
}

/**
 * Writes the free-text note the school keeps beside each name.
 *
 * The same row check as a tick: the column holds a sentence about a specific
 * person, so putting it on the wrong row is worse than not writing it at all.
 * An empty string clears the cell, which is how a note is removed.
 */
function writeComment(sheet, op) {
  requireCell(op, 'commentColumn');
  var mismatch = nameMismatch(sheet, op);
  if (mismatch) return mismatch;

  var text = cleanText(op.text);
  sheet.getRange(op.row, op.commentColumn).setValue(text);
  return { ok: true, row: op.row, name: op.name, comment: text };
}

/** Confirms the row still holds the person the app thinks it does. */
function nameMismatch(sheet, op) {
  if (!op.name) throw new Error('Missing name.');

  var actual = cleanText(sheet.getRange(op.row, op.nameColumn).getDisplayValue());
  if (normalize(actual) === normalize(op.name)) return null;

  return {
    ok: false,
    stale: true,
    reason: actual
      ? 'Cette ligne contient maintenant « ' + actual + ' ».'
      : 'Cette ligne est désormais vide.'
  };
}

/**
 * Writes a walk-in trial student into a free row: name, tick and how to reach
 * them, all in one go.
 *
 * The row must still be empty: two devices in the same room can hand out the
 * same free slot, and overwriting whoever got there first would erase a real
 * student's name.
 *
 * The contact details ride along rather than following as a separate comment
 * operation. A second operation would have to verify the name it had itself
 * just written, and would fail on its own if the row had been taken in between
 * — leaving the school a trial student it has no way to call back.
 */
function writeTrial(sheet, op) {
  requireCell(op, 'sessionColumn');
  var name = cleanText(op.name);
  if (!name) throw new Error('Missing name.');

  var occupant = cleanText(sheet.getRange(op.row, op.nameColumn).getDisplayValue());
  if (occupant) {
    return {
      ok: false,
      stale: true,
      reason: 'La ligne libre a été prise par « ' + occupant + ' ».'
    };
  }

  sheet.getRange(op.row, op.nameColumn).setValue(name);
  sheet.getRange(op.row, op.sessionColumn).setValue(op.present !== false);

  var contact = cleanText(op.text);
  if (contact && op.commentColumn) {
    sheet.getRange(op.row, op.commentColumn).setValue(contact);
  }

  return { ok: true, row: op.row, name: name, added: true, comment: contact };
}

function requireCell(op, targetColumn) {
  ['spreadsheetId', 'sheetName', 'row', 'nameColumn', targetColumn].forEach(function (field) {
    if (op[field] === undefined || op[field] === null || op[field] === '') {
      throw new Error('Missing ' + field + '.');
    }
  });
  if (typeof op.row !== 'number' || op.row < 1) throw new Error('Invalid row.');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function scriptTimeZone() {
  return Session.getScriptTimeZone() || 'Europe/Zurich';
}

/** Accepts YYYY-MM-DD, and falls back to today in the script's time zone. */
function parseRequestedDate(raw) {
  if (!raw) return new Date();
  var match = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Date must be YYYY-MM-DD, got "' + raw + '".');
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatIsoDate(date) {
  return Utilities.formatDate(date, scriptTimeZone(), 'yyyy-MM-dd');
}

function monthDayKey(date) {
  return Utilities.formatDate(date, scriptTimeZone(), 'MM-dd');
}

function pad2(value) {
  return ('0' + String(value)).slice(-2);
}

function cleanText(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
}

/** Lowercase, accent-free, single-spaced — for comparing hand-typed labels. */
function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function firstNonEmpty(row) {
  for (var i = 0; i < row.length; i++) {
    if (cleanText(row[i])) return row[i];
  }
  return '';
}
