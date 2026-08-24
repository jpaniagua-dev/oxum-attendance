import { Injectable, effect, signal } from '@angular/core';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'attendance.theme';

/** Kept in step with the palettes in styles.css. */
const GROUND = { light: '#FAF7F2', dark: '#0E0D0C' };

/**
 * Light, dark, or whatever the device says.
 *
 * `system` is the default and does most of the work: a studio is bright in the
 * afternoon and dim at night, and a phone already switches on its own. The
 * explicit choices exist for the times when it guesses wrong.
 *
 * The choice is written as `data-theme` on the root element; nothing else in
 * the app inspects it, because every colour resolves through tokens.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly choice = signal<ThemeChoice>(read());
  readonly current = this.choice.asReadonly();

  constructor() {
    effect(() => this.apply(this.choice()));

    // Only matters while the choice is `system`, but re-applying is harmless.
    prefersDark()?.addEventListener('change', () => this.apply(this.choice()));
  }

  set(choice: ThemeChoice): void {
    this.choice.set(choice);
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      // Private mode: the choice still holds for this session.
    }
  }

  private apply(choice: ThemeChoice): void {
    const root = document.documentElement;
    if (choice === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', choice);
    }

    // The browser paints its own chrome from this, so it has to follow along.
    const dark = choice === 'dark' || (choice === 'system' && !!prefersDark()?.matches);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? GROUND.dark : GROUND.light);
  }
}

function prefersDark(): MediaQueryList | null {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
}

function read(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}
