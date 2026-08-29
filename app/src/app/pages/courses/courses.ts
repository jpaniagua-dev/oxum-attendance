import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { I18nService } from '../../core/i18n';
import { SessionStore, todayIso } from '../../core/session.store';
import { SettingsService } from '../../core/settings.service';
import { longDate } from '../../core/format';
import { LangSwitch } from '../../ui/lang-switch';
import { Course } from '../../core/models';

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

  /**
   * The dates on offer, as the workbook names them.
   *
   * A calendar would let anyone pick a day the grid has no column for, which
   * the app can only answer with "no column for this date". The school opens
   * the season's dates in the sheet, so the sheet is the list.
   */
  protected readonly dateOptions = computed(() =>
    this.store.sessionDates().map((iso) => ({ iso, label: longDate(iso, this.i18n.locale()) })),
  );

  /** Workbooks that answered with an error, surfaced instead of swallowed. */
  protected readonly unreachable = computed(() =>
    this.store.courses().filter((course) => course.unreachable),
  );

  constructor() {
    if (!this.settings.configured()) {
      void this.router.navigate(['/reglages']);
    } else if (!this.store.courses().length) {
      void this.store.load();
    }

    effect(() => {
      // With a single class there is nothing to choose: go straight in.
      const only = this.courses();
      if (only.length === 1 && !this.store.loading()) {
        void this.router.navigate(['/cours', only[0].id]);
      }
    });
  }

  protected reload(): void {
    void this.store.load();
  }

  /**
   * Looks at another date's session.
   *
   * A class is rarely closed on the spot, so the previous evening has to be
   * reachable. Nothing else changes: the workbook is read for that date, and a
   * date the app never saw being taught yields no announcements at all, so it
   * cannot be closed by mistake — see `captureAnnounced`.
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

  protected readonly isToday = computed(() => this.store.date() === todayIso());

  protected countOf(course: Course): number {
    return course.groups.reduce((total, group) => total + group.students.length, 0);
  }
}
