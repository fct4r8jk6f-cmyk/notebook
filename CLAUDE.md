# My Notebook

A single-file, local-first PWA: a paper notebook that files your life for you.
Deployed via GitHub Pages off `main`.
You paste messy life into it ("the dump"), and a librarian sorts it into dated
items, bills, renewals, debts and health notes.

## The one rule

**Everything lives in `index.html`.** No build step, no dependencies, no
package.json, no bundler. HTML + inline `<style>` + inline `<script>` blocks,
served as one file. Do not introduce a toolchain, a framework, or extra files
unless explicitly asked — the whole point is that it's one file you can email to
yourself and open anywhere.

To run it: open `index.html` in a browser. That's the whole dev loop.

## Layout of the file

| Lines (approx) | What |
| --- | --- |
| 1–15 | `<head>`, PWA meta, base64 SVG icons |
| 16–~430 | `<style>` — the entire visual system |
| ~430–465 | `<body>` markup — header, ribbon, `#page`, `#tabs`, `#overlay`, `#whisper`, grain |
| ~468–1180 | `<script>` **core.js** — store, item model, the two brains, the brief |
| ~1180–1960 | `<script>` **ui.js** — rendering, views, overlays, event wiring, `boot()` |
| tail | runtime-generated web app manifest (so Android offers a real install) |

Line numbers drift; find things by the banner comments and function names.

`window.NB` is the app's spine. core.js builds it, ui.js consumes it. Keep that
direction — ui.js should not own state, core.js should not touch the DOM (its
only outward calls are the `NB.onWhisper` / `NB.onStorageError` hooks that ui.js
assigns).

## State

- One localStorage key: `notebook-v1` (`STORE_KEY`).
- `save()` is debounced 150ms; `flush()` writes immediately. `boot()` flushes on
  `pagehide` and on `visibilitychange` → hidden.
- On parse failure the bad blob is preserved at `notebook-v1-corrupt` before
  resetting. Keep that behaviour — it's the only recovery path a user has.
- On quota errors `NB.storageError` is set and `NB.onStorageError` fires.

### Item model (`makeItem`)

```
{ id, kind, text, ink, date, time, bucket, done, doneAt, carried, sample,
  source: {quote, at, via}, question: {q, options:[{label, act}]},
  bill, renewal, debt, goal }
```

- **kinds**: `task · bill · goal · idea · renewal · debt · health · routine · scrap`
- **bucket**: `day | week | next-week | someday | goals | ideas`
- `sample: true` marks the watermark seed items — `clearSamples()` deletes all of
  them the moment the first real dump lands. Seeds must never survive real use.
- `question` parks an item as a sticky asking the user something; answering it
  runs an `act` (see `answerQuestion` / `actLabel`).

## The two brains

`extract(text)` is the entry point. It picks:

1. **`claudeExtract`** — used only when `settings.apiKey` is set. Calls
   `https://api.anthropic.com/v1/messages` directly from the browser with
   `anthropic-dangerous-direct-browser-access: true`, a `json_schema` output
   config (`EXTRACT_SCHEMA`) and `effort: 'low'`. Handles `stop_reason:
   'refusal'` and non-OK responses with human-readable errors.
2. **`localExtract`** — the offline brain. Regex/heuristic parsing
   (`parseWhen` for dates, `parseAmount` for money, `parseCadence` for rhythms).
   Always available, no key, no network. **It must keep working on its own** —
   the key is optional and the app has to be fully usable without one.

`parseAmount(seg, moneyish)` reads `$1,200`, `60 bucks`, a bare `142.50`, and —
only in a bill/debt sentence — a bare number, after date fragments are stripped
so `due the 8th` isn't read as `$8`. It trusts a bare number only when exactly
one survives that stripping. Widen it carefully: every loosening risks reading a
date, a time or a quantity as money.

Segment order in `localExtract` is significant — the first matching branch wins.
`insurance` is in both `BILL_WORDS` and `RENEWAL_RE`, so the renewal branch
explicitly stands aside when there's an amount.

The API key is stored in localStorage on the device only, is never sent
anywhere but Anthropic, and is stripped from `NB.exportJSON()` and preserved
(not overwritten) on import. Keep all three of those properties.

`askDesk(question)` is the ribbon/chat path — same API, feeds it
`notebookDigest()` as context. Also key-gated.

## Bill rhythms

Bills repeat on a `cadence`: `weekly · fortnightly · monthly · quarterly ·
yearly · once` (see `CADENCE`). Two shapes exist and the distinction matters:

- **Plain monthly** — `dueDay` (day-of-month), `anchor: null`. Paid keys are
  `YYYY-MM`. This is what every bill looked like before cadences, so notebooks
  written then keep every tick. `isPlainMonthly()` is the test.
- **Everything else** — an `anchor` date, one known occurrence. Paid keys are
  the occurrence date itself (`YYYY-MM-DD`).

`billNth(it, n)` always measures from the anchor, never by stepping the previous
result: a month-end date clamped once (Nov 31 → Nov 30) would otherwise keep the
shorter day forever and drift earlier every period. Don't "simplify" it into a
loop that adds a month to the last result.

