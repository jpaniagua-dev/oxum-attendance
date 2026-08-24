import { Injectable, inject } from '@angular/core';
import { SettingsService } from './settings.service';
import { DEMO_ENDPOINT, demoSession, demoWorkbooks } from './demo';
import { Operation, OperationResult, SessionPayload, Workbook } from './models';

/**
 * Talks to the Apps Script web app.
 *
 * Uses `fetch` rather than HttpClient for one reason: Apps Script does not
 * answer a CORS preflight, so every POST has to stay a "simple request" —
 * `text/plain` content type, no custom headers. Going through HttpClient makes
 * it far too easy for an interceptor or a default header to reintroduce the
 * preflight and break writing in a way that only shows up in the browser.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly settings = inject(SettingsService);

  /** Everything runs against invented data while the endpoint is `demo`. */
  readonly demo = () => this.settings.endpoint() === DEMO_ENDPOINT;

  async session(date: string): Promise<SessionPayload> {
    if (this.demo()) return demoSession(date);
    return this.get<SessionPayload>({ action: 'session', date });
  }

  async workbooks(): Promise<Workbook[]> {
    if (this.demo()) return demoWorkbooks();
    const payload = await this.get<{ workbooks: Workbook[] }>({ action: 'workbooks' });
    return payload.workbooks;
  }

  async ping(): Promise<{ timeZone: string }> {
    if (this.demo()) return { timeZone: 'démonstration' };
    return this.get<{ timeZone: string }>({ action: 'ping' });
  }

  async run(ops: Operation[]): Promise<OperationResult[]> {
    // In demo mode a tap is accepted and goes nowhere: no sheet is touched.
    if (this.demo()) return ops.map(() => ({ ok: true }));
    const payload = await this.post<{ results: OperationResult[] }>({
      action: 'batch',
      ops: ops.map(toWireOperation),
    });
    return payload.results;
  }

  async addWorkbook(url: string): Promise<Workbook[]> {
    if (this.demo()) throw new Error('Impossible d’ajouter un classeur en démonstration.');
    const payload = await this.post<{ workbooks: Workbook[] }>({ action: 'addWorkbook', url });
    return payload.workbooks;
  }

  async removeWorkbook(id: string): Promise<Workbook[]> {
    if (this.demo()) throw new Error('Impossible de retirer un classeur en démonstration.');
    const payload = await this.post<{ workbooks: Workbook[] }>({ action: 'removeWorkbook', id });
    return payload.workbooks;
  }

  async setHidden(courseId: string, hidden: boolean): Promise<void> {
    if (this.demo()) throw new Error('Impossible de masquer un cours en démonstration.');
    await this.post({ action: 'setHidden', courseId, hidden });
  }

  private async get<T>(params: Record<string, string>): Promise<T> {
    const endpoint = this.require();
    const query = new URLSearchParams({ ...params, token: this.settings.token() });
    const response = await fetch(`${endpoint}?${query}`, { method: 'GET', redirect: 'follow' });
    return this.unwrap<T>(response);
  }

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    const endpoint = this.require();
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, token: this.settings.token() }),
    });
    return this.unwrap<T>(response);
  }

  /**
   * Apps Script cannot set a status code, so success lives in the body. A
   * non-JSON response almost always means the deployment URL is wrong and
   * Google served an HTML error page instead.
   */
  private async unwrap<T>(response: Response): Promise<T> {
    const text = await response.text();
    let payload: { ok?: boolean; error?: string };
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(
        "Réponse inattendue du serveur. Vérifie l'URL de déploiement dans les réglages.",
      );
    }
    if (!payload.ok) throw new Error(payload.error || 'Erreur inconnue.');
    return payload as T;
  }

  private require(): string {
    const endpoint = this.settings.endpoint();
    if (!endpoint) throw new Error("L'app n'est pas encore configurée.");
    return endpoint;
  }
}

/** Strips the fields the backend has no use for, keeping the payload small. */
function toWireOperation(op: Operation) {
  return {
    kind: op.kind,
    spreadsheetId: op.spreadsheetId,
    sheetName: op.sheetName,
    row: op.row,
    nameColumn: op.nameColumn,
    sessionColumn: op.sessionColumn,
    name: op.name,
    present: op.present,
  };
}
