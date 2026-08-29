import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { I18nService } from '../../core/i18n';
import { SessionStore, todayIso } from '../../core/session.store';
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
  /** The only things a card says beyond the name, and only when true. */
  trial: boolean;
  announced: boolean;
  noted: boolean;
  arrival: number;
  category: Category;
  /** Absent for a walk-in: it is already written to the sheet and stays. */
  group: Group | null;
  student: Student | null;
}

/** One run of names under a rule: expected, then arrived. */
interface Block {
  label: string;
  present: boolean;
  entries: Entry[];
}

/** Half the room. Leaders on the left, followers on the right. */
interface RoleColumn {
  role: Role;
  label: string;
  size: number;
  blocks: Block[];
}

/** One side of the arrivals gauge. */
interface Side {
  here: number;
  total: number;
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
 * There is no confirmation dialog and nothing moves the page under the reader:
 * the tapped card simply leaves the expected list for the present one further
 * down, and the count in the sticky header goes up. A card that stays on screen
 * also holds a highlight for a moment. Scrolling the page for them was worse
 * than the problem it solved — the screen jumped under a finger that was about
 * to hand the phone over.
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

  /**
   * The teacher panel: the date and the end-of-class correction, behind one
   * control instead of on the screen a student is handed. It is closed by any
   * tap in the list below, for the same reason the settings screen re-locks on
   * every exit — the phone changes hands mid-class.
   */
  protected readonly panelOpen = signal(false);

  protected readonly closing = signal(false);
  protected readonly closePicked = signal<ReadonlySet<string>>(new Set<string>());
  protected readonly closePin = signal('');
  protected readonly closeError = signal<string | null>(null);

  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressOrigin: { x: number; y: number } | null = null;
  private longPressed = false;

  protected readonly course = this.store.course;
  protected readonly date = computed(() => longDate(this.store.date(), this.i18n.locale()));
  protected readonly tally = this.store.tally;

  /**
   * The room in two halves: leaders on the left, followers on the right.
   *
   * That is how the school's own workbook lays a class out, and it is the one
   * thing a student knows about themselves before they know anything else — so
   * it halves the list they have to read, and keeps both halves on screen at
   * once instead of stacked a scroll apart. Enrolled, trial and assisting
   * students share a column: someone hunting for their name cares which side
   * they dance, not which category the school files them under.
   *
   * Inside a column, expected sits above arrived. The first is the task, the
   * second is the record.
   */
  protected readonly columns = computed<RoleColumn[]>(() => {
    const course = this.course();
    if (!course) return [];

    const needle = fold(this.search());
    const waiting: Record<Role, Entry[]> = { leader: [], follower: [] };
    const present: Record<Role, Entry[]> = { leader: [], follower: [] };

    for (const group of course.groups) {
      for (const student of group.students) {
        if (needle && !fold(student.name).includes(needle)) continue;
        const entry = this.entryOf(course, group, student);
        const side = this.store.isPresent(course.id, group, student) ? present : waiting;
        side[group.role].push(entry);
      }
    }

    // A walk-in is present by definition, and always a trial.
    for (const extra of this.store.extrasFor(course.id)) {
      if (needle && !fold(extra.name).includes(needle)) continue;
      present[extra.role].push({
        key: `extra#${extra.uid}`,
        name: extra.name,
        trial: true,
        announced: false,
        noted: false,
        arrival: this.store.arrivalOf(course.id, extra.groupKey, extra.row),
        category: 'trial',
        group: null,
        student: null,
      });
    }

    return (['leader', 'follower'] as Role[]).map((role) => {
      const blocks: Block[] = [];
      if (waiting[role].length) {
        blocks.push({
          label: this.t('roster.waiting'),
          present: false,
          entries: waiting[role].sort(byRosterOrder),
        });
      }
      if (present[role].length) {
        blocks.push({
          label: this.t('roster.present'),
          present: true,
          entries: present[role].sort(byArrival),
        });
      }
      return {
        role,
        label: this.roleLabel(role),
        size: waiting[role].length + present[role].length,
        blocks,
      };
    });
  });

  /**
   * Arrivals per role, ignoring the search field.
   *
   * One total says almost nothing about a partner dance: a class with every
   * leader in the room and half the followers missing cannot be taught in
   * pairs. The two sides are therefore counted apart and drawn facing each
   * other, so the imbalance is a shape rather than a subtraction to do in your
   * head while thirty people wait.
   */
  protected readonly balance = computed<Record<Role, Side>>(() => {
    const tally: Record<Role, Side> = {
      leader: { here: 0, total: 0 },
      follower: { here: 0, total: 0 },
    };
    const course = this.course();
    if (!course) return tally;

    for (const group of course.groups) {
      for (const student of group.students) {
        tally[group.role].total++;
        if (this.store.isPresent(course.id, group, student)) tally[group.role].here++;
      }
    }
    for (const extra of this.store.extrasFor(course.id)) {
      tally[extra.role].here++;
      tally[extra.role].total++;
    }
    return tally;
  });

