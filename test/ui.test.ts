import { test, expect } from "vitest";

import { wordmark, header } from "../src/lib/ui/brand.js";
import { ledger, panel } from "../src/lib/ui/layout.js";
import { renderKeyEntry } from "../src/lib/ui/onboarding.js";
import { contextBar, formatTokens } from "../src/lib/ui/models.js";
import {
  caps,
  fit,
  paint,
  strip,
  visibleWidth,
  surface,
  SURFACE,
  clip,
} from "../src/lib/ui/term.js";
import { glyphs } from "../src/lib/ui/theme.js";
import {
  createSelect,
  parseKeys,
  reduce,
  renderSelect,
  renderWorkspace,
  visible,
  wrap,
} from "../src/lib/ui/widgets.js";
import { openScreen, fullScreenActive } from "../src/lib/ui/screen.js";

const widths = (lines) => lines.map(visibleWidth);
const widest = (lines) => Math.max(...widths(lines));
const chars = (text) => [...text].map((char) => ({ name: "char", char }));

test.each([
  [39, 12, 0],
  [39, 12, 24],
  [69, 23, 0],
  [69, 23, 24],
  [99, 39, 0],
  [99, 39, 24],
  [159, 49, 0],
  [159, 49, 24],
])(
  "fullscreen menus fit resized terminals and keep the focused action visible: %ix%i color %i",
  (width, height, color) => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      value: `item-${i}`,
      label: `action-${i}`,
      note: "Tool settings",
    }));
    const state = createSelect(items, { initial: "item-42", filterable: true });
    const frame = renderWorkspace(
      state,
      {
        title: "Settings",
        detail: () => [
          "Configure this tool to use Concentrate for direct launches.",
        ],
      },
      { tty: true, color, unicode: true, width, motion: false },
      height,
    );
    expect(frame.length).toBe(height);
    expect(widest(frame)).toBeLessThanOrEqual(width);
    const text = strip(frame.join("\n"));
    expect(text).toMatch(/action-42/);
    expect(text).toMatch(/Concentrate/);
    expect(text).toMatch(/back/);
  },
);

const TTY = { isTTY: true, columns: 100 };
const PIPE = { isTTY: false };
const plain = { tty: true, color: 0, unicode: true, width: 80, motion: false };
const truecolor = { ...plain, color: 24 };

