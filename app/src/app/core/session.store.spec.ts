import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiService } from './api.service';
import { SessionStore, todayIso } from './session.store';
import { isoFromSessionKey } from './format';
import {
  Course,
  Group,
  Operation,
  OperationResult,
  SessionColumn,
  SessionPayload,
  Student,
} from './models';

/**
 * The announced/arrived split, which is the one piece of this app that can
 * destroy a record rather than fail to write one.
 *
 * The school ticks a name in advance when a student says they will come, so a
 * TRUE in the workbook carries two meanings. Everything here checks that the app
 * separates them without ever offering to erase a real attendance.
 */

function student(row: number, name: string, present: boolean | null): Student {
  return { row, number: row, name, present, comment: '' };
}

const DEFAULT_COLUMNS: SessionColumn[] = [{ column: 5, key: '08-25', label: '25.08' }];

function group(
  students: Student[],
  columns: SessionColumn[] = DEFAULT_COLUMNS,
  key = 'leader:active',
): Group {
  return {
    key,
    label: 'Leaders actifs',
    role: 'leader',
    category: 'active',
    nameColumn: 2,
    sessionColumn: 5,
    commentColumn: 9,
    sessionColumns: columns,
    students,
    freeSlots: [],
  };
}

/** One block per column set, so a date shared by two halves can be checked. */
function course(students: Student[], columnSets?: SessionColumn[][]): Course {
  const groups = columnSets
    ? columnSets.map((columns, index) => group(index ? [] : students, columns, `block:${index}`))
    : [group(students)];
  return {
    id: 'book::Feuille 1::3',
    spreadsheetId: 'book',
    sheetName: 'Feuille 1',
    title: 'Julio & Diana - inter',
    titleRow: 3,
    hidden: false,
    hasSession: true,
    sessionLabels: ['25.08'],
    groups,
  };
}

function payload(
  date: string,
  students: Student[],
  columnSets?: SessionColumn[][],
): SessionPayload {
  return { date, dateKey: date.slice(5), courses: [course(students, columnSets)] };
}

/** Records what the backend would have been asked to write. */
class FakeApi {
  sent: Operation[] = [];
  next: SessionPayload = payload(todayIso(), []);

  readonly demo = () => false;

  async session(): Promise<SessionPayload> {
    return structuredClone(this.next);
  }

  async run(ops: Operation[]): Promise<OperationResult[]> {
    this.sent.push(...ops);
    return ops.map(() => ({ ok: true }));
  }
}