  /** Both wings share one scale, so the shorter side reads as the shorter side. */
  private peak(): number {
    const { leader, follower } = this.balance();
    return Math.max(leader.total, follower.total, 1);
  }

  /** How far the solid part of a wing reaches: who is actually here. */
  protected share(side: Side): number {
    return Math.round((side.here / this.peak()) * 100);
  }

  /**
   * The announced students nobody ticked, ignoring the search field: closing a
   * session is about the whole class, not about what is on screen right now.
   */
  protected readonly noShows = computed(() => {
    const course = this.course();
    if (!course) return [];
    return this.store.noShows(course).map(({ group, student }) => ({
      key: `${group.key}#${student.row}`,
      name: student.name,
      group,
      student,
    }));
  });

  private readonly shown = computed(() =>
    this.columns().reduce((total, column) => total + column.size, 0),
  );

  protected readonly nothingFound = computed(() => this.search().length > 0 && !this.shown());

  protected readonly isEmpty = computed(() => !this.search() && !this.shown());

  /** The dates the workbooks name — the app never invents one. */
  protected readonly dateOptions = computed(() =>
    this.store.sessionDates().map((iso) => ({ iso, label: longDate(iso, this.i18n.locale()) })),
  );

  protected readonly isToday = computed(() => this.store.date() === todayIso());

  constructor() {
    // Only the route id is a dependency: reading the course list untracked
    // keeps a reload from re-running this and shutting the panel on the teacher
    // in the middle of picking a date.
    effect(() => {
      const id = this.routeId();
      if (!id) return;
      untracked(() => {
        this.store.select(id);
        this.panelOpen.set(false);
        if (!this.store.courses().length && this.settings.configured()) {
          void this.store.load();
        }
      });
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
      announced: this.store.isAnnounced(course.id, group, student),
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
  protected tap(present: boolean, entry: Entry): void {
    if (this.consumeLongPress()) return;
    if (!entry.group || !entry.student) return;

    const course = this.course();
    if (!course || !course.hasSession) return;

    if (present) {
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
   * Rings the moved card briefly and clears the search, so the next person
   * starts from a clean field. The page is deliberately left where it is.
   */
  private flag(key: string): void {
    this.search.set('');
    this.highlighted.set(key);

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
  // Closing the session
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // The teacher panel
  // -------------------------------------------------------------------------

  protected togglePanel(): void {
    this.panelOpen.update((open) => !open);
  }

  protected closePanel(): void {
    if (this.panelOpen()) this.panelOpen.set(false);
  }

  /**
   * Reads another date's session.
   *
   * A class is rarely closed on the spot, so the previous evening has to be
   * reachable. The panel stays open: picking a date is usually the first half
   * of correcting it. A date this app never saw being taught captured no
   * announcements, so it offers nothing to close — see `captureAnnounced`.
   */
  protected onDate(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    this.store.date.set(value);
    void this.store.load();
  }

  protected today(): void {
    this.store.date.set(todayIso());
    void this.store.load();
  }

  /**
   * Opens the correction sheet, with every no-show ticked.
   *
   * They start ticked because that is the common case — the teacher glances at
   * the names and confirms. What matters is that the names are *there*: this
   * device cannot know that a colleague ticked somebody in on the other phone,
   * so the only thing standing between that student and a false absence is a
   * human reading their name. A yes/no dialog would not have given them one.
   */
  protected openClosure(): void {
    this.panelOpen.set(false);
    this.closePicked.set(new Set(this.noShows().map((entry) => entry.key)));
    this.closePin.set('');
    this.closeError.set(null);
    this.closing.set(true);
  }

  protected cancelClosure(): void {
    this.closing.set(false);
    this.closePin.set('');
  }

  protected togglePicked(key: string): void {
    this.closePicked.update((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  protected isPicked(key: string): boolean {
    return this.closePicked().has(key);
  }

  protected onClosePin(event: Event): void {
    this.closePin.set((event.target as HTMLInputElement).value);
    this.closeError.set(null);
  }

  protected confirmClosure(event: Event): void {
    event.preventDefault();
    const course = this.course();
    if (!course) return;

    // `matches` rather than `unlock`: the same four digits, but closing a
    // session must not leave the settings screen open behind it.
    if (this.settings.hasPin() && !this.settings.matches(this.closePin())) {
      this.closeError.set(this.t('gate.wrong'));
      return;
    }

    const chosen = this.noShows().filter((entry) => this.closePicked().has(entry.key));
    if (chosen.length) this.store.closeSession(course, chosen);
    this.closing.set(false);
    this.closePin.set('');
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  protected onSearch(event: Event): void {
    this.closePanel();
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

  protected pendingLabel(): string {
    const n = this.noShows().length;
    return this.t(n > 1 ? 'teacher.pendingMany' : 'teacher.pendingOne', { n });
  }

  protected closeConfirmLabel(): string {
    const n = this.closePicked().size;
    return this.t(n > 1 ? 'close.confirmMany' : 'close.confirmOne', { n });
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
