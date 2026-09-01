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
 * The code guards the class list, which is the road to this screen. It is asked
 * of the list itself rather than of the way out of a class: a student can leave
 * a class without pressing anything, by swiping back.
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

  /**
   * Whether the class list may be shown, for now.
   *
   * Deliberately not persisted: it lives as long as the tab, and every entry
   * into a class drops it again. The phone changes hands the moment a class is
   * open, so the way back must ask again — however it is taken.
   */
  private readonly open = signal(false);
  readonly unlocked = computed(() => !this.hasPin() || this.open());

  /** True once the backend can actually be called. */
  readonly configured = computed(() => !!this.stored().endpoint && !!this.stored().token);

  save(patch: Partial<StoredSettings>): void {
    const next = { ...this.stored(), ...patch };
    next.endpoint = next.endpoint.trim().replace(/\s+/g, '');
    next.token = next.token.trim();
    this.stored.set(next);
    this.write(next);

    // Setting the code is not a reason to be asked for it: without this, the
    // first save of a new code locks the screen it was just typed on.
    if (patch.pin) this.open.set(true);
  }

  /**
   * Checks the code, and grants nothing by doing so.
   *
   * Used where a single step has to be confirmed rather than a screen opened —
   * closing a session, which can undo somebody's evening. Opening the class
   * list goes through `unlock` instead.
   */
  matches(candidate: string): boolean {
    return candidate === this.stored().pin;
  }

  /** Opens the class list, and the settings screen behind it, until `lock`. */
  unlock(candidate: string): boolean {
    if (!this.matches(candidate)) return false;
    this.open.set(true);
    return true;
  }

  /** Called on the way into a class: from here on the phone is not ours. */
  lock(): void {
    this.open.set(false);
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
