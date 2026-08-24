/** Shapes returned by the Apps Script backend. See ../../../../README.md. */

export type Role = 'leader' | 'follower';
export type Category = 'active' | 'trial' | 'helper';

export interface Student {
  /** 1-based sheet row. Only meaningful inside its own group. */
  row: number;
  number: number;
  name: string;
  /** null when the sheet has no column for the requested date. */
  present: boolean | null;
  /** The school's free-text note beside the name; '' when there is none. */
  comment: string;
}

export interface FreeSlot {
  row: number;
  number: number;
}

export interface SessionColumn {
  column: number;
  key: string;
  label: string;
}

export interface Group {
  /** `${role}:${category}` — the address of one half-grid block. */
  key: string;
  label: string;
  role: Role;
  category: Category;
  nameColumn: number;
  /** null when today has no column in this workbook. */
  sessionColumn: number | null;
  /** The "Commentaires" column closing this block. */
  commentColumn: number | null;
  sessionColumns: SessionColumn[];
  students: Student[];
  freeSlots: FreeSlot[];
}

export interface Course {
  /** `${spreadsheetId}::${sheetName}::${titleRow}` */
  id: string;
  spreadsheetId: string;
  sheetName: string;
  title: string;
  titleRow: number;
  workbookLabel?: string;
  hidden: boolean;
  hasSession: boolean;
  sessionLabels: string[];
  groups: Group[];
  /** Set when the workbook could not be opened at all. */
  unreachable?: boolean;
}

export interface SessionPayload {
  date: string;
  dateKey: string;
  courses: Course[];
}

export interface Workbook {
  id: string;
  label: string;
  title?: string;
  courses?: string[];
  reachable: boolean;
  error?: string;
}

/** One tap, in the shape the backend applies and the queue replays. */
export interface Operation {
  /** Local id, so a result can be matched back to its queue entry. */
  uid: string;
  kind: 'mark' | 'trial' | 'comment';
  spreadsheetId: string;
  sheetName: string;
  row: number;
  nameColumn: number;
  /** Target for a mark or a walk-in. */
  sessionColumn: number | null;
  /** Target for a note. */
  commentColumn: number | null;
  name: string;
  present: boolean;
  text: string;
  /** Kept for the UI only; the backend ignores these two. */
  courseId: string;
  groupKey: string;
}

export interface OperationResult {
  ok: boolean;
  stale?: boolean;
  reason?: string;
  row?: number;
  name?: string;
  added?: boolean;
  present?: boolean;
  comment?: string;
}
