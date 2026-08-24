# Attendance

Attendance taking for dance classes at Bachata Geneva Dance Studio. A teacher opens the
app on a phone or tablet, hands it to whoever just walked in, and says *find your name*.
The tap reaches the school's Google Sheet on its own.

Background and decisions live in the personal hub: `projets/presence-cours.md`.

Interface copy is French because the students read it. Everything else — code, comments,
commits, this file — is English.

## What shapes the design

Three facts about a dance class, and what each one forces:

- **Students trickle in over the whole hour**, some of them late. So there is no "send at
  the end": a tap is written to the sheet immediately, and anything that cannot be sent
  yet is queued on the device until it can.
- **Either teacher may be the one holding the phone**, and sometimes the one who is not
  running late. So the app installs per device and each teacher configures their own,
  while the list of classes is shared server-side.
- **The school opens new classes mid-season**, each with its own workbook. So workbooks
  are added from the settings screen, never from a constant in the source.
- **The school teaches in French and English**, and a fair share of students are more
  comfortable in English. So the language switch sits in the class header rather than in
  the settings: the person who needs it is the one holding the phone, and they do not
  have the four-digit code.

## Layout

```
app/            Angular PWA — what the students touch
apps-script/    Google Apps Script backend, plus its tests
.github/        Pages deployment
```

## Why there are no secrets to manage

Both workbooks belong to the school and are shared **with edit rights** with
`julio@paniagua.dev`. The backend is an **Apps Script web app deployed as that user**, so
it inherits those rights: no service account, no OAuth secret, nothing to host.

## Workbook structure

The parser knows **no fixed addresses**. It locates blocks by their titles and derives
every other cell from there — deliberately, because the grid is maintained by hand and
shifts from one season to the next.

A tab is a stack of **sections**, one per class (`Julio & Diana - Inter-Avancé 1`). Each
section is two independent half-grids side by side: **leaders on the left, followers on
the right**. Each half stacks three blocks:

| Block title | `category` |
|-------------|-----------|
| `Leaders / Followers actifs` | `active` |
| `Essais Leader / Follower` | `trial` |
| `Aide Leader / Follower` | `helper` |

Under each block title sits a header row — `N° | Nom | <dates…> | Commentaires` — then
numbered rows. **A numbered row with no name is a free slot**, and that is where a
walk-in trial student gets written.

Traps the code handles explicitly:

- **The two halves use different columns** (dates in D–I on the left, N–S on the right)
  but **share row numbers**. A row only means something inside its own block, so a row is
  never resolved at course level.
- **Totals rows are formulas.** Only cells on named roster rows are ever written.
- **Block height is not constant** (usually 7 rows, 9 seen in the wild). Reading stops
  when the `N°` column stops holding a number.
- **Date headers are sometimes real dates, sometimes typed text.** Both collapse to an
  `MM-DD` key; the year is ignored, since a season runs August to June.

## API

Every response is HTTP 200 with an `ok` flag — Apps Script cannot choose a status code.
Post with `Content-Type: text/plain;charset=utf-8`: Apps Script does not answer a CORS
preflight, and any other content type triggers one.

### Reading

| Request | Returns |
|---------|---------|
| `GET ?action=session&date=YYYY-MM-DD` | every class in every registered workbook |
| `GET ?action=workbooks` | the registry, plus what each workbook holds |
| `GET ?action=ping` | a liveness check, used by the settings screen |

A class carries the addresses the app needs to write back:

```json
{
  "id": "<workbookId>::<tabName>::<titleRow>",
  "title": "Julio & Diana - Inter-Avancé 1",
  "hasSession": true,
  "hidden": false,
  "sessionLabels": ["25.08", "1.09"],
  "groups": [{
    "key": "leader:active",
    "nameColumn": 3, "sessionColumn": 4,
    "students": [{ "row": 12, "number": 1, "name": "…", "present": false }],
    "freeSlots": [{ "row": 15, "number": 4 }]
  }]
}
```

`hasSession: false` means no column matches that date. The app says so rather than
writing somewhere else.

### Writing

```json
{
  "action": "batch",
  "ops": [{
    "kind": "mark",
    "spreadsheetId": "…", "sheetName": "Feuille 1",
    "row": 12, "nameColumn": 3, "sessionColumn": 4,
    "name": "Antoine H.", "present": true
  }]
}
```

