import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { I18nService } from '../../core/i18n';
import { SessionStore } from '../../core/session.store';
import { SettingsService } from '../../core/settings.service';
import { fold, longDate } from '../../core/format';
import { LangSwitch } from '../../ui/lang-switch';
import { Category, Course, Group, Role, Student } from '../../core/models';

/** Enrolled first, then trials, then assistants — the school's own order. */
const CATEGORY_ORDER: Category[] = ['active', 'trial', 'helper'];

/** How long a freshly moved card stays highlighted. */
const HIGHLIGHT_MS = 1800;

/** Press-and-hold before a card opens its note instead of marking presence. */
const LONG_PRESS_MS = 550;

/** Past this much finger travel it is a scroll, not a hold. */
const PRESS_SLOP = 10;

interface Entry {
  key: string;
  name: string;
  /** The only thing a card says beyond the name, and only when true. */
  trial: boolean;
  noted: boolean;
  arrival: number;
  category: Category;
  /** Absent for a walk-in: it is already written to the sheet and stays. */
  group: Group | null;
  student: Student | null;
}

interface Section {
  key: string;
  label: string;
  present: boolean;
  entries: Entry[];
}

/**
 * The screen a student is handed on arrival.
 *
 * Everything here follows from students trickling in one at a time: a search
 * field so the teacher can say "cherche ton nom", a tap that reaches the sheet
 * on its own, and a list split four ways — here or expected, leader or
 * follower. Enrolled, trial and assisting students share those lists rather
 * than getting blocks of their own: someone hunting for their name cares which
 * side they dance, not which category the school files them under.
 *
 * There is no confirmation dialog. The tapped name leaves the expected list and
 * appears at the top of the matching present one, the page scrolls up to it and
 * it holds a highlight for a moment — the movement itself is the receipt, and
 * nothing blocks the next person from stepping up.
 */
