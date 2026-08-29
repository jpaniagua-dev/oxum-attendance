import { Injectable, computed, signal } from '@angular/core';

const KEY = 'attendance.settings';

interface StoredSettings {
  endpoint: string;
  token: string;
  /** Four digits, asked to leave a class and to close one. */
  pin: string;
}

const EMPTY: StoredSettings = { endpoint: '', token: '', pin: '' };

/**
 * Per-device configuration.
 *
 * Deliberately not shared with the backend: each teacher installs the app on
 * their own phone or tablet and pastes the deployment URL once. What *is*
 * shared — the list of workbooks — lives in script properties instead, so
 * adding a class on one device shows it on the other.
 *
 * This screen is not itself behind the code. It is reached only from the class
 * list, and the way out of a class already asks for it — a second prompt on the
 * far side of the first guards nothing.
 *
 * The token sits in localStorage and in the page it came from; anyone holding
 * the unlocked device can read it. It is a barrier to discovery, not
 * authentication. See README.md.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly stored = signal<StoredSettings>(this.read());

  readonly endpoint = computed(() => this.stored().endpoint);
  readonly token = computed(() => this.stored().token);
  readonly hasPin = computed(() => this.stored().pin.length > 0);

  /** True once the backend can actually be called. */
  readonly configured = computed(() => !!this.stored().endpoint && !!this.stored().token);

  save(patch: Partial<StoredSettings>): void {
    const next = { ...this.stored(), ...patch };
    next.endpoint = next.endpoint.trim().replace(/\s+/g, '');
    next.token = next.token.trim();
    this.stored.set(next);
    this.write(next);
  }

  /**
   * Checks the code, and grants nothing by doing so.
   *
   * The settings screen is no longer gated: it sits behind the class list, and
   * the way out of a class already asks for these four digits. What still asks
   * is the pair of steps that can undo somebody's evening — leaving a class and
   * closing a session — and neither hands out anything beyond the step it
   * guards.
   */
  matches(candidate: string): boolean {
    return candidate === this.stored().pin;
  }

  private read(): StoredSettings {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? { ...EMPTY, ...JSON.parse(raw) } : { ...EMPTY };
    } catch {
      return { ...EMPTY };
    }
  }

  private write(value: StoredSettings): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(value));
    } catch {
      // Private browsing or a full quota: the app still works for this session.
    }
  }
}
