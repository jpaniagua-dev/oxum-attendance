import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import { I18nService } from './i18n';
import { isoFromSessionKey, isoOf } from './format';
import { Course, Group, Operation, Role, SessionPayload, Student } from './models';

/** A walk-in added on this device but not yet confirmed by the sheet. */
export interface Extra {
  uid: string;
  courseId: string;
  groupKey: string;
  row: number;
  name: string;
  role: Role;
}

const QUEUE_KEY = 'attendance.queue';
const RETRY_MS = 15_000;

/**
 * Everything the attendance screens read and write.
 *
 * The central decision here is that a tap is applied locally first and sent
 * immediately after, rather than gathered into an end-of-class submission.
 * Students arrive one at a time across the whole hour and whoever is teaching
 * may never press a button, so nothing may depend on a final action.
 *
 * A tap therefore has three lives: an optimistic flag on screen, an entry in a
 * durable queue, and — once the network cooperates — a cell in the workbook.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly api = inject(ApiService);
  private readonly i18n = inject(I18nService);

  readonly date = signal(todayIso());
  readonly courses = signal<Course[]>([]);
  readonly courseId = signal<string | null>(null);

  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  /** True when the roster on screen came from this device, not the studio. */
  readonly stale = signal(false);

  readonly queue = signal<Operation[]>(readJson(QUEUE_KEY, [] as Operation[]));
  readonly syncing = signal(false);
  /** Rows the sheet refused because it changed under us. Needs a human. */
  readonly conflicts = signal<string[]>([]);

  private readonly overrides = signal<Record<string, boolean>>({});
  private readonly extras = signal<Extra[]>([]);

  /**
   * Rows the workbook already had ticked when this date was first opened.
   *
   * The school ticks a name in advance when a student says they will come, so a
   * TRUE in the sheet means "announced" every bit as often as it means
   * "arrived". Nothing in the grid separates the two, and only the first load of
   * the day can: from the second one on, every tick made in the app is in the
   * sheet too and looks exactly the same.
   */
  private readonly announced = signal<Record<string, true>>({});

  /**
   * Arrival order within this session, so the person who just tapped sits at
   * the top of the present list. It is the only feedback they get that the tap
   * landed, now that nothing interrupts the screen to tell them.
   *
   * Session-only by design: the sheet stores a tick, not a time, so a reload
   * falls back to roster order for anyone marked before the app was opened.
   */
  private readonly order = signal<Record<string, number>>({});

  /** Notes edited on this device, ahead of the sheet confirming them. */
  private readonly notes = signal<Record<string, string>>({});

  readonly visibleCourses = computed(() =>
    this.courses().filter((course) => !course.hidden && !course.unreachable),
  );

  /**
   * Every session the loaded workbooks hold a column for, oldest first.
   *
   * The dates are not ours to invent: the school writes them across the top of
   * each block, and one the grid does not name is one the app refuses to write
   * to anyway. Listing them is both quicker to use than a calendar and honest
   * about what can actually be opened.
   *
   * The columns are keyed by month and day alone, so the year is inferred — see
   * `isoFromSessionKey`. Today and the selected date are always in the list even
   * when no workbook names them: the control has to be able to show where it
   * stands, and getting back to the evening being taught must never depend on a
   * second button.
   */
  readonly sessionDates = computed<string[]>(() => {
    const found = new Set<string>();
    for (const course of this.visibleCourses()) {
      for (const group of course.groups) {
        for (const column of group.sessionColumns) {
          const iso = isoFromSessionKey(column.key);
          if (iso) found.add(iso);
        }
      }
    }
    found.add(this.date());
    found.add(todayIso());
    // ISO dates sort chronologically as plain strings.
    return [...found].sort();
  });

  readonly course = computed(() => {
    const id = this.courseId();
    return this.courses().find((course) => course.id === id) ?? null;
  });

  /** Present count and roster size for the selected class, walk-ins included. */
  readonly tally = computed(() => {
    const course = this.course();
    if (!course) return { present: 0, total: 0 };
    let present = 0;
    let total = 0;
    for (const group of course.groups) {
      for (const student of group.students) {
        total++;
        if (this.isPresent(course.id, group, student)) present++;
      }
    }
    const extras = this.extrasFor(course.id).length;
    return { present: present + extras, total: total + extras };
  });

  constructor() {
    addEventListener('online', () => void this.flush());
    setInterval(() => {
      if (this.queue().length) void this.flush();
    }, RETRY_MS);
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    const date = this.date();

    try {
      const payload = await this.api.session(date);
      this.apply(payload, false);
      writeJson(cacheKey(date), payload);
    } catch (error) {
      const cached = readJson<SessionPayload | null>(cacheKey(date), null);
      if (cached) {
        // A class in a basement with no signal still needs its roster.
        this.apply(cached, true);
      } else {
        this.loadError.set(`${this.i18n.t('error.offline')} (${messageOf(error)})`);
      }
    } finally {
      this.loading.set(false);
    }
    void this.flush();
  }

  private apply(payload: SessionPayload, stale: boolean): void {
    this.date.set(payload.date);
    this.courses.set(payload.courses);
    this.stale.set(stale);
    this.overrides.set(readJson(overridesKey(payload.date), {}));
    this.extras.set(readJson(extrasKey(payload.date), [] as Extra[]));
    this.order.set(readJson(orderKey(payload.date), {}));
    this.notes.set(readJson(notesKey(payload.date), {}));
    this.announced.set(captureAnnounced(payload));

    const current = this.courseId();
    if (current && !payload.courses.some((course) => course.id === current)) {
      this.courseId.set(null);
    }
  }

  select(courseId: string | null): void {
    this.courseId.set(courseId);
  }

  // -------------------------------------------------------------------------
  // Reading presence
  // -------------------------------------------------------------------------

  isPresent(courseId: string, group: Group, student: Student): boolean {
    const key = overrideKey(courseId, group.key, student.row);
    const override = this.overrides()[key];
    if (override !== undefined) return override;
    // A tick that was already there says the student announced themselves, not
    // that they walked in. Somebody still has to tap the name for that.
    if (this.announced()[key]) return false;
    return student.present === true;
  }

  /** Announced in the workbook, and nobody has confirmed or denied it here. */
  isAnnounced(courseId: string, group: Group, student: Student): boolean {
    const key = overrideKey(courseId, group.key, student.row);
    return this.announced()[key] === true && this.overrides()[key] === undefined;
  }

  /**
   * The announced students nobody ticked: the whole point of closing a session.
   *
   * Blocks with no column for this date are skipped — there is nothing to write
   * there, and `mark` would refuse anyway.
   */
  noShows(course: Course): { group: Group; student: Student }[] {
    const found: { group: Group; student: Student }[] = [];
    for (const group of course.groups) {
      if (group.sessionColumn === null) continue;
      for (const student of group.students) {
        if (this.isAnnounced(course.id, group, student)) found.push({ group, student });
      }
    }
    return found;
  }

  /** Higher means more recent; 0 for anyone already ticked when the app opened. */
  arrivalOf(courseId: string, groupKey: string, row: number): number {
    return this.order()[overrideKey(courseId, groupKey, row)] ?? 0;
  }

  /** The note as it stands here: an unsent edit wins over the loaded value. */
  commentOf(courseId: string, group: Group, student: Student): string {
    const pending = this.notes()[overrideKey(courseId, group.key, student.row)];
    return pending ?? student.comment ?? '';
  }

  extrasFor(courseId: string): Extra[] {
    return this.extras().filter((extra) => extra.courseId === courseId);
  }

  /** Free rows still available for walk-ins, minus the ones claimed locally. */
  freeSlotsFor(course: Course, role: Role): number {
    const group = course.groups.find((candidate) => candidate.key === `${role}:trial`);
    if (!group) return 0;
    const claimed = this.extrasFor(course.id).filter((extra) => extra.role === role).length;
    return Math.max(0, group.freeSlots.length - claimed);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /** Ticks or unticks one student, then pushes it towards the sheet. */
  mark(course: Course, group: Group, student: Student, present: boolean): void {
    if (group.sessionColumn === null) return;

    this.setOverride(course.id, group.key, student.row, present);
    this.recordArrival(course.id, group.key, student.row, present);
    this.enqueue({
      ...blankOperation(),
      uid: uid(),
      kind: 'mark',
      spreadsheetId: course.spreadsheetId,
      sheetName: course.sheetName,
      row: student.row,
      nameColumn: group.nameColumn,
      sessionColumn: group.sessionColumn,
      name: student.name,
      present,
      courseId: course.id,
      groupKey: group.key,
    });
  }

  /**
   * Writes the school's free-text note beside a name.
   *
   * The note lives in the same row as the student and is verified against the
   * same name, so a note about one person can never land beside another. An
   * empty string is a real value here: it clears the cell.
   */
  setComment(course: Course, group: Group, student: Student, text: string): void {
    if (group.commentColumn === null) return;

    const clean = text.trim().replace(/\s+/g, ' ');
    this.notes.update((current) => {
      const next = { ...current, [overrideKey(course.id, group.key, student.row)]: clean };
      writeJson(notesKey(this.date()), next);
      return next;
    });

    this.enqueue({
      ...blankOperation(),
      uid: uid(),
      kind: 'comment',
      spreadsheetId: course.spreadsheetId,
      sheetName: course.sheetName,
      row: student.row,
      nameColumn: group.nameColumn,
      commentColumn: group.commentColumn,
      name: student.name,
      text: clean,
      courseId: course.id,
      groupKey: group.key,
    });
  }

  /**
   * Adds a walk-in trial student to the first free row of their half.
   *
   * The row is claimed locally straight away so a second walk-in on the same
   * device does not get handed the same one; the backend still refuses the
   * write if another device got there first.
   */
  addTrial(course: Course, role: Role, name: string): { ok: boolean; reason?: string } {
    const group = course.groups.find((candidate) => candidate.key === `${role}:trial`);
    if (!group || group.sessionColumn === null) {
      return { ok: false, reason: this.i18n.t('walkin.noBlock') };
    }

    const claimed = new Set(this.extrasFor(course.id).map((extra) => extra.row));
    const slot = group.freeSlots.find((candidate) => !claimed.has(candidate.row));
    if (!slot) {
      return {
        ok: false,
        reason: this.i18n.t('walkin.full', {
          role: this.i18n.t(role === 'leader' ? 'role.leaders' : 'role.followers').toLowerCase(),
        }),
      };
    }

    const extra: Extra = {
      uid: uid(),
      courseId: course.id,
      groupKey: group.key,
      row: slot.row,
      name,
      role,
    };
    this.extras.update((current) => {
      const next = [...current, extra];
      writeJson(extrasKey(this.date()), next);
      return next;
    });

    this.recordArrival(course.id, group.key, slot.row, true);
    this.enqueue({
      ...blankOperation(),
      uid: extra.uid,
      kind: 'trial',
      spreadsheetId: course.spreadsheetId,
      sheetName: course.sheetName,
      row: slot.row,
      nameColumn: group.nameColumn,
      sessionColumn: group.sessionColumn,
      name,
      present: true,
      courseId: course.id,
      groupKey: group.key,
    });

    return { ok: true };
  }

  /**
   * Writes FALSE for the announced students the teacher confirms never came.
   *
   * This is a correction, not a submission: everything anybody tapped is in the
   * workbook already, so forgetting to close a session loses these corrections
   * and nothing else. That is what keeps the promise of the per-tap design —
   * nothing depends on somebody pressing a final button.
   *
   * It only ever touches cells this device sees as announced-and-unconfirmed,
   * so a colleague's tick on the other phone cannot be turned into an absence:
   * their tick is not an announcement here. What it can do is offer to mark
   * somebody absent who was confirmed elsewhere — which is why the caller shows
   * the names and has them ticked off one by one rather than asking yes or no.
   */
  closeSession(course: Course, targets: { group: Group; student: Student }[]): void {
    for (const target of targets) {
      this.mark(course, target.group, target.student, false);
    }
  }

  dismissConflicts(): void {
    this.conflicts.set([]);
  }

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  private enqueue(op: Operation): void {
    this.queue.update((current) => {
      // Tapping twice, or retyping a note, should send one final state. A
      // walk-in is never superseded: each one is a different person.
      const next =
        op.kind === 'trial'
          ? [...current, op]
          : [...current.filter((existing) => !sameCell(existing, op)), op];
      writeJson(QUEUE_KEY, next);
      return next;
    });
    void this.flush();
  }

  /**
   * Sends the queue as one batch.
   *
   * Every operation is reported on independently, so a row the school moved
   * under us fails alone: it is dropped from the queue, its optimistic tick is
   * rolled back, and the conflict is raised for a human. Anything that never
   * got an answer stays queued for the next attempt.
   */
  async flush(): Promise<void> {
    if (this.syncing() || !this.queue().length) return;

    const batch = this.queue();
    this.syncing.set(true);
    let delivered = false;
    try {
      const results = await this.api.run(batch);
      const failed: Operation[] = [];
      const conflicts: string[] = [];

      batch.forEach((op, index) => {
        const result = results[index];
        if (!result) {
          failed.push(op);
          return;
        }
        if (result.ok) return;
        if (result.stale) {
          this.rollback(op);
          conflicts.push(`${op.name} — ${result.reason ?? 'ligne modifiée'}`);
          return;
        }
        failed.push(op);
      });

      this.queue.update((current) => {
        const handled = new Set(batch.map((op) => op.uid));
        const kept = current.filter((op) => !handled.has(op.uid));
        // A tap that happened while the batch was in flight already holds the
        // final state of that cell. Re-queuing the failed older operation would
        // write the stale value last and undo it.
        const superseded = new Set(
          kept.filter((op) => op.kind !== 'trial').map(cellKey),
        );
        const retry = failed.filter(
          (op) => op.kind === 'trial' || !superseded.has(cellKey(op)),
        );
        const next = [...kept, ...retry];
        writeJson(QUEUE_KEY, next);
        return next;
      });

      if (conflicts.length) {
        this.conflicts.update((current) => [...current, ...conflicts]);
        await this.load();
      }
      delivered = true;
    } catch {
      // Network or endpoint failure: keep everything and try again later.
    } finally {
      this.syncing.set(false);
    }

    // Whatever was enqueued while this batch was in flight met the guard above
    // and went nowhere. Send it now rather than leaving it for the retry tick:
    // closing a session enqueues several corrections at once, and they should
    // land together instead of trickling out over the next minute. Guarded on a
    // delivered batch, so a dead network still backs off to the timer.
    if (delivered && this.queue().length) void this.flush();
  }

  private rollback(op: Operation): void {
    if (op.kind === 'mark') {
      this.setOverride(op.courseId, op.groupKey, op.row, !op.present);
      this.recordArrival(op.courseId, op.groupKey, op.row, !op.present);
      return;
    }
    if (op.kind === 'comment') {
      // Drop the local edit; the reload that follows restores the sheet's text.
      this.notes.update((current) => {
        const next = { ...current };
        delete next[overrideKey(op.courseId, op.groupKey, op.row)];
        writeJson(notesKey(this.date()), next);
        return next;
      });
      return;
    }
    this.extras.update((current) => {
      const next = current.filter((extra) => extra.uid !== op.uid);
      writeJson(extrasKey(this.date()), next);
      return next;
    });
  }

  private recordArrival(courseId: string, groupKey: string, row: number, present: boolean): void {
    this.order.update((current) => {
      const key = overrideKey(courseId, groupKey, row);
      const next = { ...current };
      if (present) {
        next[key] = Math.max(0, ...Object.values(current)) + 1;
      } else {
        delete next[key];
      }
      writeJson(orderKey(this.date()), next);
      return next;
    });
  }

  private setOverride(courseId: string, groupKey: string, row: number, present: boolean): void {
    this.overrides.update((current) => {
      const next = { ...current, [overrideKey(courseId, groupKey, row)]: present };
      writeJson(overridesKey(this.date()), next);
      return next;
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Works out who was announced, once per date, and remembers it.
 *
 * Two rules, and the second one is the load-bearing one:
 *
 * - The answer is computed on the first load of a date and read back ever
 *   after. Recomputing it would turn every tick made since — including the ones
 *   made from the other teacher's phone — into an announcement, and offer to
 *   erase them.
 * - A date opened for the first time when it is no longer today yields nothing.
 *   Its ticks are the record of a class that already happened; reading them as
 *   announcements would propose marking the entire class absent. A date that
 *   *was* opened while it was being taught keeps its stored answer, so closing
 *   it the next morning still works.
 */
function captureAnnounced(payload: SessionPayload): Record<string, true> {
  const stored = readJson<Record<string, true> | null>(announcedKey(payload.date), null);
  if (stored) return stored;
  if (payload.date !== todayIso()) return {};

  const rows: Record<string, true> = {};
  for (const course of payload.courses) {
    for (const group of course.groups) {
      for (const student of group.students) {
        if (student.present === true) {
          rows[overrideKey(course.id, group.key, student.row)] = true;
        }
      }
    }
  }
  writeJson(announcedKey(payload.date), rows);
  return rows;
}

/**
 * Identifies the one cell an operation writes to. A tick and a note on the same
 * row are different cells, so they must never supersede one another.
 */
function cellKey(op: Operation): string {
  const column = op.kind === 'comment' ? op.commentColumn : op.sessionColumn;
  return `${op.spreadsheetId}::${op.sheetName}::${op.row}::${op.kind}::${column}`;
}

/** Every field an operation carries, so each builder only sets what it means. */
function blankOperation(): Operation {
  return {
    uid: '',
    kind: 'mark',
    spreadsheetId: '',
    sheetName: '',
    row: 0,
    nameColumn: 0,
    sessionColumn: null,
    commentColumn: null,
    name: '',
    present: false,
    text: '',
    courseId: '',
    groupKey: '',
  };
}

function sameCell(a: Operation, b: Operation): boolean {
  return cellKey(a) === cellKey(b);
}

function overrideKey(courseId: string, groupKey: string, row: number): string {
  return `${courseId}|${groupKey}#${row}`;
}

function cacheKey(date: string): string {
  return `attendance.session.${date}`;
}

function overridesKey(date: string): string {
  return `attendance.overrides.${date}`;
}

function extrasKey(date: string): string {
  return `attendance.extras.${date}`;
}

function orderKey(date: string): string {
  return `attendance.order.${date}`;
}

function notesKey(date: string): string {
  return `attendance.notes.${date}`;
}

function announcedKey(date: string): string {
  return `attendance.announced.${date}`;
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function todayIso(): string {
  return isoOf(new Date());
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing we can do; the in-memory state still drives this session.
  }
}
