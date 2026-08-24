import { Injectable, computed, signal } from '@angular/core';

const KEY = 'attendance.settings';

interface StoredSettings {
  endpoint: string;
  token: string;
  /** Four digits, guarding the settings screen on a device passed around. */
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
 * The token sits in localStorage and in the page it came from; anyone holding
 * the unlocked device can read it. It is a barrier to discovery, not
 * authentication. See README.md.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly stored = signal<StoredSettings>(this.read());

  /** Cleared on every launch: unlocking is per app session, not remembered. */
  private readonly unlockedNow = signal(false);

  readonly endpoint = computed(() => this.stored().endpoint);
  readonly token = computed(() => this.stored().token);
  readonly hasPin = computed(() => this.stored().pin.length > 0);

  /** True once the backend can actually be called. */
  readonly configured = computed(() => !!this.stored().endpoint && !!this.stored().token);

  /**
   * Settings are reachable when there is no PIN yet, or after entering it.
   * Without the first case an unconfigured install would lock out the very
   * screen needed to configure it.
   *
   * Unlocking lasts exactly as long as the visit: leaving the screen locks it
   * again. The device spends the class in a student's hands, and a settings
   * page that stays open behind a back button is not protected at all.
   */
  readonly settingsOpen = computed(() => !this.hasPin() || this.unlockedNow());

  save(patch: Partial<StoredSettings>): void {
    const next = { ...this.stored(), ...patch };
    next.endpoint = next.endpoint.trim().replace(/\s+/g, '');
    next.token = next.token.trim();
    this.stored.set(next);
    this.write(next);

    // Setting the very first PIN would otherwise drop the gate over the page
    // the person is still standing on.
    if (patch.pin) this.unlockedNow.set(true);
  }

  unlock(candidate: string): boolean {
    if (candidate === this.stored().pin) {
      this.unlockedNow.set(true);
      return true;
    }
    return false;
  }

  lock(): void {
    this.unlockedNow.set(false);
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
