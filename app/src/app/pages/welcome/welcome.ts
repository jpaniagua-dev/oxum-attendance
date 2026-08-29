import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import { DEMO_ENDPOINT } from '../../core/demo';
import { I18nService } from '../../core/i18n';
import { SettingsService } from '../../core/settings.service';
import { LangSwitch } from '../../ui/lang-switch';

/**
 * The first thing a device sees, and the only screen that exists before one is
 * wired to the studio.
 *
 * Two doors, because a first run has two different people behind it: a teacher
 * connecting their own phone to the school's script, and anyone who wants to
 * see what the thing does before there is a workbook to point it at. Sending
 * both straight to the settings form asked the second one for a deployment URL
 * they have no way of having.
 */
@Component({
  selector: 'app-welcome',
  imports: [LangSwitch],
  templateUrl: './welcome.html',
  styleUrl: './welcome.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Welcome {
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsService);
  protected readonly i18n = inject(I18nService);

  protected readonly t = this.i18n.t.bind(this.i18n);

  constructor() {
    // There is nothing to welcome anyone to once the device is connected.
    if (this.settings.configured()) void this.router.navigate(['/']);
  }

  protected setup(): void {
    void this.router.navigate(['/reglages']);
  }

  /**
   * The demo is a deployment URL like any other, which is what keeps it out of
   * the rest of the app: nothing downstream asks whether it is real.
   */
  protected demo(): void {
    this.settings.save({ endpoint: DEMO_ENDPOINT, token: DEMO_ENDPOINT });
    void this.router.navigate(['/']);
  }
}