`billMonthTotals(it, mk)` splits a month into `due / paid / unpaid` by counting
occurrences — a fortnightly bill lands twice in most months, and a weekly bill
ticked once is not ticked four times. Never total a bill as `amount × 1`.

Changing a bill's cadence resets `paid` (a cycle means something different
afterwards) and carries the date across by reading `billDueDate` *before*
switching.

## Views

Tabs: `today · week · goals · ideas · done · back`. "Back Pages" holds the
sub-pages: Bills, Renewals, Owed, Health — and shows a dot when any of those has
a parked question.

There is no People page. It was removed along with the `person` kind and
birthday extraction; `migrate()` in `load()` turns any surviving `person` item
into an idea so old notebooks don't strand data. Don't reintroduce a `person`
kind without a page to show it on.

**Week stacks, it isn't a spread.** `.app` caps at `max-width: 760px`, so a
7-across grid can't fit its column at any viewport — the old
`grid-template-columns: repeat(7, minmax(128px,1fr))` with `min-width: 940px`
overflowed everywhere and hid Sunday behind a scrollbar phones don't draw. Don't
reintroduce a horizontal week without widening `.app` first.

Rendering is full-redraw string templating: each view returns an HTML string,
`render()` swaps `#page.innerHTML`, `renderTabs()` swaps the nav. No virtual DOM,
no incremental patching. **Always `esc()` user text** — it goes straight into
`innerHTML`.

Events are delegated from the container down (`data-act`, `data-view`,
`data-set` attributes), not bound per-row — rows are destroyed on every render.

## Time

- Dates are `YYYY-MM-DD` **local** strings (`toKey`/`fromKey`), never `Date`
  objects in state and never UTC/ISO. `fromKey` builds `new Date(y, m-1, d)`
  deliberately — don't "simplify" it to `new Date(str)`, that parses as UTC and
  shifts the day.
- `rollover()` carries unfinished items forward and bumps `carried`. It runs at
  boot, on tab-focus, and on a 60s interval, because an installed PWA can stay
  open across midnight for days. Don't assume boot-only.

## Voice and design

Read the CSS banner comment before touching styles. The system is deliberate:

- Fonts: **Shantell Sans** (the working hand), **Caveat** (display), **Source
  Sans 3** (figures/numbers). `.hand` and `.fig` classes carry them. `plainHand`
  setting swaps the hand for print.
- Themes: `daylight` and `lamplight` (`:root[data-theme="night"]`), plus `auto`.
  Every colour is a CSS custom property — add tokens, don't hardcode hex.
- **No red anywhere.** Amber is the heads-up, heavier ink is urgency. Guilt is
  not a colour. Overdue things get weight, not alarm.
- Copy is warm, lowercase-ish, and physical: the flyleaf (settings), the ribbon
  (chat), the dump, whispers, stickies, back pages. Match it — no "Error:", no
  "Are you sure?", no exclamation marks.

Destructive actions go through `withUndo(label, fn)`, which snapshots items and
shows a 6-second whisper with undo. Use it for anything that removes or
completes.

## Gotchas

- `[hidden] { display: none !important; }` is load-bearing. `.overlay` and
  `.whisper` set `display: flex`, and author styles beat the UA sheet's
  `[hidden]` rule regardless of specificity. Without it the overlay stays laid
  out, `backdrop-filter: blur(3px)` covers the viewport, and every tap on the app
  is swallowed. Don't remove it; don't add another `display` rule to a
  `[hidden]`-toggled element without an `!important` guard.
- The fixed `.ribbon` (26px wide, `z-index: 30`) sits in the top-right corner
  above the chrome. `.chrome` reserves 48px of right padding to clear it —
  without that the ribbon overlaps the dump button and silently eats its taps.
  Anything else placed top-right needs the same clearance.
- `.addday` (the per-day `+`) reveals on `:hover`, which no touch screen has;
  the `@media (hover: none)` block keeps it visible. Watch for the same trap
  with any other hover-only affordance.
- The manifest is built at runtime from a Blob URL — there is no `manifest.json`
  file, on purpose.
- No service worker is registered (the `'serviceWorker' in navigator` branch is
  intentionally inert).
- Share-target text arrives as `?title=&text=&url=` query params at boot and
  opens the dump prefilled; `history.replaceState` clears it.

## Working in this repo

- Develop on the branch you were given; commit with a clear message; push with
  `git push -u origin <branch>`.
- **Don't leave work sitting in a pull request.** When a change is finished and
  verified, open the PR, merge it, then pull `main` and restart the branch from
  it (`git fetch origin main && git checkout -B <branch> origin/main`). No need
  to ask first — the owner wants it merged and pulled. Merging deploys, since
  Pages builds off `main`.
- Since there are no tests, verify by opening the file in a browser and
  exercising the path you changed — dump something, check the tab it lands in,
  toggle both themes.
- Layout claims need measuring, not eyeballing. Two of the bugs above
  (`elementFromPoint` returning the ribbon over the dump button; `.weekscroll`
  at 346px holding a 940px grid) were invisible in a screenshot and obvious in
  a `getBoundingClientRect` dump. Check at 390px wide, not just desktop.
- Diffs on `index.html` are the entire changelog. Keep changes surgical and the
  commit message explanatory (say *why*, like the overlay fix did).
