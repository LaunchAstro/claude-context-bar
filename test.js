// Dependency-free tests: `node --test` from this directory.
//
// Everything the status line decides is a pure function of the payload, the
// clock and the environment, so none of this needs a running Claude Code.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  compact, contextSegment, costSegment, expiresIn, fit, heldTokens,
  quotaSegment, ramp, render, seatName, width, TRIMS,
} = require('./claude-statusline.js');

const NOW = 1_800_000_000;
// Colour is tested through `ramp` directly; everywhere else it is noise.
const plain = (s) => (s === null ? null : s.replace(/\x1b\[[0-9;]*m/g, ''));

test('expiresIn rounds down, and never reads as expired while it is not', () => {
  assert.equal(expiresIn(NOW + 30, NOW), '<1m', 'the last minute rounds up, alone');
  assert.equal(expiresIn(NOW + 60, NOW), '1m');
  assert.equal(expiresIn(NOW + 3599, NOW), '59m');
  assert.equal(expiresIn(NOW + 3600, NOW), '1h');
  assert.equal(expiresIn(NOW + 86_399, NOW), '23h', 'just under a day stays in hours');
  assert.equal(expiresIn(NOW + 86_400, NOW), '1d');
  assert.equal(expiresIn(NOW + 2 * 86_400 - 1, NOW), '1d', '1.9 days must not read 2d');
  assert.equal(expiresIn(NOW + 7 * 86_400, NOW), '7d');
});

test('expiresIn returns null rather than guessing', () => {
  for (const bad of [undefined, null, 'soon', NaN, Infinity]) {
    assert.equal(expiresIn(bad, NOW), null);
  }
  assert.equal(expiresIn(NOW, NOW), null, 'a window resetting right now has nothing left');
  assert.equal(expiresIn(NOW - 1, NOW), null);
});

test('compact keeps the token count to a glance', () => {
  assert.equal(compact(0), '0');
  assert.equal(compact(940), '940');
  assert.equal(compact(53_000), '53k');
  assert.equal(compact(1_000_000), '1M');
  assert.equal(compact(1_500_000), '1.5M');
  assert.equal(compact(1_450_000), '1.4M', 'floating point rounds 1.45 down; the tenth is cosmetic');
  assert.equal(compact(12_000_000), '12M');
});

test('heldTokens prefers the stated total, then sums the parts', () => {
  assert.equal(heldTokens({ total_input_tokens: 1234 }), 1234);
  assert.equal(heldTokens({ total_input_tokens: 0 }), 0, 'zero is a total, not a miss');
  assert.equal(heldTokens({}), null);
  assert.equal(heldTokens({ current_usage: { input_tokens: 1000, cache_read_input_tokens: 50_000 } }), 51_000);
});

test('ramp escalates, and only the context bar flashes', () => {
  assert.equal(ramp(49), '\x1b[32m');
  assert.equal(ramp(50), '\x1b[33m');
  assert.equal(ramp(65), '\x1b[38;5;208m');
  assert.equal(ramp(80), '\x1b[31m');
  assert.equal(ramp(80, { flash: true }), '\x1b[5;31m');
  assert.equal(ramp(79, { flash: true }), '\x1b[38;5;208m', 'flashing is for red only');
});

test('quotaSegment prints the seat, the burn and the countdown', () => {
  const seg = plain(quotaSegment({
    five_hour: { used_percentage: 28, resets_at: NOW + 3 * 3600 },
    seven_day: { used_percentage: 59.000000001, resets_at: NOW + 2 * 86_400 },
  }, { now: NOW, seat: 'sam' }));
  assert.equal(seg, 'sam · 5h 28% exp 3h · 7d 59% exp 2d');
});

test('quotaSegment degrades one piece at a time', () => {
  const windows = { five_hour: { used_percentage: 28, resets_at: NOW + 3600 } };
  assert.equal(plain(quotaSegment(windows, { now: NOW })), '5h 28% exp 1h', 'no seat');
  assert.equal(plain(quotaSegment({ five_hour: { used_percentage: 28 } }, { now: NOW, seat: 'ada' })),
    'ada · 5h 28%', 'no reset stamp');
  assert.equal(plain(quotaSegment({}, { now: NOW, seat: 'api' })), 'api',
    'a seat with no windows still says whose session this is');
  assert.equal(quotaSegment({}, { now: NOW }), null, 'nothing to say, so no segment');
  assert.equal(quotaSegment(undefined, { now: NOW }), null);
  assert.equal(plain(quotaSegment({ five_hour: { used_percentage: 0, resets_at: NOW + 60 } }, { now: NOW })),
    '5h 0% exp 1m', 'zero percent is a reading, not a missing value');
});

test('contextSegment rescales onto the usable window and clamps', () => {
  const at = (remaining, extra = {}) => plain(contextSegment(
    { remaining_percentage: remaining, context_window_size: 1_000_000, ...extra }, { env: {} },
  ));
  assert.equal(at(100, { total_input_tokens: 0 }), '░░░░░░░░░░ 0% 0/1M');
  assert.equal(at(16.5, { total_input_tokens: 1_000_000 }), '██████████ 100% 1M/1M',
    'the reserved slice is the floor, not zero');
  assert.equal(at(0), '██████████ 100%', 'past the reserve still reads full, never over');
  assert.equal(contextSegment({}, { env: {} }), null, 'no percentage, no bar');
});

test('contextSegment honours CLAUDE_CODE_AUTO_COMPACT_WINDOW', () => {
  const cw = { remaining_percentage: 45, context_window_size: 1_000_000, total_input_tokens: 420_000 };
  assert.equal(plain(contextSegment(cw, { env: {} })), '██████░░░░ 66% 420k/1M');
  assert.equal(plain(contextSegment(cw, { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } })),
    '██████████ 100% 420k/1M', 'a smaller compact window means less usable room');
});