/** Lets the fire-and-forget queue drain before anything is asserted. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SessionStore — announced versus arrived', () => {
  let api: FakeApi;
  let store: SessionStore;

  beforeEach(() => {
    localStorage.clear();
    api = new FakeApi();
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    store = TestBed.inject(SessionStore);
  });

  const only = () => store.courses()[0];
  const first = () => only().groups[0];

  it('reads a tick already in the workbook as announced, not as arrived', async () => {
    api.next = payload(todayIso(), [student(10, 'Marie', true), student(11, 'Paul', false)]);
    await store.load();

    const marie = first().students[0];
    expect(store.isAnnounced(only().id, first(), marie)).toBe(true);
    expect(store.isPresent(only().id, first(), marie)).toBe(false);
    expect(store.tally().present).toBe(0);
  });

  it('lists exactly the announced students nobody ticked', async () => {
    api.next = payload(todayIso(), [
      student(10, 'Marie', true),
      student(11, 'Paul', true),
      student(12, 'Sofia', false),
    ]);
    await store.load();

    expect(store.noShows(only()).map((entry) => entry.student.name)).toEqual(['Marie', 'Paul']);
  });

  it('drops an announced student off the list as soon as they are ticked in', async () => {
    api.next = payload(todayIso(), [student(10, 'Marie', true)]);
    await store.load();

    store.mark(only(), first(), first().students[0], true);
    await settle();

    expect(store.isAnnounced(only().id, first(), first().students[0])).toBe(false);
    expect(store.isPresent(only().id, first(), first().students[0])).toBe(true);
    expect(store.noShows(only())).toEqual([]);
  });

  /**
   * The load-bearing one. Recomputing on every load would turn a tick made
   * since — from this device or the other teacher's phone — into an
   * announcement, and offer to erase it.
   */
  it('never re-reads announcements after the first load of a date', async () => {
    api.next = payload(todayIso(), [student(10, 'Marie', false)]);
    await store.load();

    // Somebody ticked Marie in from the other phone; the sheet now says TRUE.
    api.next = payload(todayIso(), [student(10, 'Marie', true)]);
    await store.load();

    expect(store.isAnnounced(only().id, first(), first().students[0])).toBe(false);
    expect(store.isPresent(only().id, first(), first().students[0])).toBe(true);
    expect(store.noShows(only())).toEqual([]);
  });

  /**
   * A date opened for the first time after the fact holds the record of a class
   * that already happened. Reading its ticks as announcements would offer to
   * mark the whole class absent.
   */
  it('announces nothing on a date it never saw being taught', async () => {
    api.next = payload('2026-08-18', [student(10, 'Marie', true), student(11, 'Paul', true)]);
    store.date.set('2026-08-18');
    await store.load();

    expect(store.noShows(only())).toEqual([]);
    expect(store.isPresent(only().id, first(), first().students[0])).toBe(true);
  });

  it('writes FALSE for the chosen no-shows and for nobody else', async () => {
    api.next = payload(todayIso(), [
      student(10, 'Marie', true),
      student(11, 'Paul', true),
      student(12, 'Sofia', true),
    ]);
    await store.load();
    api.sent = [];

    const pending = store.noShows(only());
    store.closeSession(
      only(),
      pending.filter((entry) => entry.student.name !== 'Paul'),
    );
    await settle();

    expect(api.sent.map((op) => [op.name, op.present])).toEqual([
      ['Marie', false],
      ['Sofia', false],
    ]);
  });

  it('leaves an announced student alone when the teacher unticks them from the list', async () => {
    api.next = payload(todayIso(), [student(10, 'Marie', true)]);
    await store.load();
    api.sent = [];

    store.closeSession(only(), []);
    await settle();

    expect(api.sent).toEqual([]);
    expect(store.isAnnounced(only().id, first(), first().students[0])).toBe(true);
  });
});

/**
 * The date list, which replaced a calendar: only a date the grid names can be
 * written to, so only those are offered.
 */
describe('SessionStore — the dates on offer', () => {
  let api: FakeApi;
  let store: SessionStore;

  beforeEach(() => {
    localStorage.clear();
    api = new FakeApi();
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    store = TestBed.inject(SessionStore);
  });

  it('lists the workbook columns in date order, and the date on screen with them', async () => {
    api.next = payload(todayIso(), [student(10, 'Marie', false)], [
      [
        { column: 6, key: '09-08', label: '08.09' },
        { column: 5, key: '09-01', label: '01.09' },
      ],
    ]);
    await store.load();

    const expected = [
      ...new Set([isoFromSessionKey('09-01'), isoFromSessionKey('09-08'), todayIso()]),
    ].sort();
    expect(store.sessionDates()).toEqual(expected);
  });

  it('names a date once, however many blocks carry its column', async () => {
    api.next = payload(todayIso(), [student(10, 'Marie', false)], [
      [{ column: 5, key: '09-01', label: '01.09' }],
      [{ column: 12, key: '09-01', label: '01.09' }],
    ]);
    await store.load();

    expect(store.sessionDates().filter((iso) => iso === isoFromSessionKey('09-01'))).toHaveLength(
      1,
    );
  });

  /** A header the parser could not date is no use as a destination. */
  it('drops a column whose header names no day', async () => {
    api.next = payload(todayIso(), [student(10, 'Marie', false)], [
      [{ column: 5, key: '02-30', label: 'rattrapage' }],
    ]);
    await store.load();

    expect(store.sessionDates()).toEqual([todayIso()]);
  });
});
