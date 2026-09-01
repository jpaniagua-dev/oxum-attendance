import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { I18nService } from '../core/i18n';
import { SettingsService } from '../core/settings.service';

/**
 * The four digits, standing in front of a screen instead of a step.
 *
 * The class list and the settings behind it hold the deployment URL, the token
 * and every workbook the school has registered, so they are what the code is
 * for. It guards the screen rather than the button that opens it: a student can
 * leave a class without pressing anything at all — on Android, by swiping back
 * — and a lock on the way out is no lock.
 *
 * There is no way past it and no cancel: the screen it covers is simply not
 * shown until the code is right.
 */
@Component({
  selector: 'app-code-gate',
  templateUrl: './code-gate.html',
  styleUrl: './code-gate.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodeGate {
  private readonly settings = inject(SettingsService);
  private readonly i18n = inject(I18nService);

  protected readonly t = this.i18n.t.bind(this.i18n);
  protected readonly pin = signal('');
  protected readonly error = signal<string | null>(null);

  protected onPin(event: Event): void {
    this.pin.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.settings.unlock(this.pin())) {
      this.error.set(this.t('gate.wrong'));
      return;
    }
    this.pin.set('');
  }
}