test('costSegment only prints a real number', () => {
  assert.equal(plain(costSegment(3.6)), '$3.60');
  assert.equal(plain(costSegment(0)), '$0.00');
  assert.equal(costSegment(undefined), null);
  assert.equal(costSegment('3.60'), null);
});

test('render lays the segments out in order and drops the empty ones', () => {
  const line = plain(render({
    model: { display_name: 'Opus 5' },
    workspace: { current_dir: '/a/b/my-project' },
    context_window: { remaining_percentage: 45, context_window_size: 1_000_000, total_input_tokens: 420_000 },
    cost: { total_cost_usd: 3.63 },
    rate_limits: { five_hour: { used_percentage: 28, resets_at: NOW + 3 * 3600 } },
  }, { now: NOW, seat: 'sam', env: {} }));
  assert.equal(line, 'Opus 5 │ my-project │ ██████░░░░ 66% 420k/1M │ $3.63 │ sam · 5h 28% exp 3h');
});

test('render survives a payload with nothing in it', () => {
  const line = plain(render({}, { now: NOW, seat: null, env: {} }));
  assert.equal(line.split(' │ ')[0], 'Claude', 'an unnamed model still gets a name');
});

test('seatName reads the signed-in email, then falls back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-'));
  const seat = path.join(dir, '.claude-seat-work');
  fs.mkdirSync(seat);

  fs.writeFileSync(path.join(seat, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'ada@example.com' } }));
  assert.equal(seatName({ CLAUDE_CONFIG_DIR: seat }), 'ada', 'the email wins over the directory');

  fs.writeFileSync(path.join(seat, '.claude.json'), '{ half-written');
  assert.equal(seatName({ CLAUDE_CONFIG_DIR: seat }), 'work', 'unparseable config falls to the name');

  fs.rmSync(path.join(seat, '.claude.json'));
  assert.equal(seatName({ CLAUDE_CONFIG_DIR: seat }), 'work');
  assert.equal(seatName({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: 'sk' }), 'api',
    'a directory that is not a seat, but a key, is an api session');
  assert.equal(seatName({ CLAUDE_CONFIG_DIR: dir }), null);

  // The default install keeps its config BESIDE ~/.claude, not inside it.
  fs.writeFileSync(path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'sam@example.com' } }));
  assert.equal(seatName({ HOME: dir }), 'sam');
  assert.equal(seatName({ HOME: '/nonexistent' }), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- fitting a narrow pane ---

const WIDE = {
  model: { display_name: 'Opus 5' },
  workspace: { current_dir: '/a/b/my-project' },
  context_window: { remaining_percentage: 45, context_window_size: 1_000_000, total_input_tokens: 420_000 },
  cost: { total_cost_usd: 3.63 },
  rate_limits: {
    five_hour: { used_percentage: 28, resets_at: NOW + 2 * 3600 },
    seven_day: { used_percentage: 59, resets_at: NOW + 2 * 86_400 },
  },
};
const fitted = (columns) => plain(fit(WIDE, { now: NOW, seat: 'sam', env: { COLUMNS: String(columns) } }));

test('width ignores colour', () => {
  assert.equal(width('\x1b[32mabc\x1b[0m'), 3);
  assert.equal(width('plain'), 5);
});

test('fit gives nothing up when there is room', () => {
  assert.equal(fitted(200),
    'Opus 5 │ my-project │ ██████░░░░ 66% 420k/1M │ $3.63 │ sam · 5h 28% exp 2h · 7d 59% exp 2d');
});

test('fit gives up detail in order, least useful first', () => {
  assert.equal(fitted(90), 'Opus 5 │ my-project │ ██████░░░░ 66% 420k/1M │ $3.63 │ sam · 5h 28% exp 2h · 7d 59% exp 2d',
    'exactly the full width still fits');
  assert.equal(fitted(89), 'Opus 5 │ my-project │ ██████░░░░ 66% │ $3.63 │ sam · 5h 28% exp 2h · 7d 59% exp 2d');
  assert.equal(fitted(81), 'Opus 5 │ my-project │ 66% │ $3.63 │ sam · 5h 28% exp 2h · 7d 59% exp 2d');
  assert.equal(fitted(70), 'Opus 5 │ my-project │ 66% │ sam · 5h 28% exp 2h · 7d 59% exp 2d');
  assert.equal(fitted(62), 'Opus 5 │ 66% │ sam · 5h 28% exp 2h · 7d 59% exp 2d');
  assert.equal(fitted(49), '66% │ sam · 5h 28% exp 2h · 7d 59% exp 2d');
  assert.equal(fitted(40), '66% │ sam · 5h 28% · 7d 59%');
});

test('fit never gives up the quota figures or the account', () => {
  const floor = fitted(1);
  assert.match(floor, /sam/);
  assert.match(floor, /5h 28%/);
  assert.match(floor, /7d 59%/);
});

test('fit takes the widest line that fits, at every width', () => {
  for (let columns = 30; columns <= 110; columns++) {
    const line = fit(WIDE, { now: NOW, seat: 'sam', env: { COLUMNS: String(columns) } });
    assert.ok(width(line) <= columns || width(line) === width(fit(WIDE, { now: NOW, seat: 'sam', env: { COLUMNS: '1' } })),
      `width ${columns} produced ${width(line)}: ${plain(line)}`);
  }
});

test('an unknown width gives nothing up', () => {
  const full = plain(fit(WIDE, { now: NOW, seat: 'sam', env: {} }));
  assert.equal(full, fitted(200));
  assert.equal(plain(fit(WIDE, { now: NOW, seat: 'sam', env: { COLUMNS: 'wide' } })), fitted(200));
  assert.equal(plain(fit(WIDE, { now: NOW, seat: 'sam', env: { COLUMNS: '0' } })), fitted(200));
});

test('every trim name is one a segment actually honours', () => {
  const everything = new Set(TRIMS);
  const stripped = plain(render(WIDE, { now: NOW, seat: 'sam', env: {}, drop: everything }));
  assert.equal(stripped, '66% │ sam · 5h 28% · 7d 59%');
  for (const trim of TRIMS) {
    const one = plain(render(WIDE, { now: NOW, seat: 'sam', env: {}, drop: new Set([trim]) }));
    assert.notEqual(one, fitted(200), `dropping "${trim}" changed nothing — is it wired up?`);
  }
});

// --- invariants across a wide spread of payloads ---

// Every payload shape the status line is likely to meet, including the broken ones.
function spread() {
  const base = () => JSON.parse(JSON.stringify(WIDE));
  const out = [base(), {}];
  for (const secs of [-5, 0, 30, 61, 3540, 3600, 86_399, 86_400, 6 * 86_400]) {
    out.push({ ...base(), rate_limits: { five_hour: { used_percentage: 28, resets_at: NOW + secs } } });
  }
  for (const pct of [0, 49.6, 50, 64.9, 65, 79.4, 80, 100, 104.4]) {
    out.push({ ...base(), rate_limits: { seven_day: { used_percentage: pct, resets_at: NOW + 100 } } });
  }
  for (const remaining of [0, 16.5, 45, 100]) {
    out.push({ ...base(), context_window: { remaining_percentage: remaining, context_window_size: 1_000_000, total_input_tokens: 1000 } });
  }
  out.push({ ...base(), workspace: { current_dir: '/x/a-very-long-project-directory-name-indeed' } });
  out.push({ ...base(), rate_limits: { five_hour: { used_percentage: 28, resets_at: 'bogus' } } });
  out.push({ ...base(), rate_limits: {} });
  out.push({ model: null, workspace: null, cost: null, context_window: null, rate_limits: null });
  return out;
}

test('colour is always closed — nothing bleeds into the next line', () => {
  for (const data of spread()) {
    for (const columns of [200, 90, 70, 50, 30]) {
      const line = fit(data, { now: NOW, seat: 'sam', env: { COLUMNS: String(columns) } });
      if (line === '') continue;
      const opened = (line.match(/\x1b\[(?!0m)[0-9;]*m/g) || []).length;
      const closed = (line.match(/\x1b\[0m/g) || []).length;
      assert.equal(opened, closed, `unbalanced colour at ${columns}: ${JSON.stringify(line)}`);
      assert.ok(line.endsWith('\x1b[0m'), `line does not end reset: ${JSON.stringify(line)}`);
    }
  }
});

test('fit fits whenever anything narrower would have', () => {
  const floorWidth = (data) => width(render(data, { now: NOW, seat: 'sam', env: {}, drop: new Set(TRIMS) }));
  for (const data of spread()) {
    for (let columns = 10; columns <= 120; columns++) {
      const line = fit(data, { now: NOW, seat: 'sam', env: { COLUMNS: String(columns) } });
      if (width(line) <= columns) continue;
      // Overruns are only allowed once even the most trimmed line is too wide.
      assert.ok(floorWidth(data) > columns,
        `overran ${columns} at width ${width(line)} when trimming further would have fitted`);
    }
  }
});

test('no payload, however broken, throws', () => {
  const nasty = [
    {}, { model: {} }, { workspace: {} }, { context_window: { remaining_percentage: 'x' } },
    { cost: { total_cost_usd: NaN } }, { rate_limits: { five_hour: null } },
    { rate_limits: { five_hour: { used_percentage: 'x' } } },
    { model: { display_name: '' } },
  ];
  for (const data of nasty) {
    for (const columns of ['', '40', '0', 'x']) {
      assert.doesNotThrow(() => fit(data, { now: NOW, seat: 'sam', env: columns ? { COLUMNS: columns } : {} }),
        JSON.stringify(data));
    }
  }
});
