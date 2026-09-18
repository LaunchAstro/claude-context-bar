# Astro Context Bar

A dependency-free status line for [Claude Code](https://claude.com/claude-code).
One line, at the bottom of every pane, showing what the session is actually
costing you:

```
Opus 5 │ my-project │ █░░░░░░░░░ 14% 117k/1M │ $3.37 │ alex · 5h 54% exp 2h · 7d 44% exp 3d
```

| Segment | Meaning |
|---|---|
| `Opus 5` | Model, from Claude Code's own display name |
| `my-project` | Working directory (basename) |
| `█░░░ 14% 117k/1M` | Context consumed, rescaled onto the *usable* window, plus the raw tokens held |
| `$3.37` | Cumulative cost for this session |
| `alex` | The **seat** — which account's subscription this pane is spending |
| `5h 54% exp 2h · 7d 44% exp 3d` | Burn against the 5-hour and 7-day quotas, and how long each window has left before it resets |

The two numbers measure different things and must not be added up: the token
count is what is sitting in the window **right now** (it drops after a
compaction), while the dollar figure is **cumulative** and only ever climbs.

Colour ramp is shared by the bar and the quota figures — green under 50%, amber
to 65%, orange to 80%, red above. The context bar flashes once it goes red.

## Requirements

Node 18 or newer. Nothing else — no packages, no install step, no network.

## Install

Put `claude-statusline.js` anywhere you like and point Claude Code at it in
`~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node /path/to/astro-context-bar/claude-statusline.js"
}
```

If `node` is not on the PATH Claude Code sees, give the absolute path to it
(`/usr/local/bin/node`, `/opt/homebrew/bin/node`, …). `$HOME` is expanded, so a
path under your home directory stays portable across machines.

Restart a session to pick up changes — a running pane keeps the version it
booted with.

## The countdown

`exp 2h` is how long that quota window has left. It always rounds **down**, so
the bar never claims more room than there is: 1.9 days left reads `1d`, not
`2d`. The last minute reads `<1m` rather than `0m`, which would look expired.
Once a window's reset stamp passes, its countdown simply disappears.

## The seat name

Claude Code puts no account anywhere in the status line payload, so the seat is
worked out from the config directory the session booted with, in this order:

1. The local part of the signed-in email in `.claude.json` — `alex@example.com`
   becomes `alex`.
2. The config directory's own name, when `CLAUDE_CONFIG_DIR` points at one
   called `.claude-seat-<name>`. This is the fallback for a seat that signed
   in with a long-lived token and so never cached a profile.
3. `api`, when there is no subscription behind the session at all.

This is most useful if you run several subscriptions side by side, each under
its own `CLAUDE_CONFIG_DIR`, and want to know which one a pane is spending.

## Narrow panes

Claude Code passes the pane's width in `COLUMNS`, and the line gives up detail
until it fits — least useful first:

| Order | Given up | Example at that width |
|---|---|---|
| 1 | Token counts | `Opus 5 │ my-project │ ██████░░░░ 66% │ $3.63 │ alex · 5h 28% exp 2h` |
| 2 | The bar glyphs (the percentage and its colour stay) | `Opus 5 │ my-project │ 66% │ $3.63 │ alex · 5h 28% exp 2h` |
| 3 | Cost | `Opus 5 │ my-project │ 66% │ alex · 5h 28% exp 2h` |
| 4 | Directory | `Opus 5 │ 66% │ alex · 5h 28% exp 2h` |
| 5 | Model | `66% │ alex · 5h 28% exp 2h` |
| 6 | The countdowns | `66% │ alex · 5h 28%` |

The quota figures and the seat name are never given up — they are what the
bar is for. Below roughly 30 columns even that will not fit, and the line is
allowed to run long rather than say nothing useful.

If `COLUMNS` is not set, nothing is given up: an unknown width is not a reason
to render less than you asked for.

## Why the percentage looks lower than you expect

Claude Code reserves a slice of the window for auto-compaction, so the raw
remaining percentage never reaches zero. The bar rescales onto what is actually
usable, so 100% means "out of room now", not "out of room eventually". Override
the reserve with `CLAUDE_CODE_AUTO_COMPACT_WINDOW` if it ever changes.

## Degrading

Every segment is independent, and one that has no data is left out rather than
guessed at. A session with no subscription behind it shows no quota figures; a
payload with no cost shows no dollars. If the payload cannot be parsed at all,
the script exits quietly and Claude Code falls back to its own default — a
status line that fails is worth less than no status line.

## Tests

```
node --test
```

No dependencies, and no running session needed: `render()` is a pure function of
the payload, the clock and the environment, and the process only touches stdin,
the clock and the disk inside `main()`.

## Licence

MIT — see [LICENSE](LICENSE).
