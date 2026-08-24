import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
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

export type SyncState = 'idle' | 'sending' | 'pending' | 'offline';

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

  readonly visibleCourses = computed(() =>
    this.courses().filter((course) => !course.hidden && !course.unreachable),
  );

  readonly course = computed(() => {
    const id = this.courseId();
    return this.courses().find((course) => course.id === id) ?? null;
  });

  readonly sync = computed<SyncState>(() => {
    if (this.syncing()) return 'sending';
    if (!this.queue().length) return 'idle';
    return navigator.onLine ? 'pending' : 'offline';
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
        this.loadError.set(messageOf(error));
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
    const override = this.overrides()[overrideKey(courseId, group.key, student.row)];
    return override ?? student.present === true;
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
    this.enqueue({
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
   * Adds a walk-in trial student to the first free row of their half.
   *
   * The row is claimed locally straight away so a second walk-in on the same
   * device does not get handed the same one; the backend still refuses the
   * write if another device got there first.
   */
  addTrial(course: Course, role: Role, name: string): { ok: boolean; reason?: string } {
    const group = course.groups.find((candidate) => candidate.key === `${role}:trial`);
    if (!group || group.sessionColumn === null) {
      return { ok: false, reason: "Ce cours n'a pas de bloc d'essai utilisable aujourd'hui." };
    }

    const claimed = new Set(this.extrasFor(course.id).map((extra) => extra.row));
    const slot = group.freeSlots.find((candidate) => !claimed.has(candidate.row));
    if (!slot) {
      return { ok: false, reason: `Plus de ligne libre pour les essais ${labelOfRole(role)}.` };
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

    this.enqueue({
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

  dismissConflicts(): void {
    this.conflicts.set([]);
  }

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  private enqueue(op: Operation): void {
    this.queue.update((current) => {
      // A student tapping twice should send one final state, not a pile.
      const withoutSameCell = current.filter(
        (existing) => !(existing.kind === 'mark' && sameCell(existing, op)),
      );
      const next = op.kind === 'mark' ? [...withoutSameCell, op] : [...current, op];
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
        const next = [...current.filter((op) => !handled.has(op.uid)), ...failed];
        writeJson(QUEUE_KEY, next);
        return next;
      });

      if (conflicts.length) {
        this.conflicts.update((current) => [...current, ...conflicts]);
        await this.load();
      }
    } catch {
      // Network or endpoint failure: keep everything and try again later.
    } finally {
      this.syncing.set(false);
    }
  }

  private rollback(op: Operation): void {
    if (op.kind === 'mark') {
      this.setOverride(op.courseId, op.groupKey, op.row, !op.present);
      return;
    }
    this.extras.update((current) => {
      const next = current.filter((extra) => extra.uid !== op.uid);
      writeJson(extrasKey(this.date()), next);
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

function sameCell(a: Operation, b: Operation): boolean {
  return (
    a.spreadsheetId === b.spreadsheetId &&
    a.sheetName === b.sheetName &&
    a.row === b.row &&
    a.sessionColumn === b.sessionColumn
  );
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

function labelOfRole(role: Role): string {
  return role === 'leader' ? 'leaders' : 'followers';
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function todayIso(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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