`kind: "trial"` writes a walk-in into a free row instead, name and tick together.
`kind: "comment"` writes free text into the block's `Commentaires` column — `commentColumn`
and `text` rather than `sessionColumn` and `present`. An empty string clears the cell,
which is how a note is removed.

Each operation is verified against the sheet as it is right now — the name on that row
must still be the one the app believed, and a trial row must still be empty — and each is
reported on independently. One student ticking after the school inserted a row must not
stop the next student being recorded. Refused operations come back with `stale: true` and
a reason; the app rolls back its optimistic tick and asks a human.

Operations are addressed by cell rather than re-scanned, so a tap costs two small range
reads instead of a full grid parse. A tick and a note on the same row are different cells
and never supersede one another in the queue.

### Managing workbooks

| Action | Effect |
|--------|--------|
| `addWorkbook` with a pasted Sheets URL or id | opened and parsed before it is stored |
| `removeWorkbook` | drops it from the registry; the sheet itself is untouched |
| `setHidden` | hides one class, for workbooks holding other teachers' classes |

The registry lives in script properties, so it is shared by every device.

## Deploying the backend

1. Create a **standalone** Apps Script project on `julio@paniagua.dev`
   (script.google.com → new project). Paste in `apps-script/Code.gs` and the contents of
   `apps-script/appsscript.json`.
2. Project settings → Script properties → add `KIOSK_TOKEN` with a long random value.
   **The script refuses every request until it is set.**
3. Deploy → New deployment → Web app: run as **me**, access **anyone**.
   Anonymous access is required — the tablet is not signed into a Google account. The
   `KIOSK_TOKEN` is what protects writes, not the sign-in.
4. Store both values in `pass`, never in this repo:
   `pass insert projets/presence-cours/apps-script-url`
   `pass insert projets/presence-cours/kiosk-token`

The deployment URL is itself a write credential. Treat it as a secret.

### What the token does and does not do

The token reaches every device that uses the app and sits in its local storage. Anyone
holding an unlocked phone with the app installed can read it. It stops the deployment
being found and poked at; it is **not** authentication. The exposure is bounded on
purpose: the worst a leak buys is writing attendance ticks into a sheet that keeps its
own revision history. Do not extend this script to anything more sensitive under the same
token.

## Deploying the app

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to
`main`. One setting has to be flipped by hand, once: **repository Settings → Pages →
Source → GitHub Actions**. A workflow cannot set that for itself.

The site then lives at `https://<owner>.github.io/<repo>/`.

## First run on a device

1. Open the site. With nothing configured it goes straight to the settings screen.
2. Paste the deployment URL and the token, set a four-digit code, and press **Tester**
   before saving.
3. Install it: *Share → Add to Home Screen* on iOS, *Install app* on Android.

The four-digit code guards the settings screen, because the device is handed around
during class. It is stored on the device and is not the `KIOSK_TOKEN`. **Leaving the
screen locks it again** — a back button that reopens an unlocked settings page protects
nothing. There is deliberately no recovery: a forgotten code means clearing the site data
for the app, which also clears the deployment URL and token.

The theme follows the device by default — a studio is bright in the afternoon and dim at
night, and a phone already switches on its own. Settings can force light or dark instead.

The interface language is French or English, switched from the two-letter control in the
class header. It is deliberately outside the settings screen: students switch it
themselves. `app/src/app/core/i18n.ts` holds both dictionaries; French is the source of
truth and the English record is typed against it, so a forgotten key fails the build
rather than the class.

**Demo mode**: the settings screen can load an invented studio, so the interface can be
tried and shown around before any Apps Script deployment exists. Nothing is written in
that mode.

## Development

```sh
npm test                 # backend parser and writer, no network needed
npm --prefix app start   # dev server
npm run build            # production build
```

On some constrained hosts esbuild's Go runtime deadlocks or segfaults partway through a
build. `GOMAXPROCS=1 NG_BUILD_MAX_WORKERS=1 npx ng build` avoids it; the CI runner does
not need either.

The tests load `Code.gs` into a `vm` context with Apps Script stubs and run it against
grids rebuilt to match the real workbooks — **with invented names**. The school's actual
roster never enters this repo, and neither does the demo data.
