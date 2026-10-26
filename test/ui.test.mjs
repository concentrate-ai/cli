import assert from "node:assert/strict";
import { test } from "node:test";

import { wordmark } from "../dist/lib/ui/brand.js";
import { ledger, panel } from "../dist/lib/ui/layout.js";
import { contextBar, formatTokens } from "../dist/lib/ui/models.js";
import { caps, fit, paint, strip, visibleWidth } from "../dist/lib/ui/term.js";
import { glyphs } from "../dist/lib/ui/theme.js";
import {
  createSelect,
  parseKeys,
  reduce,
  renderSelect,
  visible,
} from "../dist/lib/ui/widgets.js";

const TTY = { isTTY: true, columns: 100 };
const PIPE = { isTTY: false };
const plain = { tty: true, color: 0, unicode: true, width: 80, motion: false };
const truecolor = { ...plain, color: 24 };

test("color depth follows the terminal, NO_COLOR, and FORCE_COLOR", () => {
  assert.equal(caps({}, PIPE).color, 0);
  assert.equal(
    caps({ COLORTERM: "truecolor", TERM: "xterm-256color" }, TTY).color,
    24,
  );
  assert.equal(caps({ TERM: "xterm-256color" }, TTY).color, 256);
  assert.equal(
    caps(
      { TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal", COLORTERM: "" },
      TTY,
    ).color,
    256,
  );
  assert.equal(
    caps({ TERM: "xterm", COLORTERM: "truecolor", NO_COLOR: "1" }, TTY).color,
    0,
  );
  assert.equal(caps({ FORCE_COLOR: "3" }, PIPE).color, 24);
  assert.equal(caps({ TERM: "dumb" }, TTY).color, 0);
});

test("motion needs a color TTY and is switched off in CI or by CN_NO_MOTION", () => {
  assert.equal(caps({ TERM: "xterm-256color" }, TTY).motion, true);
  assert.equal(caps({ TERM: "xterm-256color", CI: "1" }, TTY).motion, false);
  assert.equal(
    caps({ TERM: "xterm-256color", CN_NO_MOTION: "1" }, TTY).motion,
    false,
  );
  assert.equal(caps({ FORCE_COLOR: "3" }, PIPE).motion, false);
});

test("unicode is dropped for a dumb terminal or a non-UTF-8 locale", () => {
  assert.equal(caps({ LANG: "en_US.UTF-8" }, TTY).unicode, true);
  assert.equal(caps({ LANG: "C" }, TTY).unicode, false);
  assert.equal(caps({ TERM: "dumb" }, TTY).unicode, false);
  assert.equal(glyphs({ unicode: false }).on, "*");
});

test("paint is plain without color and emits the right escape per depth", () => {
  assert.equal(paint("focus", "x", {}, plain), "x");
  assert.match(
    paint("focus", "x", {}, truecolor),
    /^\x1b\[38;2;255;180;84mx\x1b\[39m$/,
  );
  assert.match(
    paint("focus", "x", {}, { ...plain, color: 256 }),
    /^\x1b\[38;5;\d+mx/,
  );
  assert.match(paint("focus", "x", {}, { ...plain, color: 16 }), /^\x1b\[93mx/);
});

test("the wordmark reads Concentrate AI, and styles never cancel a row's background", async () => {
  const { surface, SURFACE } = await import("../dist/lib/ui/term.js");
  assert.equal(strip(wordmark(truecolor)), "Concentrate AI");
  assert.equal(wordmark(plain), "Concentrate AI");
  const row = surface(
    SURFACE.selected,
    `a ${paint("focus", "b", { bold: true }, truecolor)} c`,
    truecolor,
  );
  assert.ok(!row.includes("\x1b[0m"), "no full reset inside a highlighted row");
  assert.ok(row.startsWith("\x1b[48;2;") && row.endsWith("\x1b[49m"));
  assert.equal(
    surface(SURFACE.selected, "x", { ...truecolor, color: 16 }),
    "x",
    "no tint on 16-color terminals",
  );
});

test("the header shows the mark when there is room and one line when there is not", async () => {
  const { header } = await import("../dist/lib/ui/brand.js");
  const wide = header(
    "1.2.3",
    { status: "ready" },
    { ...truecolor, width: 79 },
  );
  assert.equal(wide.length, 4);
  assert.match(strip(wide[1]), /Concentrate AI\s+v1\.2\.3$/);
  for (const line of wide) assert.ok(visibleWidth(line) <= 79);
  assert.equal(header("1.2.3", {}, { ...truecolor, width: 50 }).length, 1);
  assert.equal(
    header("1.2.3", {}, { ...plain, width: 79 }).length,
    1,
    "no block art without color",
  );
});

test("wrap breaks at spaces and never exceeds the width", async () => {
  const { wrap } = await import("../dist/lib/ui/widgets.js");
  assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
  const long = "averyveryverylongword";
  const pieces = wrap(long, 8);
  assert.ok(pieces.every((piece) => piece.length <= 8));
  assert.equal(pieces.join(""), long);
  assert.deepEqual(wrap("", 10), [""]);
});

test("parseKeys decodes arrows, enter, escape, backspace, and pasted text", () => {
  assert.deepEqual(
    parseKeys("\x1b[A\x1b[B").map((k) => k.name),
    ["up", "down"],
  );
  assert.deepEqual(
    parseKeys("\x1bOA").map((k) => k.name),
    ["up"],
  );
  assert.deepEqual(
    parseKeys("\r").map((k) => k.name),
    ["enter"],
  );
  assert.deepEqual(
    parseKeys("\x1b").map((k) => k.name),
    ["escape"],
  );
  assert.deepEqual(
    parseKeys("\x7f").map((k) => k.name),
    ["backspace"],
  );
  assert.deepEqual(
    parseKeys("\x03").map((k) => k.name),
    ["interrupt"],
  );
  assert.deepEqual(
    parseKeys("sk-1").map((k) => k.char),
    ["s", "k", "-", "1"],
  );
  assert.deepEqual(parseKeys("\x1b[99~"), []);
});

const ITEMS = [
  { group: "launch" },
  { value: "a", label: "alpha", note: "First" },
  { value: "b", label: "beta", note: "Second" },
  { group: "manage" },
  { value: "c", label: "gamma", note: "Third" },
];
const press = (state, ...names) =>
  names.reduce(
    (s, name) => reduce(s, typeof name === "string" ? { name } : name),
    state,
  );
const focused = (state) => visible(state)[state.cursor].value;

test("the cursor skips group headers and wraps around", () => {
  let state = createSelect(ITEMS);
  assert.equal(focused(state), "a");
  state = press(state, "down", "down");
  assert.equal(focused(state), "c");
  state = press(state, "down");
  assert.equal(focused(state), "a");
  assert.equal(focused(press(state, "up")), "c");
  assert.equal(focused(createSelect(ITEMS, { initial: "c" })), "c");
});

test("enter selects, escape and q cancel, ctrl-c is an interrupt", () => {
  const state = createSelect(ITEMS);
  assert.deepEqual(press(state, "down", "enter").done, { value: "b" });
  assert.deepEqual(press(state, "escape").done, { cancel: true });
  assert.deepEqual(press(state, { name: "char", char: "q" }).done, {
    cancel: true,
  });
  assert.equal(press(state, "interrupt").done.interrupted, true);
});

test("filtering narrows the list, escape clears it first, and custom IDs are offered", () => {
  let state = createSelect(ITEMS, { filterable: true, allowCustom: true });
  for (const char of "gam") state = press(state, { name: "char", char });
  assert.equal(visible(state).length, 2);
  assert.equal(focused(state), "c");
  assert.equal(visible(state).at(-1).value, "gam");
  state = press(state, "escape");
  assert.equal(state.query, "");
  assert.equal(state.done, undefined);
  assert.deepEqual(press(state, "escape").done, { cancel: true });
  const typed = press(
    createSelect(ITEMS, { filterable: true, allowCustom: true }),
    ...[..."zzz"].map((char) => ({ name: "char", char })),
  );
  assert.deepEqual(press(typed, "enter").done, { value: "zzz" });
  assert.equal(
    focused(press(typed, "backspace", "backspace", "backspace")),
    "a",
  );
});

test("a rendered frame never exceeds the content width and shows window indicators", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    value: `m${i}`,
    label: `model-${i}`,
    note: "x".repeat(80),
    right: "RIGHT",
  }));
  let state = createSelect(many, { rows: 8, filterable: true });
  state = press(state, ...Array(20).fill("down"));
  const lines = renderSelect(state, { title: "Pick" }, plain);
  for (const line of lines)
    assert.ok(
      visibleWidth(line) <= 72,
      `too wide (${visibleWidth(line)}): ${line}`,
    );
  const text = lines.join("\n");
  assert.match(text, /↑ \d+ more/);
  assert.match(text, /↓ \d+ more/);
  assert.match(text, /21\/40|40\/40/);
});

test("context bars keep a fixed width and grow with the window", () => {
  const widths = [0, 4000, 8000, 128000, 1_000_000, 5_000_000].map((n) =>
    visibleWidth(contextBar(n, plain)),
  );
  assert.ok(
    widths.every((w) => w === 8),
    widths.join(),
  );
  const filled = (n) =>
    [...strip(contextBar(n, plain))].filter((ch) => ch !== "·").length;
  assert.ok(filled(8000) <= filled(128000));
  assert.ok(filled(128000) <= filled(1_000_000));
  assert.ok(filled(2_000_000) >= filled(1_000_000));
  assert.equal(
    visibleWidth(contextBar(200000, { ...plain, unicode: false })),
    8,
  );
  assert.equal(formatTokens(200000), "200k");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(null), "");
});

