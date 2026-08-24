import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import { DEMO_ENDPOINT } from '../../core/demo';
import { SessionStore, messageOf } from '../../core/session.store';
import { SettingsService } from '../../core/settings.service';
import { Course, Workbook } from '../../core/models';

type Probe = { kind: 'idle' | 'testing' | 'ok' | 'error'; message?: string };

/**
 * Everything that is set once and then left alone.
 *
 * Two kinds of setting live here and they are stored in different places. The
 * deployment URL, the token and the PIN belong to this device — each teacher
 * installs the app on their own phone. The workbook list belongs to the script,
 * so a class added on one device appears on the other.
 */
@Component({
  selector: 'app-settings',
  imports: [RouterLink],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Settings {
  private readonly api = inject(ApiService);
  protected readonly settings = inject(SettingsService);
  protected readonly store = inject(SessionStore);

  protected readonly endpoint = signal(this.settings.endpoint());
  protected readonly token = signal(this.settings.token());
  protected readonly pin = signal('');
  protected readonly savedNote = signal<string | null>(null);

  protected readonly pinEntry = signal('');
  protected readonly pinError = signal(false);

  protected readonly probe = signal<Probe>({ kind: 'idle' });

  protected readonly workbooks = signal<Workbook[]>([]);
  protected readonly workbookError = signal<string | null>(null);
  protected readonly workbooksLoading = signal(false);
  protected readonly newWorkbook = signal('');
  protected readonly adding = signal(false);
  protected readonly removing = signal<Workbook | null>(null);

  protected readonly locked = computed(() => !this.settings.settingsOpen());
  protected readonly demo = computed(() => this.settings.endpoint() === DEMO_ENDPOINT);
  protected readonly courses = computed(() => this.store.courses().filter((c) => !c.unreachable));

  constructor() {
    if (this.settings.configured() && this.settings.settingsOpen()) {
      void this.loadWorkbooks();
    }
  }

  // -------------------------------------------------------------------------
  // Unlocking
  // -------------------------------------------------------------------------

  protected onPinEntry(event: Event): void {
    const value = (event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 4);
    this.pinEntry.set(value);
    this.pinError.set(false);
    if (value.length === 4) this.tryUnlock();
  }

  protected tryUnlock(): void {
    if (this.settings.unlock(this.pinEntry())) {
      this.pinEntry.set('');
      void this.loadWorkbooks();
      return;
    }
    this.pinError.set(true);
    this.pinEntry.set('');
  }

  protected lock(): void {
    this.settings.lock();
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  protected onEndpoint(event: Event): void {
    this.endpoint.set((event.target as HTMLInputElement).value);
  }

  protected onToken(event: Event): void {
    this.token.set((event.target as HTMLInputElement).value);
  }

  protected onPin(event: Event): void {
    this.pin.set((event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 4));
  }

  protected save(): void {
    const patch: { endpoint: string; token: string; pin?: string } = {
      endpoint: this.endpoint(),
      token: this.token(),
    };
    // An empty PIN field means "leave it as it is", not "remove the lock".
    if (this.pin().length === 4) patch.pin = this.pin();

    this.settings.save(patch);
    this.pin.set('');
    this.savedNote.set('Réglages enregistrés.');
    void this.reloadEverything();
  }

  protected async test(): Promise<void> {
    this.probe.set({ kind: 'testing' });
    this.settings.save({ endpoint: this.endpoint(), token: this.token() });
    try {
      const result = await this.api.ping();
      this.probe.set({ kind: 'ok', message: `Connecté — fuseau ${result.timeZone}.` });
    } catch (error) {
      this.probe.set({ kind: 'error', message: messageOf(error) });
    }
  }

  /**
   * Switches to invented data, so the interface can be tried on a phone before
   * any Apps Script deployment exists. Nothing is ever written in this mode.
   */
  protected startDemo(): void {
    this.settings.save({ endpoint: DEMO_ENDPOINT, token: DEMO_ENDPOINT });
    this.endpoint.set(DEMO_ENDPOINT);
    this.token.set(DEMO_ENDPOINT);
    this.probe.set({ kind: 'idle' });
    this.savedNote.set('Mode démonstration activé.');
    void this.reloadEverything();
  }

  protected leaveDemo(): void {
    this.settings.save({ endpoint: '', token: '' });
    this.endpoint.set('');
    this.token.set('');
    this.savedNote.set(null);
    this.workbooks.set([]);
  }

  // -------------------------------------------------------------------------
  // Workbooks
  // -------------------------------------------------------------------------

  protected async loadWorkbooks(): Promise<void> {
    if (!this.settings.configured()) return;
    this.workbooksLoading.set(true);
    this.workbookError.set(null);
    try {
      this.workbooks.set(await this.api.workbooks());
    } catch (error) {
      this.workbookError.set(messageOf(error));
    } finally {
      this.workbooksLoading.set(false);
    }
  }

  protected onNewWorkbook(event: Event): void {
    this.newWorkbook.set((event.target as HTMLInputElement).value);
  }

  protected async addWorkbook(event: Event): Promise<void> {
    event.preventDefault();
    const reference = this.newWorkbook().trim();
    if (!reference) return;

    this.adding.set(true);
    this.workbookError.set(null);
    try {
      this.workbooks.set(await this.api.addWorkbook(reference));
      this.newWorkbook.set('');
      await this.store.load();
    } catch (error) {
      this.workbookError.set(messageOf(error));
    } finally {
      this.adding.set(false);
    }
  }

  protected askRemove(workbook: Workbook): void {
    this.removing.set(workbook);
  }

  protected cancelRemove(): void {
    this.removing.set(null);
  }

  protected async confirmRemove(): Promise<void> {
    const workbook = this.removing();
    if (!workbook) return;
    this.removing.set(null);
    this.workbookError.set(null);
    try {
      this.workbooks.set(await this.api.removeWorkbook(workbook.id));
      await this.store.load();
    } catch (error) {
      this.workbookError.set(messageOf(error));
    }
  }

  // -------------------------------------------------------------------------
  // Class visibility
  // -------------------------------------------------------------------------

  protected async toggleCourse(course: Course): Promise<void> {
    this.workbookError.set(null);
    try {
      await this.api.setHidden(course.id, !course.hidden);
      await this.store.load();
    } catch (error) {
      this.workbookError.set(messageOf(error));
    }
  }

  private async reloadEverything(): Promise<void> {
    await this.loadWorkbooks();
    await this.store.load();
  }
}