@Component({
  selector: 'app-roster',
  imports: [RouterLink, LangSwitch],
  templateUrl: './roster.html',
  styleUrl: './roster.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Roster {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly store = inject(SessionStore);
  protected readonly settings = inject(SettingsService);
  protected readonly api = inject(ApiService);
  protected readonly i18n = inject(I18nService);

  protected readonly t = this.i18n.t.bind(this.i18n);

  private readonly routeId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' },
  );

  protected readonly search = signal('');
  protected readonly highlighted = signal<string | null>(null);
  protected readonly untick = signal<{ group: Group; student: Student } | null>(null);

  protected readonly walkinOpen = signal(false);
  protected readonly walkinName = signal('');
  protected readonly walkinRole = signal<Role | null>(null);
  protected readonly walkinError = signal<string | null>(null);

  protected readonly noteFor = signal<{ group: Group; student: Student } | null>(null);
  protected readonly noteText = signal('');

  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressOrigin: { x: number; y: number } | null = null;
  private longPressed = false;

  protected readonly course = this.store.course;
  protected readonly date = computed(() => longDate(this.store.date(), this.i18n.locale()));
  protected readonly tally = this.store.tally;

  /**
   * Four lists: here and expected, each split leader and follower. Empty ones
   * are dropped, so a class with no enrolled leaders shows three.
   */
  protected readonly sections = computed<Section[]>(() => {
    const course = this.course();
    if (!course) return [];

    const needle = fold(this.search());
    const buckets = new Map<string, Entry[]>();
    const push = (present: boolean, role: Role, entry: Entry) => {
      const key = `${present ? 'present' : 'waiting'}:${role}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(entry);
      else buckets.set(key, [entry]);
    };

    for (const group of course.groups) {
      for (const student of group.students) {
        if (needle && !fold(student.name).includes(needle)) continue;
        push(
          this.store.isPresent(course.id, group, student),
          group.role,
          this.entryOf(course, group, student),
        );
      }
    }

    // A walk-in is present by definition, and always a trial.
    for (const extra of this.store.extrasFor(course.id)) {
      if (needle && !fold(extra.name).includes(needle)) continue;
      push(true, extra.role, {
        key: `extra#${extra.uid}`,
        name: extra.name,
        trial: true,
        noted: false,
        arrival: this.store.arrivalOf(course.id, extra.groupKey, extra.row),
        category: 'trial',
        group: null,
        student: null,
      });
    }

    const order: { key: string; present: boolean; role: Role }[] = [
      { key: 'present:leader', present: true, role: 'leader' },
      { key: 'present:follower', present: true, role: 'follower' },
      { key: 'waiting:leader', present: false, role: 'leader' },
      { key: 'waiting:follower', present: false, role: 'follower' },
    ];

    return order
      .map(({ key, present, role }) => ({
        key,
        present,
        label: `${this.t(present ? 'roster.present' : 'roster.waiting')} — ${this.roleLabel(role)}`,
        entries: (buckets.get(key) ?? []).sort(present ? byArrival : byRosterOrder),
      }))
      .filter((section) => section.entries.length > 0);
  });

  protected readonly nothingFound = computed(
    () => this.search().length > 0 && !this.sections().length,
  );

  protected readonly isEmpty = computed(() => !this.search() && !this.sections().length);

  constructor() {
    effect(() => {
      const id = this.routeId();
      if (!id) return;
      this.store.select(id);
      if (!this.store.courses().length && this.settings.configured()) {
        void this.store.load();
      }
    });

    this.destroyRef.onDestroy(() => {
      this.clearHighlight();
      this.cancelPress();
    });
  }

  private entryOf(course: Course, group: Group, student: Student): Entry {
    return {
      key: `${group.key}#${student.row}`,
      name: student.name,
      trial: group.category === 'trial',
      noted: !!this.store.commentOf(course.id, group, student),
      arrival: this.store.arrivalOf(course.id, group.key, student.row),
      category: group.category,
      group,
      student,
    };
  }

  // -------------------------------------------------------------------------
  // Marking
  // -------------------------------------------------------------------------

  /**
   * One handler for both lists: a tap on an expected name marks it, a tap on a
   * present one asks before removing. The device is handed around, and a
   * mis-tap must not quietly unmark someone standing right there.
   */
  protected tap(section: Section, entry: Entry): void {
    if (this.consumeLongPress()) return;
    if (!entry.group || !entry.student) return;

    const course = this.course();
    if (!course || !course.hasSession) return;

    if (section.present) {
      this.untick.set({ group: entry.group, student: entry.student });
      return;
    }
    this.store.mark(course, entry.group, entry.student, true);
    this.flag(entry.key);
  }

  protected confirmUntick(): void {
    const pending = this.untick();
    const course = this.course();
    if (!pending || !course) return;
    this.store.mark(course, pending.group, pending.student, false);
    this.untick.set(null);
    this.flag(`${pending.group.key}#${pending.student.row}`);
  }

  protected cancelUntick(): void {
    this.untick.set(null);
  }

  /**
   * Puts the moved card at the top of the screen and rings it briefly, then
   * clears the search so the next person starts from a clean field.
   */
  private flag(key: string): void {
    this.search.set('');
    this.highlighted.set(key);

    scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });

    this.clearHighlight();
    this.highlightTimer = setTimeout(() => {
      this.highlighted.set(null);
      this.highlightTimer = null;
    }, HIGHLIGHT_MS);
  }

  private clearHighlight(): void {
    if (this.highlightTimer !== null) {
      clearTimeout(this.highlightTimer);
      this.highlightTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Long press
  // -------------------------------------------------------------------------

  /**
   * Press and hold a name to reach its note.
   *
   * The note is a teacher's aside — "actually dances as a leader" — so it does
   * not deserve a control on every card competing with the one thing students
   * are asked to do. Holding is deliberate enough that nobody opens it by
   * accident, and the hold is abandoned as soon as the finger travels, which is
   * what scrolling a long list looks like.
   */
  protected onPressStart(event: PointerEvent, entry: Entry): void {
    this.cancelPress();
    this.longPressed = false;

    const group = entry.group;
    const student = entry.student;
    if (!group || !student || !group.commentColumn) return;

    this.pressOrigin = { x: event.clientX, y: event.clientY };
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.longPressed = true;
      this.openNote(group, student);
    }, LONG_PRESS_MS);
  }

  protected onPressMove(event: PointerEvent): void {
    const origin = this.pressOrigin;
    if (!origin) return;
    const travelled = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
    if (travelled > PRESS_SLOP) this.cancelPress();
  }

  protected onPressEnd(): void {
    this.cancelPress();
  }

  private cancelPress(): void {
    if (this.pressTimer !== null) {
      clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
    this.pressOrigin = null;
  }

  /** A hold is followed by a click; that click must not also mark the student. */
  private consumeLongPress(): boolean {
    if (!this.longPressed) return false;
    this.longPressed = false;
    return true;
  }

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  protected openNote(group: Group, student: Student): void {
    const course = this.course();
    this.noteText.set(course ? this.store.commentOf(course.id, group, student) : '');
    this.noteFor.set({ group, student });
  }

  protected closeNote(): void {
    this.noteFor.set(null);
  }

  protected onNoteText(event: Event): void {
    this.noteText.set((event.target as HTMLTextAreaElement).value);
  }

  protected saveNote(event: Event): void {
    event.preventDefault();
    const target = this.noteFor();
    const course = this.course();
    if (!target || !course) return;

    this.store.setComment(course, target.group, target.student, this.noteText());
    this.noteFor.set(null);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected clearSearch(): void {
    this.search.set('');
  }

  // -------------------------------------------------------------------------
  // Walk-ins
  // -------------------------------------------------------------------------

  protected openWalkin(): void {
    this.walkinName.set(this.search());
    this.walkinRole.set(null);
    this.walkinError.set(null);
    this.walkinOpen.set(true);
  }

  protected closeWalkin(): void {
    this.walkinOpen.set(false);
  }

  protected onWalkinName(event: Event): void {
    this.walkinName.set((event.target as HTMLInputElement).value);
  }

  protected chooseRole(role: Role): void {
    this.walkinRole.set(role);
  }

  protected submitWalkin(event: Event): void {
    event.preventDefault();
    const course = this.course();
    const role = this.walkinRole();
    const name = this.walkinName().trim().replace(/\s+/g, ' ');

    if (!course || !role || !name) {
      this.walkinError.set(this.t('walkin.error'));
      return;
    }

    const outcome = this.store.addTrial(course, role, name);
    if (!outcome.ok) {
      this.walkinError.set(outcome.reason ?? this.t('walkin.error'));
      return;
    }

    this.walkinOpen.set(false);
    const added = this.store.extrasFor(course.id).at(-1);
    this.flag(added ? `extra#${added.uid}` : '');
  }

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  protected roleLabel(role: Role): string {
    return this.t(role === 'leader' ? 'role.leaders' : 'role.followers');
  }

  protected presentWord(count: number): string {
    return this.t(count > 1 ? 'roster.hereMany' : 'roster.hereOne');
  }

  protected syncLabel(): string {
    switch (this.store.sync()) {
      case 'sending':
        return this.t('sync.sending');
      case 'pending':
        return this.t('sync.pending', { n: this.store.queue().length });
      case 'offline':
        return this.t('sync.offline');
      default:
        return this.t('sync.idle');
    }
  }

  protected retrySync(): void {
    void this.store.flush();
  }
}

/** Most recently arrived first, so the person who just tapped is on top. */
function byArrival(a: Entry, b: Entry): number {
  return b.arrival - a.arrival;
}

/** Enrolled before trials before assistants, then the workbook's own order. */
function byRosterOrder(a: Entry, b: Entry): number {
  const byCategory = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
  if (byCategory !== 0) return byCategory;
  return (a.student?.row ?? 0) - (b.student?.row ?? 0);
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
