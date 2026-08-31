import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { I18nService } from '../../core/i18n';
import { SessionStore } from '../../core/session.store';
import { SettingsService } from '../../core/settings.service';
import { longDate } from '../../core/format';
import { LangSwitch } from '../../ui/lang-switch';
import { Course, Group, Student } from '../../core/models';

/** One announcement left hanging, ready to be written `FALSE` or spared. */
interface NoShow {
  key: string;
  name: string;
  group: Group;
  student: Student;
}

/** Set once the app has walked itself into a lone class, per launch. */
let entered = false;

/**
 * Picks the class being taught right now.
 *
 * A teacher may hold several classes in the same evening and the school keeps
 * opening more, so this list is whatever the registered workbooks contain today
 * — never a hard-coded set.
 */
@Component({
  selector: 'app-courses',
  imports: [RouterLink, LangSwitch],
  templateUrl: './courses.html',
  styleUrl: './courses.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Courses {
  private readonly router = inject(Router);
  protected readonly store = inject(SessionStore);
  protected readonly settings = inject(SettingsService);
  protected readonly i18n = inject(I18nService);

  protected readonly t = this.i18n.t.bind(this.i18n);
  protected readonly date = computed(() => longDate(this.store.date(), this.i18n.locale()));
  protected readonly courses = this.store.visibleCourses;

  /** The dates the workbooks name — the app never invents one. */
  protected readonly dateOptions = computed(() =>
    this.store.sessionDates().map((iso) => ({ iso, label: longDate(iso, this.i18n.locale()) })),
  );

  protected readonly closing = signal<Course | null>(null);
  protected readonly closePicked = signal<ReadonlySet<string>>(new Set<string>());
  protected readonly closePin = signal('');
  protected readonly closeError = signal<string | null>(null);

  /**
   * How many announcements each class has left hanging, by class id.
   *
   * Announced students are those the school ticked in the workbook before the
   * evening; the ones nobody marked in here are what closing corrects. A class
   * with none needs no button at all.
   */
  protected readonly pending = computed(() => {
    const counts = new Map<string, number>();
    for (const course of this.courses()) {
      const n = this.store.noShows(course).length;
      if (n) counts.set(course.id, n);
    }
    return counts;
  });

  /** The names on the sheet currently open, ignoring every other class. */
  protected readonly noShows = computed<NoShow[]>(() => {
    const course = this.closing();
    if (!course) return [];
    return this.store.noShows(course).map(({ group, student }) => ({
      key: `${group.key}#${student.row}`,
      name: student.name,
      group,
      student,
    }));
  });

  /** Workbooks that answered with an error, surfaced instead of swallowed. */
  protected readonly unreachable = computed(() =>
    this.store.courses().filter((course) => course.unreachable),
  );

  constructor() {
    if (!this.settings.configured()) {
      void this.router.navigate(['/bienvenue']);
    } else if (!this.store.courses().length) {
      void this.store.load();
    }

    effect(() => {
      // With a single class there is nothing to choose: go straight in — but
      // only on the way in. A teacher who has just given the code to come back
      // here wants this list, and it is the only road to the settings.
      const only = this.courses();
      if (entered || only.length !== 1 || this.store.loading()) return;
      entered = true;
      void this.router.navigate(['/cours', only[0].id]);
    });
  }

  protected reload(): void {
    void this.store.load();
  }

  protected countOf(course: Course): number {
    return course.groups.reduce((total, group) => total + group.students.length, 0);
  }

  // -------------------------------------------------------------------------
  // The session being taken
  // -------------------------------------------------------------------------

  protected onDate(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    this.store.date.set(value);
    void this.store.load();
  }

  // -------------------------------------------------------------------------
  // Closing a session
  // -------------------------------------------------------------------------

  /**
   * Opens the correction sheet, with every no-show ticked.
   *
   * They start ticked because that is the common case — the teacher glances at
   * the names and confirms. What matters is that the names are *there*: this
   * device cannot know that a colleague ticked somebody in on the other phone,
   * so the only thing standing between that student and a false absence is a
   * human reading their name. A yes/no dialog would not have given them one.
   */
  protected openClosure(course: Course): void {
    this.closing.set(course);
    this.closePicked.set(new Set(this.noShows().map((entry) => entry.key)));
    this.closePin.set('');
    this.closeError.set(null);
  }

  protected cancelClosure(): void {
    this.closing.set(null);
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
    const course = this.closing();
    if (!course) return;

    // `matches` rather than `unlock`: the same four digits, but closing a
    // session must not leave the settings screen open behind it.
    if (this.settings.hasPin() && !this.settings.matches(this.closePin())) {
      this.closeError.set(this.t('gate.wrong'));
      return;
    }

    const chosen = this.noShows().filter((entry) => this.closePicked().has(entry.key));
    if (chosen.length) this.store.closeSession(course, chosen);
    this.closing.set(null);
    this.closePin.set('');
  }

  protected pendingLabel(n: number): string {
    return this.t(n > 1 ? 'teacher.pendingMany' : 'teacher.pendingOne', { n });
  }

  protected closeConfirmLabel(): string {
    const n = this.closePicked().size;
    return this.t(n > 1 ? 'close.confirmMany' : 'close.confirmOne', { n });
  }
}
