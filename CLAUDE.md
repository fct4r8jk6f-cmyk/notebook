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

`sw.js` is the sole exception, and it is a forced one: a service worker cannot
be registered from a `blob:` or `data:` URL, so caching the shell for offline
use costs exactly one extra file. `index.html` still runs standalone —
registration is wrapped in a `try`/`catch` and skipped on `file:`. Don't add a
third file without the same kind of reason.

To run it: open `index.html` in a browser. That's the whole dev loop.

## Layout of the file

| Lines (approx) | What |
| --- | --- |
| 1–15 | `<head>`, PWA meta, base64 SVG icons |
| 16–~430 | `<style>` — the entire visual system |
| ~430–500 | `<body>` markup — header (brand, ask, settings, Add), `#page`, `#tabs`, `#overlay`, `#whisper` |
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
{ id, kind, text, ink, date, time, bucket, done, doneAt, doneKey, carried, touched,
  source: {quote, at, via}, question: {q, options:[{label, act}]},
  bill, renewal, debt, goal, event }
```

- **kinds**: `task · bill · goal · idea · renewal · debt · health · routine · scrap · event`
- **bucket**: `day | week | next-week | someday | goals | ideas`
- **There are no samples.** `seed()`, `clearSamples()`, the `sample` field, the
  `sampletag` markup and the `meta.seeded` / `meta.firstDumpDone` flags are all
  gone. A new book opens empty with a line telling you what to do — pre-filled
  fake entries read as someone else's notes and had to be cleared before the app
  was usable. Don't reintroduce them.
  Two purge points remain, and both are deliberate: `migrate()` drops any
  `sample` item on load, so a notebook written on the old build sheds them the
  moment it opens rather than waiting for a first dump; and `mergeBooks()` drops
  them too, so a device still running the old build can't push them back down
  through the gist.
- `question` parks an item as a sticky asking the user something; answering it
  runs an `act` (see `answerQuestion` / `actLabel`).
- `touched` is an ISO instant stamped centrally in `flush()` by diffing each
  item against the last write — call sites never set it. It's what lets two
  devices merge item by item. Don't stamp it by hand, and don't include it in
  the fingerprint used for the diff or every save re-stamps everything.
- `doneKey` is the **local** day something was ticked, and it's what the Done
  page groups by. `doneAt` is an ISO instant — don't group by `doneAt.slice(0,10)`,
  that's the UTC day and lands things under the wrong heading after teatime.
  `dayItems().done` groups by it too, so **clear `doneKey` on every un-tick** or
  the item keeps showing as done under that day. There are two un-tick paths
  (`tick()` and the `restore` action) and both have to do it.

## The two brains

`extract(text)` is the entry point. It picks:

The model is chosen in Settings from `MODELS` (Opus 5 default, Sonnet 5,
Haiku 4.5); `DEFAULT_MODEL` is the head of that list. **These models think by
default and `max_tokens` caps thinking *and* the reply together** — that's why
extraction asks for 8000 and the Desk 2000, not the 2000/300 they used before.
Cutting those budgets truncates mid-JSON or mid-sentence. `migrateSettings()`
moves notebooks off the superseded default.

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
only in a *priced* sentence — a bare number, after date fragments are stripped
so `due the 8th` isn't read as `$8`. It trusts a bare number only when exactly
one survives that stripping. Widen it carefully: every loosening risks reading a
date, a time or a quantity as money.

`stripWhen(s)` holds those date/time patterns in one place. `parseAmount` uses it
so a due date isn't read as money, and the bill titler uses it so a bill isn't
named after its own due date (`"rent 1200 monthly on the 1st"` → **Rent**, not
"Rent 1200 on the 1st" sitting next to a `$1,200` in the same row).

**A price plus a rhythm or a due date is a bill, whatever it's called.** The bill
branch used to require a word from `BILL_WORDS`/`PAY_WORDS`, so
`spotify 11.99 monthly` matched nothing and fell through to the chatter fallback
— which files nothing. Typed money vanished. `priced` (a cadence or the word
"due") now opens the branch on its own, and it's the reason `parseAmount` is
allowed to trust a bare number there.

**Nothing you write may be silently dropped.** The offline brain used to stop at
`segs.slice(0, 12)` and `items.length >= 6`, so a twelve-line brain-dump lost
everything after the sixth thing — at the app's main entrance. The caps are 60
segments / 40 items now (and 40 on the Claude path), which exist only to stop a
pasted document filing a hundred rows. Never lower them back into the range of
ordinary use.

Segment order in `localExtract` is significant — the first matching branch wins.
Events and birthdays are read **first**, before money and before to-dos, so
"mum's birthday, get a cake, 30 quid" is a birthday with an errand attached
rather than a bill — and because a birthday isn't something you tick off.
`insurance` is in both `BILL_WORDS` and `RENEWAL_RE`, so the renewal branch
explicitly stands aside when there's an amount. Debt is read before both, which
is what keeps `i lent sam 75 due friday` out of Bills.

`I_OWE_RE` vs `THEY_OWE_RE` turn on the name in the middle: `pay me back` is owed
*to* you, `pay mike back` is owed *by* you. The lookahead excluding `me|us` is
what separates them — don't collapse it.

`RENEWAL_RE` is built from a `RENEWS` fragment (`renew(?:s|al|ed|ing)?`). It used
to spell it `renewal?`, which only ever matched "renewa" — so "car insurance
renews in September", the most natural phrasing there is, matched nothing and
fell through to the chatter fallback.

The API key is stored in localStorage on the device only, is never sent
anywhere but Anthropic, and is stripped from `NB.exportJSON()` and preserved
(not overwritten) on import. Keep all three of those properties.

`askDesk(question)` is the ask (`✦`) path — same API, feeds it
`notebookDigest()` as context. Key-gated for the *reply*, but it always runs
`search()` locally, so it stays useful without a key.

`search(q)` matches on **terms**, not the whole phrase, minus stopwords, with
plurals folded to singular and a bonus when the full phrase lands intact. It
was once `hay.includes(needle)` with the entire question as the needle — so
"when's rent due?" only matched an item literally containing that sentence, and
the keyless Desk answered "nothing in the book" to nearly everything.

## Sync

The same notebook on every device, with no server: the whole book is one JSON
blob in a **private GitHub Gist**. `settings.gistToken` is a GitHub token with
the `gist` scope, held on the device exactly like `apiKey` — stripped from
`exportJSON()`, preserved on import, and never written into the gist.

**Only the book travels.** The gist body is `{ items, graves }` and nothing
else: settings, both tokens and the theme stay local. Don't widen that payload
without a reason — it's what keeps the keys on the device.

`mergeBooks(mine, theirs)` merges **per item**, not per notebook, so a note
written on the phone and one written on the laptop both survive. Conflicts on
the same `id` go to the higher `touched`. Deleting records a headstone in
`meta.graves[id]`; an item is buried when its grave is newer than its `touched`,
and revived when it was edited after the delete. Graves are pruned after 90
days. `withUndo` snapshots graves alongside items — undoing a toss has to
unwind the headstone too, or sync re-buries the item.

Sync runs on boot, when the app comes back to the front, and 2.5s after an edit
settles (`queueSync`). It is never blocking and never fatal: offline just sets
`NB.sync.status = 'error'` and the notebook carries on. `applyingSync` guards
the write-back so applying a merge doesn't queue another sync. A `PATCH` is
skipped when the merged body matches what was pulled, so idle devices don't
pile up gist revisions.

The gist is private, but it is not encrypted — the trust model is the same as
any private repo. Adding a passphrase would mean losing the notebook if it were
forgotten, so it's deliberately not there.

## Sharing

Sending someone the link gives them **their own empty notebook**, saved on their
device. That already worked — the page holds no per-user state, so the URL is
just the address of the page — but nothing said so, so Settings has a **Share
the link** action: `navigator.share` where it exists, clipboard otherwise, the
bare URL as the last resort. It shares `location.origin + location.pathname`
and never `location.href`: no query, no gist id, no token.

`privacy.js` in the scratchpad is the proof, and it's worth keeping — it opens
two browser contexts and asserts the second sees an empty book, that neither
key travels, that writes on one never reach the other, and that the shipped file
contains nothing key-shaped.

## Bill rhythms

Bills repeat on a `cadence`: `weekly · fortnightly · monthly · bimonthly ·
quarterly · semiannual · yearly · once` (see `CADENCE`). Two shapes exist and
the distinction matters:

- **Plain monthly** — `dueDay` (day-of-month), `anchor: null`. Paid keys are
  `YYYY-MM`. This is what every bill looked like before cadences, so notebooks
  written then keep every tick. `isPlainMonthly()` is the test.
- **Everything else** — an `anchor` date, one known occurrence. Paid keys are
  the occurrence date itself (`YYYY-MM-DD`).

`dueDay` is a number **or the string `LAST_DAY` (`'last'`)**, meaning the end of
whatever month it is — Feb 28, Apr 30, Jan 31. Don't collapse it to `31`: that
clamps to 28 in February and then the label lies about the rhythm. Anything
comparing `dueDay` numerically has to handle the sentinel (`billOccurrence`
does). `LASTDAY_RE` reads it out of a dump ("last day of the month", "month
end", "eom") and it implies `monthly` on its own, so the filer isn't left
guessing a rhythm the sentence already gave.

`parseCadence` checks `6 months` and `2 months` **before** the bare `month`
branch — otherwise "every 6 months" files as monthly.

`billNth(it, n)` always measures from the anchor, never by stepping the previous
result: a month-end date clamped once (Nov 31 → Nov 30) would otherwise keep the
shorter day forever and drift earlier every period. Don't "simplify" it into a
loop that adds a month to the last result.

`billMonthTotals(it, mk)` splits a month into `due / paid / unpaid` by counting
occurrences — a fortnightly bill lands twice in most months, and a weekly bill
ticked once is not ticked four times. Never total a bill as `amount × 1`.

`bill.since` is the day the bill was written down, and **nothing is owed for a
cycle that ended before it**. Writing "rent on the 1st" on the 27th used to
surface instantly as *"was due Wed — still open"* for a rent that was never
recorded, and counted against the month's total. `billDueDate` skips occurrences
before `since`, and `billOccurrencesInMonth` doesn't count them. Bills in
notebooks written before `since` existed have none, and `billSince()` returning
`null` deliberately preserves their old behaviour rather than silently dropping
a cycle they may have ticked.

Changing a bill's cadence resets `paid` (a cycle means something different
afterwards) and carries the date across by reading `billDueDate` *before*
switching. `since` is left alone — it records when you wrote the bill down, not
what rhythm it's on.

## Events and birthdays

An `event` item is `{on, annual, born}`. A **birthday is just an event that
ignores the year** — `annual: true` — so there is one kind, one form and one
editor rather than two of each. `eventFallsOn` compares `MM-DD` for annual ones;
`eventNext` finds the next occurrence, and returns `null` for a one-off that has
already passed. Feb 29 in a common year is marked on the 28th rather than
skipped: a birthday that vanishes three years in four is a bug, not a purist
point.

`born` is the **birth year, and only when the text actually stated one**.
`on` always carries some year so date maths works, but that year is usually a
guess — deriving an age from it reported "mum's birthday is 14 March" as her
turning 1 the following year. `eventAge` reads `born` alone; `bornFrom()` accepts
a hand-picked year only when it's in the past.

`ANNUAL_RE` (birthday, bday, was born, anniversary) decides recurrence;
`EVENT_RE` catches the one-offs — a concert, a wedding, a flight, an exam. You
don't tick a wedding, which is why events are echoes rather than tasks.

## Views

Five tabs: `today · calendar · money · notes · done`. Three of them group what
used to be scattered across a ten-destination nav:

- **Calendar** → Week · Month · Year (`CAL_TABS`, state in `calTab`)
- **Money** → Bills · Owed · Renewals (`MONEY_TABS`, state in `backTab`)
- **Notes** → Ideas · Goals · Health (`NOTES_TABS`, state in `notesTab`)

**Week didn't become a sixth tab when Month and Year arrived.** They're three
zooms of the same thing, so they group. Five is still the ceiling.

The **month** grid is the one place a 7-across layout fits, because a cell holds
a number and a few 4px dots rather than the day cards the week shows. `dayMarks`
returns one mark per *kind*, never per item — thirty dots on the 1st is noise,
and the month is meant to show the shape of the month. No box around each day
either: 35 outlined cells reads as a spreadsheet. Only today and the open day
get a shape.

The **year** is twelve rows, not twelve grids — 84 unreadable cells a month is
exactly the overwhelm a year view should remove. It carries no bar chart: a bar
scaled to the busiest month drew a single birthday as near-full, which is a
chart that lies. The count is the honest number and the names are what you came
for.

Both render through the same `grouped(tabs, current)` helper, which draws a
horizontal segmented control above the page and looks the sub-page up in `PAGES`.
Adding a sub-page means adding to the list and to `PAGES` — nothing else. A tab
shows a dot when one of its sub-pages has a parked question.

This replaced `today · week · goals · ideas · done · back` plus a rotated
vertical rail of back pages. Ten destinations for a notebook is a menu, not a
notebook; the rail in particular was unreadable sideways and unhittable on a
phone. Don't grow the top row back past five.

There is no People page. It was removed along with the `person` kind and
birthday extraction; `migrate()` in `load()` turns any surviving `person` item
into an idea so old notebooks don't strand data. Don't reintroduce a `person`
kind without a page to show it on.

**Week stacks, it isn't a spread.** `.app` caps at `max-width: 760px`, so a
7-across grid can't fit its column at any viewport — the old
`grid-template-columns: repeat(7, minmax(128px,1fr))` with `min-width: 940px`
overflowed everywhere and hid Sunday behind a scrollbar phones don't draw. Don't
reintroduce a horizontal week without widening `.app` first.

**A ticked thing stays on its day, struck through.** `dayItems(key)` returns a
`done` bucket alongside `timed / tasks / carried / echoes`; Today renders it as a
"done today · n" band under the jot line, and each Week day appends it to the
bottom of the card. Ticking again puts the item straight back on the open list.
They used to vanish to the Done page the instant you ticked them, which read as
the notebook eating your work — a list you can't see the end of is not a list.
The Done page is unchanged and still earns its place: it's the history *across*
days, not today's page.

Because of that, "nothing here" and "all of it done" are different empty states.
Don't tell someone who just cleared their list that they haven't started.

Bills, renewals and debts are edited in place: tapping the row's `✎` (or its
name) expands `detailHTML`, which live-saves each field on `change`. The pencil
exists because the name alone was tappable with nothing on screen saying so, so
bills read as immutable. Any row that can be edited needs a visible affordance.

Rendering is full-redraw string templating: each view returns an HTML string,
`render()` swaps `#page.innerHTML`, `renderTabs()` swaps the nav. No virtual DOM,
no incremental patching. **Always `esc()` user text** — it goes straight into
`innerHTML`.

