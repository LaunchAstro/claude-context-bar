# Claude Context Bar

A dependency free status line for [Claude Code](https://claude.com/claude-code).
An unaffiliated community project, not made by or endorsed by Anthropic.

One line at the bottom of every pane, showing what the session is actually
costing you:

```
Opus 5 (1M) │ my-project │ ██████░░░░ 66% │ $3.37 │ alex · 5h 54% exp 2h · 7d 44% exp 3d
```

| Segment | Meaning |
|---|---|
| `Opus 5 (1M)` | The model, and the size of the context window it's actually running with |
| `my-project` | Working directory (basename) |
| `██████░░░░ 66%` | Context consumed, rescaled onto the *usable* window |
| `$3.37` | Cumulative cost for this session |
| `alex` | The seat, meaning which account's subscription this pane is spending |
| `5h 54% exp 2h · 7d 44% exp 3d` | Burn against the 5 hour and 7 day quotas, and how long each window has left before it resets |

Colour ramp is shared by the bar and the quota figures: green under 50%, amber
to 65%, orange to 80%, red above. The context bar flashes once it goes red.

## Requirements

Node 18 or newer. Nothing else. No packages, no install step, no network.

## Install

```sh
git clone https://github.com/LaunchAstro/claude-context-bar.git
```

Put `claude-statusline.js` anywhere you like and point Claude Code at it in
`~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node /path/to/claude-context-bar/claude-statusline.js"
}
```

If `node` isn't on the PATH Claude Code sees, give the absolute path to it
(`/usr/local/bin/node`, `/opt/homebrew/bin/node`, and so on). `$HOME` is
expanded, so a path under your home directory stays portable across machines.

Restart a session to pick up changes. A running pane keeps the version it
booted with.

## The context cap

`Opus 5 (1M)` is the real window size for that session, read from the payload
rather than guessed from the model's name. Boot on a 200k model and it says
`(200k)`. The figure and the percentage bar come from the same number, so they
can't drift apart.

Claude Code already spells the cap into the display name for some models
(`Sonnet 5 (1M context)`) but not others. That suffix gets stripped and the cap
restated, so every model reads the same way.

A payload that doesn't declare a window size gets no cap at all, rather than a
guessed one.

## The countdown

`exp 2h` is how long that quota window has left. It always rounds **down**, so
the bar never claims more room than there is: 1.9 days left reads `1d`, not
`2d`. The last minute reads `<1m` rather than `0m`, which would look expired.
Once a window's reset stamp passes, its countdown disappears.

## The seat name

Claude Code puts no account anywhere in the status line payload, so the seat is
worked out from the config directory the session booted with, in this order:

1. The local part of the signed in email in `.claude.json`, so
   `alex@example.com` becomes `alex`.
2. The config directory's own name, when `CLAUDE_CONFIG_DIR` points at one
   called `.claude-seat-<name>`. That's the fallback for a seat that signed in
   with a long lived token and never cached a profile.
3. `api`, when there's no subscription behind the session at all.

This earns its keep if you run several subscriptions side by side, each under
its own `CLAUDE_CONFIG_DIR`, and want to know which one a pane is spending.

## Narrow panes

Claude Code passes the pane's width in `COLUMNS`, and the line gives up detail
until it fits, least useful first:

| Order | Given up |
|---|---|
| 1 | The context cap |
| 2 | The bar glyphs (the percentage and its colour stay) |
| 3 | Cost |
| 4 | Directory |
| 5 | Model |
| 6 | The countdowns |

The quota figures and the seat name are never given up, because they're what the
bar is for. Below roughly 30 columns even that won't fit, and the line is
allowed to run long rather than say nothing useful.

If `COLUMNS` isn't set, nothing is given up. An unknown width isn't a reason to
render less than you asked for.

## Why the percentage looks lower than you expect

Claude Code reserves a slice of the window for auto compaction, so the raw
remaining percentage never reaches zero. The bar rescales onto what's actually
usable, so 100% means "out of room now", not "out of room eventually". Override
the reserve with `CLAUDE_CODE_AUTO_COMPACT_WINDOW` if it ever changes.

## Degrading

Every segment is independent, and one with no data is left out rather than
guessed at. A session with no subscription behind it shows no quota figures. A
payload with no cost shows no dollars. If the payload can't be parsed at all,
the script exits quietly and Claude Code falls back to its own default, because
a status line that fails is worth less than no status line.

## Tests

```
node --test
```

No dependencies, and no running session needed. `render()` is a pure function of
the payload, the clock and the environment, and the process only touches stdin,
the clock and the disk inside `main()`.

## Licence

MIT. See [LICENSE](LICENSE).
