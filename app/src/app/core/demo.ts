import { Course, Group, Role, SessionColumn, SessionPayload, Student, Workbook } from './models';

/**
 * A stand-in studio, used when the deployment URL is the word `demo`.
 *
 * It exists so the interface can be handed round and argued about before any
 * Google Sheet is wired up — and so a teacher trying the app for the first time
 * sees a full class rather than an empty screen. Names are invented; the shape
 * mirrors the real workbooks, including the awkward parts: a class with no
 * enrolled leaders at all, and trial blocks fuller than the roster.
 */
export const DEMO_ENDPOINT = 'demo';

/**
 * The season the demo pretends to have, so the date list has something to show.
 * A real workbook opens its dates ahead of time; an empty list would make the
 * control look broken rather than empty.
 */
const DEMO_SESSIONS: SessionColumn[] = [
  { column: 5, key: '08-25', label: '25.08' },
  { column: 6, key: '09-01', label: '1.09' },
  { column: 7, key: '09-08', label: '8.09' },
  { column: 8, key: '09-15', label: '15.09' },
  { column: 9, key: '09-22', label: '22.09' },
  { column: 10, key: '09-29', label: '29.09' },
];

export function demoSession(date: string): SessionPayload {
  return {
    date,
    dateKey: date.slice(5).replace('-', '-'),
    courses: [
      course({
        id: 'demo-diana::Feuille 1::4',
        title: 'Julio & Diana - Inter-Avancé 1',
        workbook: 'Julio & Diana - mardi',
        roster: {
          'leader:active': ['Antoine H.', 'Basile P.', 'Cyril A.', 'Damien X.'],
          'follower:active': ['Élodie S.', 'Fanny W. K.', 'Garance P.'],
          'leader:trial': ['Hector A.', 'Ivan'],
          'follower:trial': ['Jeanne O.', 'Karen B.', 'Lucie', 'Manon V.', 'Nine G.'],
        },
        alreadyPresent: ['Antoine H.', 'Élodie S.'],
        notes: { 'Garance P.': 'danse en fait leader' },
      }),
      course({
        id: 'demo-diana::Feuille 1::42',
        title: 'Julio & Diana - Faux-Débutant 1',
        workbook: 'Julio & Diana - mardi',
        roster: {
          'leader:active': ['Olivier P.', 'Pierre S.', 'Quentin S.'],
          'follower:active': ['Rose W.'],
          'leader:trial': ['Samuel', 'Théo', 'Ulysse H.', 'Victor L.'],
          'follower:trial': ['Wanda R.', 'Xénia C.', 'Yara', 'Zoé B.', 'Alix M.'],
        },
        alreadyPresent: [],
      }),
      course({
        id: 'demo-fiona::Feuille 1::4',
        title: 'Julio & Fiona - débutant 1',
        workbook: 'Julio & Fiona - débutant 1',
        roster: {
          'leader:active': [],
          'follower:active': ['Amandine R.', 'Bérénice I.', 'Chloé D. J.'],
          'leader:trial': ['Damien N.', 'Émile R.', 'Farid M.', 'Gaspard S.', 'Hugo C.'],
          'follower:trial': ['Karine C.', 'Léa D. S.', 'Maud O.', 'Nadia N.', 'Olivia'],
        },
        alreadyPresent: ['Amandine R.'],
      }),
    ],
  };
}

export function demoWorkbooks(): Workbook[] {
  return [
    {
      id: 'demo-diana',
      label: 'Julio & Diana - mardi',
      title: 'Julio & Diana - mardi',
      reachable: true,
      courses: ['Julio & Diana - Inter-Avancé 1', 'Julio & Diana - Faux-Débutant 1'],
    },
    {
      id: 'demo-fiona',
      label: 'Julio & Fiona - débutant 1',
      title: 'Julio & Fiona - débutant 1',
      reachable: true,
      courses: ['Julio & Fiona - débutant 1'],
    },
  ];
}

interface DemoCourse {
  id: string;
  title: string;
  workbook: string;
  roster: Record<string, string[]>;
  alreadyPresent: string[];
  /** A couple of notes, so the Commentaires column is visible in the demo. */
  notes?: Record<string, string>;
}

function course(spec: DemoCourse): Course {
  const [spreadsheetId, sheetName] = spec.id.split('::');
  const groups: Group[] = [];
  let row = 12;

  for (const category of ['active', 'trial', 'helper'] as const) {
    for (const role of ['leader', 'follower'] as Role[]) {
      const key = `${role}:${category}`;
      const names = spec.roster[key] ?? [];
      const first = row;
      const students: Student[] = names.map((name, index) => ({
        row: first + index,
        number: index + 1,
        name,
        present: spec.alreadyPresent.includes(name),
        comment: spec.notes?.[name] ?? '',
      }));
      const free = Array.from({ length: Math.max(0, 7 - names.length) }, (_, index) => ({
        row: first + names.length + index,
        number: names.length + index + 1,
      }));

      groups.push({
        key,
        label: key,
        role,
        category,
        nameColumn: role === 'leader' ? 3 : 13,
        sessionColumn: role === 'leader' ? 4 : 14,
        commentColumn: role === 'leader' ? 10 : 20,
        sessionColumns: DEMO_SESSIONS,
        students,
        freeSlots: free,
      });
    }
    row += 12;
  }

  return {
    id: spec.id,
    spreadsheetId,
    sheetName,
    title: spec.title,
    titleRow: 4,
    workbookLabel: spec.workbook,
    hidden: false,
    hasSession: true,
    sessionLabels: DEMO_SESSIONS.map((session) => session.label),
    groups,
  };
}