Events are delegated from the container down (`data-act`, `data-view`,
`data-set`, `data-backtab`, `data-notestab` attributes), not bound per-row —
rows are destroyed on every render.

**Touch targets are measured, not eyeballed.** Every control clears 32px each
way, and the header buttons clear 44. `.tick` is the pattern to copy: the button
is 34px so a thumb lands, and the 21px circle you actually see is an absolutely
positioned `::before` behind the `✓` (`isolation: isolate` on the button is what
keeps the circle *behind* the tick mark rather than painted over it). Enlarging
the circle instead would shout; shrinking the button loses the tap.

## Time

- Dates are `YYYY-MM-DD` **local** strings (`toKey`/`fromKey`), never `Date`
  objects in state and never UTC/ISO. `fromKey` builds `new Date(y, m-1, d)`
  deliberately — don't "simplify" it to `new Date(str)`, that parses as UTC and
  shifts the day.
- `rollover()` carries unfinished items forward and bumps `carried`. It runs at
  boot, on tab-focus, and on a 60s interval, because an installed PWA can stay
  open across midnight for days. Don't assume boot-only.
- It carries **`task` and `scrap`** — both are dated and both sit on a day, so
  leaving scraps behind stranded them on a page nothing renders. An unfinished
  thing quietly disappearing is the one outcome a notebook must never produce.
  Dated `health` items deliberately don't move: an appointment isn't a to-do.

