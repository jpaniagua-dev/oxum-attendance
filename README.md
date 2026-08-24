# Attendance kiosk

Attendance taking for Julio's dance classes at Bachata Geneva Dance Studio. A tablet
sits in the room, students tap their own name on arrival, and the teacher pushes the
session into the school's Google Sheet at the end of the class.

Background, decisions and open questions live in the hub: `projets/presence-cours.md`.

Interface copy is French because the students read it. Everything else here — code,
comments, commits, this file — is English.

## Why it works without secrets

Both workbooks belong to the school and are shared **with edit rights** with
`julio@paniagua.dev`. The backend is an **Apps Script web app deployed as that user**,
so it inherits those rights: no service account, no OAuth secret, nothing to host.

## Workbook layout

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

### `GET ?token=…&date=YYYY-MM-DD`

`date` is optional and defaults to today. Returns every class in both workbooks:

```json
{
  "ok": true,
  "date": "2026-08-25",
  "courses": [{
    "id": "<workbookId>::<tabName>::<titleRow>",
    "title": "Julio & Diana - Inter-Avancé 1",
    "hasSession": true,
    "sessionLabels": ["25.08", "1.09", "…"],
    "groups": [{
      "key": "leader:active",
      "role": "leader", "category": "active",
      "nameColumn": 3, "sessionColumn": 4,
      "students": [{ "row": 12, "number": 1, "name": "…", "present": false }],
      "freeSlots": [{ "row": 15, "number": 4 }]
    }]
  }]
}
```

`hasSession: false` means no column matches that date. The kiosk must say so rather than
write somewhere else.

### `POST`

```json
{
  "token": "…",
  "courseId": "…",
  "date": "2026-08-25",
  "marks": [{ "group": "leader:active", "row": 12, "name": "…", "present": true }],
  "additions": [{ "role": "follower", "name": "Camille B.", "present": true }]
}
```

The workbook is **re-read at write time**. A mark is applied only if the name still
sitting on that row is the one the kiosk believed was there; otherwise it goes to
`rejected` with a reason. Nothing is guessed. Unticked students are written `FALSE`.

`marks` must carry `group`: without it a row is ambiguous between leader and follower.

Post from a browser with `Content-Type: text/plain;charset=utf-8`. Apps Script does not
answer CORS preflight, and any other content type triggers one.

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

`web/config.js` ships the token to the tablet's browser, so anyone who can read the
kiosk page source can read the token. It stops the deployment being found and poked at;
it is **not** authentication. The exposure is bounded on purpose: the worst a leak buys
is writing attendance ticks into a sheet that keeps its own revision history. Do not
extend this script to read or write anything more sensitive under the same token.

## Deploying the kiosk

`web/` is a static PWA — any HTTPS host will do (GitHub Pages, Netlify, Cloudflare
Pages). HTTPS is required: service workers do not register over plain HTTP.

1. Copy `web/config.example.js` to `web/config.js` and fill in the deployment URL and
   token. `config.js` is git-ignored.
2. Publish the contents of `web/`.
3. Open it on the tablet and use the browser's "add to home screen" so it launches
   full screen.

Without `config.js` the page runs in **demo mode** on built-in sample data — useful for
looking at the interface without touching a real workbook.

## Tests

```sh
npm test
```

The tests load `Code.gs` into a `vm` context with Apps Script stubs and run it against
grids rebuilt to match the real workbooks — **with invented names**. The school's actual
roster never enters this repo.
