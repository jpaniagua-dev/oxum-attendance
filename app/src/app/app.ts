import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SessionStore } from './core/session.store';
import { ThemeService } from './core/theme.service';

/**
 * Shell. Each screen brings its own header; what lives here is the one thing
 * that must interrupt whatever is on screen — a row the sheet refused, which
 * only a person can sort out.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(SessionStore);

  /** Injected for its side effect: it stamps the chosen theme on the root. */
  private readonly theme = inject(ThemeService);
}
