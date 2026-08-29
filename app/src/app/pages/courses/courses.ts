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

  /** The only date control left here: back to the evening being taught. */
  protected today(): void {
    this.store.date.set(todayIso());
    void this.store.load();
  }

  protected readonly isToday = computed(() => this.store.date() === todayIso());

  protected countOf(course: Course): number {
    return course.groups.reduce((total, group) => total + group.students.length, 0);
  }
}
