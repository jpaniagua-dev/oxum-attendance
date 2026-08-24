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
import { SessionStore } from '../../core/session.store';
import { SettingsService } from '../../core/settings.service';
import { fold, longDate, plural } from '../../core/format';
import { Category, Group, Role, Student } from '../../core/models';

const CATEGORY_LABELS: Record<Category, string> = {
  active: 'Inscrits',
  trial: "Cours d'essai",
  helper: 'Aide',
};

const ROLE_LABELS: Record<Role, string> = {
  leader: 'Leaders',
  follower: 'Followers',
};

/** Singular forms, for the one-line detail under a name in the present list. */
const CATEGORY_ONE: Record<Category, string> = {
  active: 'Inscrit',
  trial: 'Essai',
  helper: 'Aide',
};

const ROLE_ONE: Record<Role, string> = {
  leader: 'Leader',
  follower: 'Follower',
};

const CATEGORY_ORDER: Category[] = ['active', 'trial', 'helper'];

/** How long a freshly moved card stays highlighted. */
const HIGHLIGHT_MS = 1800;

interface WaitingGroup {
  group: Group;
  students: Student[];
}

interface PresentItem {
  key: string;
  name: string;
  detail: string;
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

  private highlightTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly course = this.store.course;
  protected readonly date = computed(() => longDate(this.store.date()));
  protected readonly tally = this.store.tally;

  /** Present names, most recently arrived first. */
  protected readonly present = computed<PresentItem[]>(() => {
    const course = this.course();
    if (!course) return [];
    const needle = fold(this.search());
    const items: PresentItem[] = [];

    for (const group of [...course.groups].sort(byCategoryThenRole)) {
      for (const student of group.students) {
        if (!this.store.isPresent(course.id, group, student)) continue;
        if (needle && !fold(student.name).includes(needle)) continue;
        items.push({
          key: `${group.key}#${student.row}`,
          name: student.name,
          detail: `${CATEGORY_ONE[group.category]} · ${ROLE_ONE[group.role]}`,
          arrival: this.store.arrivalOf(course.id, group.key, student.row),
          group,
          student,
        });
      }
    }

    for (const extra of this.store.extrasFor(course.id)) {
      if (needle && !fold(extra.name).includes(needle)) continue;
      items.push({
        key: `extra#${extra.uid}`,
        name: extra.name,
        detail: `Essai · ${ROLE_ONE[extra.role]}`,
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
  protected tapPresent(item: PresentItem): void {
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
      this.walkinError.set('Il faut un nom et un rôle.');
      return;
    }

    const outcome = this.store.addTrial(course, role, name);
    if (!outcome.ok) {
      this.walkinError.set(outcome.reason ?? 'Impossible d’ajouter ce nom.');
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
    return `${CATEGORY_LABELS[group.category]} — ${ROLE_LABELS[group.role]}`;
  }

  protected roleLabel(role: Role): string {
    return ROLE_LABELS[role];
  }

  protected presentWord(count: number): string {
    return plural(count, 'présent', 'présents');
  }

  protected syncLabel(): string {
    switch (this.store.sync()) {
      case 'sending':
        return 'Envoi…';
      case 'pending':
        return `${this.store.queue().length} en attente`;
      case 'offline':
        return 'Hors ligne';
      default:
        return 'À jour';
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