test("panels have uniform width and ledger rows align", () => {
  const box = panel(
    "ready",
    ["› cn claude", "", "a much longer line of text"],
    plain,
  );
  assert.equal(new Set(box.map(visibleWidth)).size, 1);
  assert.match(box[0], /╭─ ready ─+╮/);
  assert.equal(
    visibleWidth(ledger("ok", "key", "x", plain)),
    visibleWidth(ledger("bad", "Codex CLI", "x", plain)),
  );
  assert.equal(fit("abcdefghij", 5), "abcd…");
  assert.equal(fit("abc", 5), "abc");
});

test("clip cuts to visible columns, keeps colors closed, and leaves plain text plain", async () => {
  const { clip } = await import("../dist/lib/ui/term.js");
  assert.equal(clip("abcdef", 4), "abcd");
  assert.equal(clip("abc", 4), "abc");
  const colored = paint("focus", "abcdef", {}, truecolor);
  const cut = clip(colored, 3);
  assert.equal(strip(cut), "abc");
  assert.ok(cut.endsWith("\x1b[0m"), "an open color is closed");
  assert.ok(
    !clip("abcdef", 3).includes("\x1b"),
    "no escape codes added to plain text",
  );
});

test("the layout width stays one column inside the terminal", () => {
  assert.equal(caps({}, { isTTY: true, columns: 40 }).width, 39);
  assert.equal(caps({}, { isTTY: true, columns: 300 }).width, 100);
  assert.equal(caps({}, { isTTY: true, columns: 10 }).width, 20);
  const narrow = { ...plain, width: 39 };
  const state = createSelect([
    {
      value: "a",
      label: "claude",
      note: "Claude Code  claude-sonnet-4-6",
      right: "ready",
    },
  ]);
  for (const line of renderSelect(state, {}, narrow))
    assert.ok(visibleWidth(line) <= 39, line);
  assert.match(renderSelect(state, {}, narrow).join("\n"), /ready/);
});