## Voice and design

Read the CSS banner comment before touching styles. The system is deliberate:

- **One typeface: Source Sans 3** (400/600), and it is the *only* thing embedded.
  `--hand`, `--disp` and `--fig` all resolve to it, so the existing `.hand` /
  `.fig` classes still work and simply render as one clean face. Shantell Sans
  and Caveat are gone — five `@font-face` blocks of base64 that took the file
  from 700KB to 200KB when removed, and made every list read like a ransom note.
  `plainHand` is kept as a setting but no longer has two faces to swap between.
- **No skeuomorphism.** No paper grain, no tape, no rotation, no dog-ears —
  `.pen`, `.penline`, `.flourish`, `.dogear`, `.clip` and `.grain` are all
  `display: none` on purpose. They read as clutter, not as paper.
- Themes: `day` and `night` (`:root[data-theme="night"]`), plus `auto`.
  `applyTheme()` writes the attribute; every colour is a CSS custom property —
  add tokens, don't hardcode hex.
- **No red anywhere.** Amber (`--warn`) is the heads-up, heavier ink is urgency.
  Guilt is not a colour. Overdue things get weight, not alarm.
- Copy is plain and calm — "Settings", "Add", "Ask your notebook", "Add bill".
  The old private vocabulary (the flyleaf, the ribbon, the desk, back pages, "rule
  the line") meant nothing to anyone opening the app for the first time. Warmth
  stays in the whispers and the brief; the *labels* say what they do. No "Error:",
  no "Are you sure?", no exclamation marks.
- Empty states say what to do next, since the notebook no longer arrives
  pre-filled. An empty page with no instruction is the app's worst first screen.

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
- The ask button (`#ribbon`) is now an ordinary 44px button in the header flow,
  not a fixed bookmark hanging off the corner. As a fixed element at `z-index: 30`
  it sat over the Add button and silently ate its taps — `elementFromPoint`
  returned the ribbon, and nothing on screen showed why. Anything placed top-right
  needs to be *in* `.chrome`, not floated above it.
- **Writing a to-do is a one-line form, not a dialog.** `jotHTML(date, label)`
  renders `.jot` on Today and inside every day of the Week; the `jot` branch of
  the submit delegate files it as a `task` on that date, runs `parseWhen` so
  "gym at 6pm" keeps its time, then re-focuses the field after the redraw so a
  list can be written a line at a time. It replaced `.addday`, an 11px `+`
  revealed on `:hover` (which no touch screen has) that called `window.prompt`
  — a dialog an installed PWA is allowed to refuse outright. Don't reach for
  `prompt`/`confirm` anywhere in this app.
- The jot placeholder uses `--muted`, not `--faint`. It's the only thing telling
  you the line is writable, and `--faint` on the field clears barely 2.9:1.
- **Never call `render()` from inside a `change` handler** — use `queueRender(ed)`.
  A `change` on a typed field fires *during* blur, so a synchronous redraw rips
  out the node the browser is still moving focus to and `innerHTML` throws "the
  node to be removed is no longer a child of this node". `queueRender` defers to
  the next frame and puts focus back on the field that changed, but only if the
  redraw dropped it on the floor — if you tabbed on to something real, you stay
  there.
- `--faint` clears 4.5:1 **on the page background**, not just on a card. It was
  #8B95A1 (2.8:1 on `--bg`) and it carries all the small print — day names, band
  labels, a bill's rhythm. If you lighten it, measure it against `--bg`.
- **Don't fade text with `opacity` to say "secondary".** It multiplies with
  whatever colour is already there: `.day.is-past` at `.6` dragged the day name
  to 2.4:1, and an `.8` on a done row put struck `--faint` text at 3.3:1. A past
  day recedes with a transparent background and a dashed border instead. Use a
  token, not a fade — and note `getComputedStyle(el).color` never shows an
  ancestor's opacity, so a contrast check that ignores it reads clean.
- **`appearance: none` in the input reset strips the native checkmark**, so a
  ticked checkbox looked exactly like an empty one — autopay, "every year" and
  the settings toggles all read as off however they were set. The checkbox block
  that draws the state back lives at the *end* of the stylesheet on purpose:
  `.addform input` has the same specificity, so source order decides, and its
  11px padding was also forcing the box wider than its own 22px square.
- The tab bar is `position: sticky; bottom: 0` with a translucent, blurred
  background, so page content passes under it. `.page` carries bottom padding to
  clear it — without that the last row of a long page is visible enough to look
  present and not tappable.
- `fmtTime` puts the time in the row's own chip, so `stripTime()` takes it back
  out of the label — otherwise every timed row reads "🕕 6pm  gym at 6pm". It's
  only called when `parseWhen` actually found a time, and it keeps the original
  if stripping would empty it.
- `.whisper` needs `width: max-content` before its `max-width`. Without it the
  toast stretches the full clamp and one short word wraps oddly mid-phrase.
- The manifest is built at runtime from a Blob URL — there is no `manifest.json`
  file, on purpose.
- `sw.js` caches the app shell, network-first: merging deploys through Pages,
  and a cache-first worker would serve a stale notebook to someone online. It
  handles same-origin GET navigations only — never the Anthropic API, since a
  cached POST reply would be a stale sort. The page has no other network
  dependency (the font is base64, icons are data URIs, the manifest is a blob),
  so the shell is the whole cache.
- `fmtAmt` prints cents only when there are cents. `$142.5` reads like a typo;
  `$1,200` with a forced `.00` reads like a spreadsheet.
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
- There is no test runner in the repo (that would be a toolchain). Verify by
  opening the file in a browser and exercising the path you changed — add
  something, check the tab it lands in, toggle both themes. Driving it with
  Playwright from a scratch directory is the practical way to do that at scale;
  the suites live outside the repo on purpose.
- Layout claims need measuring, not eyeballing. Three of the bugs above
  (`elementFromPoint` returning the ribbon over the dump button; `.weekscroll`
  at 346px holding a 940px grid; every tick being a 21px target) were invisible
  in a screenshot and obvious in a `getBoundingClientRect` dump. Check at 390px
  wide, not just desktop.
- **Verify the theme actually applied.** `addInitScript` re-runs on every
  navigation, so a theme set at runtime is wiped by the next reload and the
  "dark" screenshots come back light. Seed it into the stored blob and assert on
  `document.documentElement.dataset.theme` before believing a screenshot.
- **Measure what a thumb lands on, not the element you happen to have.** A
  checkbox is 22px on purpose and its `<label>` is the target; a coverage check
  must `scrollIntoView` first, because measuring at whatever offset the page
  happens to be at is not a claim about reachability.
- Seed storage **once** (`if (!localStorage.getItem(...))`), not on every
  navigation, or a reload wipes the notebook the test is trying to prove
  survives. Same trap as the theme one above.
- Exercise the real filing path (`NB.fileExtraction`), not `NB.addItem` on raw
  extractor output. `addItem` skips the bill/renewal/debt shaping, and every money
  page filters on those objects — so the pages come up empty and look broken when
  nothing is wrong.
- Diffs on `index.html` are the entire changelog. Keep changes surgical and the
  commit message explanatory (say *why*, like the overlay fix did).
