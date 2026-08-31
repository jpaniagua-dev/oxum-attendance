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
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { I18nService } from '../../core/i18n';
import { SessionStore } from '../../core/session.store';
import { SettingsService } from '../../core/settings.service';
import { contactLine, fold, longDate, looksLikeEmail } from '../../core/format';
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

/** How full one half of the room is: who came, out of who is on the roster. */
interface Side {
  here: number;
  total: number;
}

/** Half the room. Leaders on the left, followers on the right. */
interface RoleColumn {
  role: Role;
  label: string;
  size: number;
  blocks: Block[];
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
 * down, and the count at the head of its column goes up. A card that stays on
 * screen also holds a highlight for a moment. Scrolling the page for them was
 * worse than the problem it solved — the screen jumped under a finger that was
 * about to hand the phone over.
 */
@Component({
  selector: 'app-roster',
  imports: [LangSwitch],
  templateUrl: './roster.html',
  styleUrl: './roster.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Roster {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
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
  protected readonly walkinPhone = signal('');
  protected readonly walkinEmail = signal('');
  protected readonly walkinRole = signal<Role | null>(null);
  protected readonly walkinError = signal<string | null>(null);

  /**
   * Leaving this screen is guarded, because the class list is one tap from the
   * settings and the phone spends the hour in students' hands. The same four
   * digits as everywhere else, and — like closing a session — checked rather
   * than spent: getting out of a class must not hand out the settings screen.
   */
  protected readonly leaving = signal(false);
  protected readonly leavePin = signal('');
  protected readonly leaveError = signal<string | null>(null);

  protected readonly noteFor = signal<{ group: Group; student: Student } | null>(null);
  protected readonly noteText = signal('');

  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressOrigin: { x: number; y: number } | null = null;
  private longPressed = false;

  protected readonly course = this.store.course;
  protected readonly date = computed(() => longDate(this.store.date(), this.i18n.locale()));

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
   * Arrivals and roster size per role, ignoring the search field.
   *
   * `columns` is filtered as the teacher types, which is right for the lists
   * and wrong for a count: a class does not empty because somebody searched
   * for a name. These are counted from the course itself.
   */
  protected readonly presence = computed<Record<Role, Side>>(() => {
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
    // A walk-in is present by definition, and joins both halves of the ratio.
    for (const extra of this.store.extrasFor(course.id)) {
      tally[extra.role].here++;
      tally[extra.role].total++;
    }
    return tally;
  });

  private readonly shown = computed(() =>
    this.columns().reduce((total, column) => total + column.size, 0),
  );

  protected readonly nothingFound = computed(() => this.search().length > 0 && !this.shown());

  protected readonly isEmpty = computed(() => !this.search() && !this.shown());

  constructor() {
    // Only the route id is a dependency: reading the course list untracked
    // keeps a reload from re-running this and shutting the panel on the teacher
    // in the middle of picking a date.
    effect(() => {
      const id = this.routeId();
      if (!id) return;
      untracked(() => {
        this.store.select(id);
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
  // Leaving the class
  // -------------------------------------------------------------------------

  protected askLeave(): void {
    if (!this.settings.hasPin()) {
      void this.router.navigate(['/']);
      return;
    }
    this.leavePin.set('');
    this.leaveError.set(null);
    this.leaving.set(true);
  }

  protected cancelLeave(): void {
    this.leaving.set(false);
    this.leavePin.set('');
  }

  protected onLeavePin(event: Event): void {
    this.leavePin.set((event.target as HTMLInputElement).value);
    this.leaveError.set(null);
  }

  protected confirmLeave(event: Event): void {
    event.preventDefault();
    if (!this.settings.matches(this.leavePin())) {
      this.leaveError.set(this.t('gate.wrong'));
      return;
    }
    this.leaving.set(false);
    this.leavePin.set('');
    void this.router.navigate(['/']);
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
    this.walkinPhone.set('');
    this.walkinEmail.set('');
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

  protected onWalkinPhone(event: Event): void {
    this.walkinPhone.set((event.target as HTMLInputElement).value);
    this.walkinError.set(null);
  }

  protected onWalkinEmail(event: Event): void {
    this.walkinEmail.set((event.target as HTMLInputElement).value);
    this.walkinError.set(null);
  }

  protected chooseRole(role: Role): void {
    this.walkinRole.set(role);
  }

  /**
   * Signs a walk-in in, with the one thing the school needs afterwards.
   *
   * A trial student is a lead: the school follows them up in the days after the
   * class, and it cannot do that from a first name alone. Either a phone or an
   * email will do — somebody may have one and not the other, and turning a real
   * person away at the door over a missing field is worse than a blank.
   */
  protected submitWalkin(event: Event): void {
    event.preventDefault();
    const course = this.course();
    const role = this.walkinRole();
    const name = this.walkinName().trim().replace(/\s+/g, ' ');

    if (!course || !role || !name) {
      this.walkinError.set(this.t('walkin.error'));
      return;
    }

    const phone = this.walkinPhone().trim();
    const email = this.walkinEmail().trim();
    if (!phone && !email) {
      this.walkinError.set(this.t('walkin.needContact'));
      return;
    }
    if (email && !looksLikeEmail(email)) {
      this.walkinError.set(this.t('walkin.badEmail'));
      return;
    }

    const outcome = this.store.addTrial(course, role, name, contactLine(phone, email));
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
