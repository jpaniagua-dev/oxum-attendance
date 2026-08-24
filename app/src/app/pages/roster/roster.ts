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

const CATEGORY_ORDER: Category[] = ['active', 'trial', 'helper'];

/** How long the "c'est noté" panel stays up before the next student's turn. */
const CONFIRM_MS = 2200;

interface FilteredGroup {
  group: Group;
  students: Student[];
  present: number;
}

/**
 * The screen a student is handed on arrival.
 *
 * Everything here follows from students trickling in one at a time: a search
 * field so the teacher can say "cherche ton nom", a tap that reaches the sheet
 * on its own, and a confirmation that clears itself so the device is ready for
 * whoever walks in next — including the person who turns up half an hour late.
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
  protected readonly confirmed = signal<string | null>(null);
  protected readonly untick = signal<{ group: Group; student: Student } | null>(null);

  protected readonly walkinOpen = signal(false);
  protected readonly walkinName = signal('');
  protected readonly walkinRole = signal<Role | null>(null);
  protected readonly walkinError = signal<string | null>(null);

  private confirmTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly course = this.store.course;
  protected readonly date = computed(() => longDate(this.store.date()));
  protected readonly tally = this.store.tally;
  protected readonly extras = computed(() => {
    const course = this.course();
    return course ? this.store.extrasFor(course.id) : [];
  });

  /** Groups with at least one name matching the search, in reading order. */
  protected readonly groups = computed<FilteredGroup[]>(() => {
    const course = this.course();
    if (!course) return [];
    const needle = fold(this.search());

    return [...course.groups]
      .sort(byCategoryThenRole)
      .map((group) => ({
        group,
        students: group.students.filter(
          (student) => !needle || fold(student.name).includes(needle),
        ),
        present: group.students.filter((student) =>
          this.store.isPresent(course.id, group, student),
        ).length,
      }))
      .filter((entry) => entry.students.length > 0);
  });

  protected readonly nothingFound = computed(
    () => this.search().length > 0 && this.groups().length === 0,
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

    this.destroyRef.onDestroy(() => this.clearConfirmTimer());
  }

  // -------------------------------------------------------------------------
  // Marking
  // -------------------------------------------------------------------------

  protected isPresent(group: Group, student: Student): boolean {
    const course = this.course();
    return course ? this.store.isPresent(course.id, group, student) : false;
  }

  /**
   * A tap on a name marks it present. A tap on someone already present asks
   * first — the device is handed around, and a mis-tap must not quietly remove
   * a student who is standing right there.
   */
  protected tap(group: Group, student: Student): void {
    const course = this.course();
    if (!course || !course.hasSession) return;

    if (this.isPresent(group, student)) {
      this.untick.set({ group, student });
      return;
    }
    this.store.mark(course, group, student, true);
    this.celebrate(student.name);
  }

  protected confirmUntick(): void {
    const pending = this.untick();
    const course = this.course();
    if (!pending || !course) return;
    this.store.mark(course, pending.group, pending.student, false);
    this.untick.set(null);
  }

  protected cancelUntick(): void {
    this.untick.set(null);
  }

  /** Shows the name back to the student, then resets for the next arrival. */
  private celebrate(name: string): void {
    this.confirmed.set(name);
    this.clearConfirmTimer();
    this.confirmTimer = setTimeout(() => {
      this.confirmed.set(null);
      this.search.set('');
      this.confirmTimer = null;
    }, CONFIRM_MS);
  }

  protected dismissConfirmation(): void {
    this.clearConfirmTimer();
    this.confirmed.set(null);
    this.search.set('');
  }

  private clearConfirmTimer(): void {
    if (this.confirmTimer !== null) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
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
    this.celebrate(name);
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
