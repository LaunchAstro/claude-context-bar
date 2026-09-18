#!/usr/bin/env node

// A dependency-free status line for Claude Code.
// Shows the active model and its context cap, the working directory, the
// usable context consumed, session cost, and quota burn.
//
// Segments:  MODEL (CAP) │ DIR │ [bar] USED% │ $COST │ SEAT · 5h N% exp T · 7d N% exp T
//
// Note on the numbers: the token count is what is sitting in the context
// window right now (it falls after a compaction). The dollar figure is
// cumulative for the whole session and only ever climbs. Two different
// things, so do not add them up.
//
// Everything above `main()` is pure: hand `fit()` a payload and it returns the
// line. The process only touches stdin, the clock and the disk at the edges,
// which is what makes the whole thing testable without a running session.

const fs = require('fs');
const path = require('path');

const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const paint = (colour, text) => `${colour}${text}${OFF}`;
const dim = (text) => paint(DIM, text);

// A narrow pane cannot hold the whole line, so detail is given up in this
// order, least useful first. The quota figures and the seat are what the bar
// is for, so they are never dropped.
const TRIMS = ['cap', 'bar', 'cost', 'directory', 'model', 'expiry'];
const DROP_NOTHING = new Set();

const width = (line) => line.replace(/\x1b\[[0-9;]*m/g, '').length;

// Green under half, amber, orange, then red. Same ramp everywhere. Flashing is
// reserved for the context bar, where running out ends the turn you are in.
function ramp(pct, { flash = false } = {}) {
  if (pct < 50) return '\x1b[32m';
  if (pct < 65) return '\x1b[33m';
  if (pct < 80) return '\x1b[38;5;208m';
  return flash ? '\x1b[5;31m' : '\x1b[31m';
}

function compact(n) {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// How long a window has left, from its Unix reset stamp. Always rounded DOWN, so
// the bar never claims more room than there is: 1.9 days left reads "1d".
function expiresIn(resetsAt, now = Date.now() / 1000) {
  if (!Number.isFinite(resetsAt)) return null;
  const secondsLeft = resetsAt - now;
  if (secondsLeft <= 0) return null;
  const minutes = Math.floor(secondsLeft / 60);
  // Rounding down leaves the last minute reading "0m", which looks expired when
  // it is not. That final minute is the one case that rounds the other way.
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Claude Code reserves a slice of the window for auto-compaction, so the raw
// percentage never reaches 100. This rescales onto what is actually usable:
// 100% means "out of room now", not "out of room eventually".
function contextSegment(cw, { env = process.env, drop = DROP_NOTHING } = {}) {
  const remaining = cw.remaining_percentage;
  if (remaining == null) return null;

  const totalTokens = cw.context_window_size || cw.total_tokens || 1_000_000;
  const compactWindow = Number.parseInt(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
  const reservedPercent = compactWindow > 0
    ? Math.min(100, Math.max(0, (1 - compactWindow / totalTokens) * 100))
    : 16.5;
  const usableRemaining = Math.max(
    0,
    ((remaining - reservedPercent) / (100 - reservedPercent)) * 100,
  );
  const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

  const filled = Math.floor(used / 10);
  // Dropping the glyphs keeps the percentage AND its colour, so a full window
  // still flashes red in a pane too narrow to draw the bar.
  const bar = drop.has('bar') ? '' : `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} `;

  return paint(ramp(used, { flash: true }), `${bar}${used}%`);
}

function costSegment(cost) {
  return typeof cost === 'number' ? dim(`$${cost.toFixed(2)}`) : null;
}

// Quota burn: the numbers that actually decide whether the fleet keeps running.
// The seat leads, because it says whose quota these are, and it stands alone on
// a session that has no subscription windows at all.
function quotaSegment(rateLimits, { now, seat, drop = DROP_NOTHING } = {}) {
  // Not a default parameter: Claude Code sends rate_limits NULL on a session
  // with no plan behind it (API key, Bedrock, Vertex), and a default only fires
  // on undefined. Getting this wrong threw, which cost the whole status line.
  const windows = rateLimits || {};
  const parts = seat ? [dim(seat)] : [];

  for (const [label, key] of [['5h', 'five_hour'], ['7d', 'seven_day']]) {
    const quota = windows[key];
    if (!quota || quota.used_percentage == null) continue;
    // These arrive as floats (55.00000000000001), so never print them raw.
    const pct = Math.round(quota.used_percentage);
    const left = drop.has('expiry') ? null : expiresIn(quota.resets_at, now);
    const expiry = left ? dim(` exp ${left}`) : '';
    parts.push(`${paint(ramp(pct), `${label} ${pct}%`)}${expiry}`);
  }

  return parts.length ? parts.join(dim(' · ')) : null;
}

// The model, and the window size it is really running with. Claude Code already
// spells the cap into the display name for some models ("Sonnet 5 (1M context)")
// and not others, so that suffix is stripped and the cap restated from
// context_window_size, which is the same number the percentage bar is built on.
function modelSegment(data, { drop = DROP_NOTHING } = {}) {
  const name = (data.model?.display_name || 'Claude').replace(/\s*\([^()]*context\)\s*$/i, '');
  const declared = data.context_window?.context_window_size || data.context_window?.total_tokens;
  const cap = drop.has('cap') || !declared ? '' : ` (${compact(declared)})`;
  return dim(`${name}${cap}`);
}

const directoryName = (data) => path.basename(data.workspace?.current_dir || process.cwd());

function render(data, { now, seat, env = process.env, drop = DROP_NOTHING } = {}) {
  const segments = [
    drop.has('model') ? null : modelSegment(data, { drop }),
    drop.has('directory') ? null : dim(directoryName(data)),
    contextSegment(data.context_window || {}, { env, drop }),
    drop.has('cost') ? null : costSegment(data.cost?.total_cost_usd),
    quotaSegment(data.rate_limits, { now, seat, drop }),
  ];
  return segments.filter(Boolean).join(dim(' │ '));
}

// Claude Code passes the pane's width in COLUMNS. Without it, nothing is given
// up, because an unknown width is not an excuse to render less than was asked
// for.
function fit(data, options = {}) {
  const env = options.env || process.env;
  const columns = Number.parseInt(env.COLUMNS || '0', 10) || 0;
  let line = render(data, { ...options, env });
  if (columns <= 0) return line;

  for (let depth = 1; depth <= TRIMS.length && width(line) > columns; depth++) {
    line = render(data, { ...options, env, drop: new Set(TRIMS.slice(0, depth)) });
  }
  return line;
}

// Claude Code puts no account anywhere in the status line payload, so the seat
// this pane is spending comes from the config directory it booted with.
function seatName(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR;
  // A seat keeps its config inside its config directory; the default install
  // keeps it beside ~/.claude. Getting this backwards fails silently.
  const configFile = configDir
    ? path.join(configDir, '.claude.json')
    : path.join(env.HOME || '', '.claude.json');

  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const email = config.oauthAccount?.emailAddress;
    if (email) return email.split('@')[0];
  } catch {
    // Missing, unreadable, or half-written mid-save, so the directory name will do.
  }

  const seatDir = configDir && path.basename(configDir).match(/^\.claude-seat-(.+)$/);
  if (seatDir) return seatDir[1];
  if (env.ANTHROPIC_API_KEY) return 'api';
  return null;
}

// A status line that fails is worth less than no status line at all, so every
// failure here (bad JSON, a payload shaped differently, a slow pipe) exits
// quietly and leaves Claude Code's own default in place.
function main() {
  let input = '';
  const timeout = setTimeout(() => process.exit(0), 3000);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    clearTimeout(timeout);
    try {
      process.stdout.write(fit(JSON.parse(input), { seat: seatName() }));
    } catch {
      process.exit(0);
    }
  });
}

module.exports = {
  compact, contextSegment, costSegment, expiresIn, fit, modelSegment,
  quotaSegment, ramp, render, seatName, width, TRIMS,
};

if (require.main === module) main();
