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
import { I18nService, MessageKey } from '../../core/i18n';
import { SessionStore } from '../../core/session.store';
import { SettingsService } from '../../core/settings.service';
import { fold, longDate } from '../../core/format';
import { Category, Group, Role, Student } from '../../core/models';

const CATEGORY_ORDER: Category[] = ['active', 'trial', 'helper'];

/** How long a freshly moved card stays highlighted. */
const HIGHLIGHT_MS = 1800;

interface WaitingGroup {
  group: Group;
  students: Student[];
}

interface Entry {
  key: string;
  name: string;
  detail: string;
  comment: string;
  arrival: number;
  /** Absent for a walk-in: it is already written to the sheet and stays. */
  group: Group | null;
  student: Student | null;
}

/**
 * The screen a student is handed on arrival.
 *
 * Everything here follows from students trickling in one at a time: a search
 * field so the teacher can say "cherche ton nom", a tap that reaches the sheet
 * on its own, and a list that splits into who is here and who is still
 * expected.
 *
 * There is no confirmation dialog. The tapped name leaves the waiting list and
 * appears at the top of "Présents", the page scrolls up to it and it holds a
 * highlight for a moment — the movement itself is the receipt, and nothing
 * blocks the next person from stepping up.
 */
@Component({
  selector: 'app-roster',
  imports: [RouterLink],
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

  protected readonly course = this.store.course;
  protected readonly date = computed(() => longDate(this.store.date(), this.i18n.locale()));
  protected readonly tally = this.store.tally;

  /** Present names, most recently arrived first. */
  protected readonly present = computed<Entry[]>(() => {
    const course = this.course();
    if (!course) return [];
    const needle = fold(this.search());
    const items: Entry[] = [];

    for (const group of [...course.groups].sort(byCategoryThenRole)) {
      for (const student of group.students) {
        if (!this.store.isPresent(course.id, group, student)) continue;
        if (needle && !fold(student.name).includes(needle)) continue;
        items.push(this.entryOf(course.id, group, student));
      }
    }

    for (const extra of this.store.extrasFor(course.id)) {
      if (needle && !fold(extra.name).includes(needle)) continue;
      items.push({
        key: `extra#${extra.uid}`,
        name: extra.name,
        detail: `${this.t('category.trialOne')} · ${this.roleOne(extra.role)}`,
        comment: '',
        arrival: this.store.arrivalOf(course.id, extra.groupKey, extra.row),
        group: null,
        student: null,
      });
    }

    // Anyone ticked before the app opened has no arrival number and sits below.
    return items.sort((a, b) => b.arrival - a.arrival);
  });

  /** Who is still expected, by block, with the present ones taken out. */
  protected readonly waiting = computed<WaitingGroup[]>(() => {
    const course = this.course();
    if (!course) return [];
    const needle = fold(this.search());

    return [...course.groups]
      .sort(byCategoryThenRole)
      .map((group) => ({
        group,
        students: group.students.filter(
          (student) =>
            !this.store.isPresent(course.id, group, student) &&
            (!needle || fold(student.name).includes(needle)),
        ),
      }))
      .filter((entry) => entry.students.length > 0);
  });

  protected readonly nothingFound = computed(
    () => this.search().length > 0 && !this.present().length && !this.waiting().length,
  );

  constructor() {
    effect(() => {
      const id = this.routeId();
      if (!id) return;
      this.store.select(id);
      if (!this.store.courses().length && this.settings.configured()) {
        void this.store.load();
      }
    });

    this.destroyRef.onDestroy(() => this.clearHighlight());
  }

  private entryOf(courseId: string, group: Group, student: Student): Entry {
    return {
      key: `${group.key}#${student.row}`,
      name: student.name,
      detail: `${this.categoryOne(group.category)} · ${this.roleOne(group.role)}`,
      comment: this.store.commentOf(courseId, group, student),
      arrival: this.store.arrivalOf(courseId, group.key, student.row),
      group,
      student,
    };
  }

  // -------------------------------------------------------------------------
  // Marking
  // -------------------------------------------------------------------------

  /** Marks a waiting student present: the card moves up to "Présents". */
  protected arrive(group: Group, student: Student): void {
    const course = this.course();
    if (!course || !course.hasSession) return;

    this.store.mark(course, group, student, true);
    this.flag(`${group.key}#${student.row}`);
  }

  /**
   * A tap in the present list asks before removing. The device is handed
   * around, and a mis-tap must not quietly unmark someone standing right there.
   */
  protected tapPresent(item: Entry): void {
    if (!item.group || !item.student) return;
    this.untick.set({ group: item.group, student: item.student });
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
  // Notes
  // -------------------------------------------------------------------------

  protected commentOf(group: Group, student: Student): string {
    const course = this.course();
    return course ? this.store.commentOf(course.id, group, student) : '';
  }

  protected openNote(group: Group, student: Student): void {
    this.noteText.set(this.commentOf(group, student));
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

  protected labelOf(group: Group): string {
    return `${this.t(`category.${group.category}` as MessageKey)} — ${this.t(
      group.role === 'leader' ? 'role.leaders' : 'role.followers',
    )}`;
  }

  protected roleLabel(role: Role): string {
    return this.t(role === 'leader' ? 'role.leaders' : 'role.followers');
  }

  private roleOne(role: Role): string {
    return this.t(role === 'leader' ? 'role.leader' : 'role.follower');
  }

  private categoryOne(category: Category): string {
    return this.t(`category.${category}One` as MessageKey);
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

function byCategoryThenRole(a: Group, b: Group): number {
  const byCategory = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
  if (byCategory !== 0) return byCategory;
  return a.role === b.role ? 0 : a.role === 'leader' ? -1 : 1;
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
