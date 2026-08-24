/**
 * Attendance kiosk backend — Bachata Geneva Dance Studio.
 *
 * Reads the attendance workbooks owned by the school and writes back the
 * presence checkboxes for a single session. Deployed as a web app running as
 * the deploying user (Julio), who already has edit rights on both workbooks —
 * so there is no service account and no OAuth secret anywhere in this repo.
 *
 * Endpoints
 *   GET  ?token=…&date=YYYY-MM-DD   → the whole grid for that session date
 *   POST {token, courseId, date, marks[], additions[]}  → writes the session
 *
 * The workbook layout this parser expects is documented in README.md. Nothing
 * is read from a fixed address: blocks are located by their titles and every
 * other cell is resolved relative to them.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Workbook ids. Not secrets: they only open for accounts the school shared them with. */
var WORKBOOK_IDS = [
  '1gA1lbZNnaxmZ79s5GFTLTZDhuJh9wmCIZmc6akp0EFY', // Julio & Diana - mardi
  '1E1Zxq-JA3UUVTvA2kqckHmdamZYaUepSZfVyKmChN48'  // Julio & Fiona - débutant 1
];

/** Script property holding the shared token the kiosk must present. */
var TOKEN_PROPERTY = 'KIOSK_TOKEN';

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

    if (params.action === 'ping') {
      return { pong: true, timeZone: scriptTimeZone() };
    }

    var date = parseRequestedDate(params.date);
    return {
      date: formatIsoDate(date),
      dateKey: monthDayKey(date),
      courses: readAllCourses(date)
    };
  });
}

function doPost(e) {
  return respond(function () {
    var body = parseJsonBody(e);
    requireToken(body.token);
    return applySession(body, parseRequestedDate(body.date));
  });
}

/**
 * Runs `work`, and turns whatever comes out of it — value or exception — into
 * a JSON response. Every endpoint answers 200 with {ok: …}: Apps Script web
 * apps cannot set a status code, so the flag in the body is the only signal
 * the kiosk can rely on.
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
// Reading
// ---------------------------------------------------------------------------

/** Reads every course of every workbook, resolved against one session date. */
function readAllCourses(date) {
  var courses = [];
  WORKBOOK_IDS.forEach(function (id) {
    var book = SpreadsheetApp.openById(id);
    book.getSheets().forEach(function (sheet) {
      scanSheet(book.getId(), sheet.getName(), sheet.getDataRange(), date)
        .forEach(function (course) { courses.push(course); });
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
      present: sessionIndex === -1 ? null : values[r][sessionIndex] === true
    });
  }

  return {
    key: block.role + ':' + block.category,
    label: block.label,
    role: block.role,
    category: block.category,
    nameColumn: nameCol + 1,
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
 * Applies one session: ticks the roster and appends walk-in trial students.
 *
 * Everything is verified against the sheet as it is right now. The kiosk sends
 * the row it read earlier, but rows move whenever the school inserts a line,
 * so a row is only written when the name still sitting there is the one the
 * kiosk thinks it is. Mismatches are reported, never guessed.
 */
function applySession(body, date) {
  if (!body.courseId) throw new Error('Missing courseId.');

  var target = findCourse(body.courseId, date);
  var course = target.course;
  if (!course.hasSession) {
    throw new Error('No column for ' + formatIsoDate(date) + ' in "' + course.title +
      '" (columns present: ' + (course.sessionLabels.join(', ') || 'none') + ').');
  }

  var groups = {};
  course.groups.forEach(function (group) { groups[group.key] = group; });

  var cells = [];
  var rejected = [];
  var written = 0;

  (body.marks || []).forEach(function (mark) {
    var group = groups[mark.group];
    if (!group) {
      rejected.push({ name: mark.name, reason: 'unknown group "' + mark.group + '"' });
      return;
    }
    if (!group.sessionColumn) {
      rejected.push({ name: mark.name, reason: 'no ' + formatIsoDate(date) + ' column in ' + group.label });
      return;
    }
    // Leaders and followers share row numbers, so a row is only meaningful
    // inside its own block — never look one up across the whole course.
    var student = findStudent(group, mark.row);
    if (!student) {
      rejected.push({ row: mark.row, name: mark.name, reason: 'row is no longer a roster row in ' + group.label });
      return;
    }
    if (normalize(student.name) !== normalize(mark.name)) {
      rejected.push({ row: mark.row, name: mark.name, reason: 'row now holds "' + student.name + '"' });
      return;
    }
    cells.push({ row: mark.row, column: group.sessionColumn, value: mark.present === true });
    written++;
  });

  var added = [];
  (body.additions || []).forEach(function (addition) {
    var name = cleanText(addition.name);
    var group = groups[addition.role + ':trial'];
    if (!name) {
      rejected.push({ reason: 'a walk-in was sent with no name' });
      return;
    }
    if (!group || !group.sessionColumn) {
      rejected.push({ name: name, reason: 'no trial block with a ' + formatIsoDate(date) + ' column for ' + addition.role });
      return;
    }
    if (!group.freeSlots.length) {
      rejected.push({ name: name, reason: 'no free row left in ' + group.label });
      return;
    }
    var slot = group.freeSlots.shift();
    cells.push({ row: slot.row, column: group.nameColumn, value: name });
    cells.push({ row: slot.row, column: group.sessionColumn, value: addition.present !== false });
    added.push({ row: slot.row, name: name, role: addition.role });
  });

  writeCells(target.sheet, cells);
  SpreadsheetApp.flush();

  return {
    courseId: course.id,
    course: course.title,
    date: formatIsoDate(date),
    written: written,
    added: added,
    rejected: rejected
  };
}

function findStudent(group, row) {
  for (var i = 0; i < group.students.length; i++) {
    if (group.students[i].row === row) return group.students[i];
  }
  return null;
}

/** Re-reads the workbook and returns the course the kiosk is submitting for. */
function findCourse(courseId, date) {
  var parts = String(courseId).split('::');
  if (parts.length !== 3) throw new Error('Malformed courseId.');

  var book = SpreadsheetApp.openById(parts[0]);
  var sheet = book.getSheetByName(parts[1]);
  if (!sheet) throw new Error('Sheet "' + parts[1] + '" not found.');

  var courses = scanSheet(book.getId(), sheet.getName(), sheet.getDataRange(), date);
  for (var i = 0; i < courses.length; i++) {
    if (courses[i].id === courseId) return { sheet: sheet, course: courses[i] };
  }
  throw new Error('Course "' + courseId + '" not found — the sheet layout changed.');
}

/**
 * Writes the cells, grouped into contiguous runs so one submission costs a
 * handful of range writes instead of one per student. Only the listed rows are
 * touched, so the totals formulas between the blocks are never in a run.
 */
function writeCells(sheet, cells) {
  var byColumn = {};
  cells.forEach(function (cell) {
    var key = String(cell.column);
    if (!byColumn[key]) byColumn[key] = [];
    byColumn[key].push(cell);
  });

  Object.keys(byColumn).forEach(function (key) {
    var column = Number(key);
    var sorted = byColumn[key].sort(function (a, b) { return a.row - b.row; });
    var run = [];
    var runStart = null;

    var flush = function () {
      if (!run.length) return;
      sheet.getRange(runStart, column, run.length, 1)
        .setValues(run.map(function (value) { return [value]; }));
      run = [];
      runStart = null;
    };

    sorted.forEach(function (cell) {
      if (runStart !== null && cell.row === runStart + run.length) {
        run.push(cell.value);
      } else {
        flush();
        runStart = cell.row;
        run = [cell.value];
      }
    });
    flush();
  });
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