test("color depth follows the terminal, NO_COLOR, and FORCE_COLOR", () => {
  expect(caps({}, PIPE).color).toBe(0);
  expect(
    caps({ COLORTERM: "truecolor", TERM: "xterm-256color" }, TTY).color,
  ).toBe(24);
  expect(caps({ TERM: "xterm-256color" }, TTY).color).toBe(256);
  expect(
    caps(
      { TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal", COLORTERM: "" },
      TTY,
    ).color,
  ).toBe(256);
  expect(
    caps({ TERM: "xterm", COLORTERM: "truecolor", NO_COLOR: "1" }, TTY).color,
  ).toBe(0);
  expect(caps({ FORCE_COLOR: "3" }, PIPE).color).toBe(24);
  expect(caps({ TERM: "dumb" }, TTY).color).toBe(0);
});

test("motion needs a color TTY and is switched off in CI or by CN_NO_MOTION", () => {
  expect(caps({ TERM: "xterm-256color" }, TTY).motion).toBe(true);
  expect(caps({ TERM: "xterm-256color", CI: "1" }, TTY).motion).toBe(false);
  expect(caps({ TERM: "xterm-256color", CN_NO_MOTION: "1" }, TTY).motion).toBe(
    false,
  );
  expect(caps({ FORCE_COLOR: "3" }, PIPE).motion).toBe(false);
});

test("unicode is dropped for a dumb terminal or a non-UTF-8 locale", () => {
  expect(caps({ LANG: "en_US.UTF-8" }, TTY).unicode).toBe(true);
  expect(caps({ LANG: "C" }, TTY).unicode).toBe(false);
  expect(caps({ TERM: "dumb" }, TTY).unicode).toBe(false);
  expect(glyphs({ unicode: false }).on).toBe("*");
});

test("paint is plain without color and emits the right escape per depth", () => {
  expect(paint("focus", "x", {}, plain)).toBe("x");
  expect(paint("focus", "x", {}, truecolor)).toMatch(
    /^\x1b\[38;2;255;180;84mx\x1b\[39m$/,
  );
  expect(paint("focus", "x", {}, { ...plain, color: 256 })).toMatch(
    /^\x1b\[38;5;\d+mx/,
  );
  expect(paint("focus", "x", {}, { ...plain, color: 16 })).toMatch(
    /^\x1b\[93mx/,
  );
});

test("the wordmark reads Concentrate AI, and styles never cancel a row's background", async () => {
  expect(strip(wordmark(truecolor))).toBe("Concentrate AI");
  expect(wordmark(plain)).toBe("Concentrate AI");
  const row = surface(
    SURFACE.selected,
    `a ${paint("focus", "b", { bold: true }, truecolor)} c`,
    truecolor,
  );
  expect(row, "no full reset inside a highlighted row").not.toContain(
    "\x1b[0m",
  );
  expect(row.startsWith("\x1b[48;2;")).toBe(true);
  expect(row.endsWith("\x1b[49m")).toBe(true);
  expect(
    surface(SURFACE.selected, "x", { ...truecolor, color: 16 }),
    "no tint on 16-color terminals",
  ).toBe("x");
});

test("the header shows the mark when there is room and one line when there is not", async () => {
  const wide = header(
    "1.2.3",
    { status: "ready" },
    { ...truecolor, width: 79 },
  );
  expect(wide.length).toBe(4);
  expect(strip(wide[1])).toMatch(/Concentrate AI\s+v1\.2\.3$/);
  expect(widest(wide)).toBeLessThanOrEqual(79);
  expect(header("1.2.3", {}, { ...truecolor, width: 50 }).length).toBe(1);
  expect(
    header("1.2.3", {}, { ...plain, width: 79 }).length,
    "no block art without color",
  ).toBe(1);
});

test("wrap breaks at spaces and never exceeds the width", async () => {
  expect(wrap("one two three four", 9)).toStrictEqual([
    "one two",
    "three",
    "four",
  ]);
  const long = "averyveryverylongword";
  const pieces = wrap(long, 8);
  expect(widest(pieces)).toBeLessThanOrEqual(8);
  expect(pieces.join("")).toBe(long);
  expect(wrap("", 10)).toStrictEqual([""]);
});

test("parseKeys decodes arrows, enter, escape, backspace, and pasted text", () => {
  expect(parseKeys("\x1b[A\x1b[B")).toMatchObject([
    { name: "up" },
    { name: "down" },
  ]);
  expect(parseKeys("\x1bOA")).toMatchObject([{ name: "up" }]);
  expect(parseKeys("\r")).toMatchObject([{ name: "enter" }]);
  expect(parseKeys("\x1b")).toMatchObject([{ name: "escape" }]);
  expect(parseKeys("\x7f")).toMatchObject([{ name: "backspace" }]);
  expect(parseKeys("\x03")).toMatchObject([{ name: "interrupt" }]);
  expect(parseKeys("sk-1")).toMatchObject([
    { char: "s" },
    { char: "k" },
    { char: "-" },
    { char: "1" },
  ]);
  expect(parseKeys("\x1b[99~")).toStrictEqual([]);
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
  expect(focused(state)).toBe("a");
  state = press(state, "down", "down");
  expect(focused(state)).toBe("c");
  state = press(state, "down");
  expect(focused(state)).toBe("a");
  expect(focused(press(state, "up"))).toBe("c");
  expect(focused(createSelect(ITEMS, { initial: "c" }))).toBe("c");
});

test("enter selects, escape and q cancel, ctrl-c is an interrupt", () => {
  const state = createSelect(ITEMS);
  expect(press(state, "down", "enter").done).toStrictEqual({ value: "b" });
  expect(press(state, "escape").done).toStrictEqual({ cancel: true });
  expect(press(state, { name: "char", char: "q" }).done).toStrictEqual({
    cancel: true,
  });
  expect(press(state, "interrupt").done.interrupted).toBe(true);
});

test("filtering narrows the list, escape clears it first, and custom IDs are offered", () => {
  let state = createSelect(ITEMS, { filterable: true, allowCustom: true });
  state = press(state, ...chars("gam"));
  expect(visible(state).length).toBe(2);
  expect(focused(state)).toBe("c");
  expect(visible(state).at(-1).value).toBe("gam");
  state = press(state, "escape");
  expect(state.query).toBe("");
  expect(state.done).toBe(undefined);
  expect(press(state, "escape").done).toStrictEqual({ cancel: true });
  const typed = press(
    createSelect(ITEMS, { filterable: true, allowCustom: true }),
    ...chars("zzz"),
  );
  expect(press(typed, "enter").done).toStrictEqual({ value: "zzz" });
  expect(focused(press(typed, "backspace", "backspace", "backspace"))).toBe(
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
  expect(widest(lines), "too wide").toBeLessThanOrEqual(72);
  const text = lines.join("\n");
  expect(text).toMatch(/↑ \d+ more/);
  expect(text).toMatch(/↓ \d+ more/);
  expect(text).toMatch(/21\/40|40\/40/);
});

const filled = (n) =>
  [...strip(contextBar(n, plain))].filter((ch) => ch !== "·").length;

test("context bars keep a fixed width and grow with the window", () => {
  expect(
    widths([
      contextBar(0, plain),
      contextBar(4000, plain),
      contextBar(8000, plain),
      contextBar(128000, plain),
      contextBar(1_000_000, plain),
      contextBar(5_000_000, plain),
    ]),
  ).toStrictEqual([8, 8, 8, 8, 8, 8]);
  expect(filled(8000)).toBeLessThanOrEqual(filled(128000));
  expect(filled(128000)).toBeLessThanOrEqual(filled(1_000_000));
  expect(filled(2_000_000)).toBeGreaterThanOrEqual(filled(1_000_000));
  expect(visibleWidth(contextBar(200000, { ...plain, unicode: false }))).toBe(
    8,
  );
  expect(formatTokens(200000)).toBe("200k");
  expect(formatTokens(1_000_000)).toBe("1M");
  expect(formatTokens(1_500_000)).toBe("1.5M");
  expect(formatTokens(null)).toBe("");
});

test("panels have uniform width and ledger rows align", () => {
  const box = panel(
    "ready",
    ["› cn claude", "", "a much longer line of text"],
    plain,
  );
  expect(new Set(widths(box)).size).toBe(1);
  expect(box[0]).toMatch(/╭─ ready ─+╮/);
  expect(visibleWidth(ledger("ok", "key", "x", plain))).toBe(
    visibleWidth(ledger("bad", "Codex CLI", "x", plain)),
  );
  expect(fit("abcdefghij", 5)).toBe("abcd…");
  expect(fit("abc", 5)).toBe("abc");
});

test("clip cuts to visible columns, keeps colors closed, and leaves plain text plain", async () => {
  expect(clip("abcdef", 4)).toBe("abcd");
  expect(clip("abc", 4)).toBe("abc");
  const colored = paint("focus", "abcdef", {}, truecolor);
  const cut = clip(colored, 3);
  expect(strip(cut)).toBe("abc");
  expect(cut.endsWith("\x1b[0m"), "an open color is closed").toBe(true);
  expect(
    clip("abcdef", 3),
    "no escape codes added to plain text",
  ).not.toContain("\x1b");
});

test("the layout width stays one column inside the terminal", () => {
  expect(caps({}, { isTTY: true, columns: 40 }).width).toBe(39);
  expect(caps({}, { isTTY: true, columns: 300 }).width).toBe(100);
  expect(caps({}, { isTTY: true, columns: 10 }).width).toBe(20);
  const narrow = { ...plain, width: 39 };
  const state = createSelect([
    {
      value: "a",
      label: "claude",
      note: "Claude Code  claude-sonnet-4-6",
      right: "ready",
    },
  ]);
  expect(widest(renderSelect(state, {}, narrow))).toBeLessThanOrEqual(39);
  expect(renderSelect(state, {}, narrow).join("\n")).toMatch(/ready/);
});

test("a screen stops reacting to signals while a child tool owns the terminal", async () => {
  const out = { write() {} };
  const count = () => process.listenerCount("SIGINT");
  const before = count();
  const screen = openScreen(out);
  expect(count()).toBe(before + 1);
  screen.suspend();
  expect(count(), "Ctrl+C meant for the tool reached the menu").toBe(before);
  screen.resume();
  expect(count()).toBe(before + 1);
  expect(fullScreenActive()).toBe(true);
  screen.close();
  expect(count()).toBe(before);
  expect(fullScreenActive()).toBe(false);
});

const keyScreen = { ...plain, width: 99 };

test.each([
  ["idle", 30, 8],
  ["idle", 36, 14],
  ["idle", 60, 18],
  ["idle", 100, 30],
  ["idle", 160, 50],
  ["busy", 30, 8],
  ["busy", 36, 14],
  ["busy", 60, 18],
  ["busy", 100, 30],
  ["busy", 160, 50],
  ["error", 30, 8],
  ["error", 36, 14],
  ["error", 60, 18],
  ["error", 100, 30],
  ["error", 160, 50],
  ["done", 30, 8],
  ["done", 36, 14],
  ["done", 60, 18],
  ["done", 100, 30],
  ["done", 160, 50],
])(
  "the key screen is centered, fits any terminal, and never shows the key: %s %ix%i",
  (status, columns, rows) => {
    const { lines, left, top } = renderKeyEntry(
      {
        value: "sk-cn-v1-very-secret-value",
        status,
        message: "Concentrate AI rejected this API key (HTTP 401)",
        frame: 0,
      },
      columns,
      rows,
      keyScreen,
    );
    expect(lines.length, "too tall").toBeLessThanOrEqual(rows);
    expect(top + lines.length, "runs off the bottom").toBeLessThanOrEqual(rows);
    expect(
      left + widest(lines),
      "a line is wider than the terminal",
    ).toBeLessThanOrEqual(columns);
    expect(
      lines.join("\n"),
      "the key must only be drawn as dots",
    ).not.toContain("secret");
  },
);

test("the key screen is centered, fits any terminal, and never shows the key: empty card", () => {
  const wide = renderKeyEntry(
    { value: "", status: "idle", message: "", frame: 0 },
    100,
    30,
    keyScreen,
  );
  const text = wide.lines.join("\n");
  expect(text).toMatch(/Connect your API key/);
  expect(text).toMatch(/Paste your key here/);
  expect(text).toMatch(/concentrate\.ai\/settings\/api-keys/);
  expect(wide.left, "the card is centered horizontally").toBeGreaterThan(10);
  expect(wide.top, "the card is centered vertically").toBeGreaterThan(3);
});
