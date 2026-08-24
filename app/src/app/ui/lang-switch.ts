import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { I18nService, Lang } from '../core/i18n';

/**
 * The language control, in the class header rather than the settings screen.
 *
 * Students switch it themselves and they do not have the settings code, so it
 * has to be findable at a glance while someone is standing at the door: full
 * size type and a flag, not a discreet two-letter pill.
 *
 * Flags are inline SVG rather than emoji — emoji flags fall back to bare letter
 * pairs on some platforms, which is exactly the thing being avoided here.
 */
@Component({
  selector: 'app-lang-switch',
  templateUrl: './lang-switch.html',
  styleUrl: './lang-switch.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LangSwitch {
  private readonly i18n = inject(I18nService);

  protected readonly lang = this.i18n.lang;
  protected readonly t = this.i18n.t.bind(this.i18n);

  protected choose(lang: Lang): void {
    this.i18n.set(lang);
  }
}
