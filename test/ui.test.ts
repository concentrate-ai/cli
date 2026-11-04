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

test("fullscreen menus fit resized terminals and keep the focused action visible", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({
    value: `item-${i}`,
    label: `action-${i}`,
    note: "Tool settings",
  }));
  const state = createSelect(items, { initial: "item-42", filterable: true });
  for (const [width, height] of [
    [39, 12],
    [69, 23],
    [99, 39],
    [159, 49],
  ]) {
    for (const color of [0, 24]) {
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
      expect(frame.every((line) => visibleWidth(line) <= width)).toBeTruthy();
      const text = strip(frame.join("\n"));
      expect(text).toMatch(/action-42/);
      expect(text).toMatch(/Concentrate/);
      expect(text).toMatch(/back/);
    }
  }
});

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
  expect(
    !row.includes("\x1b[0m"),
    "no full reset inside a highlighted row",
  ).toBeTruthy();
  expect(row.startsWith("\x1b[48;2;") && row.endsWith("\x1b[49m")).toBeTruthy();
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
  for (const line of wide) expect(visibleWidth(line) <= 79).toBeTruthy();
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
  expect(pieces.every((piece) => piece.length <= 8)).toBeTruthy();
  expect(pieces.join("")).toBe(long);
  expect(wrap("", 10)).toStrictEqual([""]);
});

test("parseKeys decodes arrows, enter, escape, backspace, and pasted text", () => {
  expect(parseKeys("\x1b[A\x1b[B").map((k) => k.name)).toStrictEqual([
    "up",
    "down",
  ]);
  expect(parseKeys("\x1bOA").map((k) => k.name)).toStrictEqual(["up"]);
  expect(parseKeys("\r").map((k) => k.name)).toStrictEqual(["enter"]);
  expect(parseKeys("\x1b").map((k) => k.name)).toStrictEqual(["escape"]);
  expect(parseKeys("\x7f").map((k) => k.name)).toStrictEqual(["backspace"]);
  expect(parseKeys("\x03").map((k) => k.name)).toStrictEqual(["interrupt"]);
  expect(parseKeys("sk-1").map((k) => k.char)).toStrictEqual([
    "s",
    "k",
    "-",
    "1",
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
  for (const char of "gam") state = press(state, { name: "char", char });
  expect(visible(state).length).toBe(2);
  expect(focused(state)).toBe("c");
  expect(visible(state).at(-1).value).toBe("gam");
  state = press(state, "escape");
  expect(state.query).toBe("");
  expect(state.done).toBe(undefined);
  expect(press(state, "escape").done).toStrictEqual({ cancel: true });
  const typed = press(
    createSelect(ITEMS, { filterable: true, allowCustom: true }),
    ...[..."zzz"].map((char) => ({ name: "char", char })),
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
  for (const line of lines)
    expect(
      visibleWidth(line) <= 72,
      `too wide (${visibleWidth(line)}): ${line}`,
    ).toBeTruthy();
  const text = lines.join("\n");
  expect(text).toMatch(/↑ \d+ more/);
  expect(text).toMatch(/↓ \d+ more/);
  expect(text).toMatch(/21\/40|40\/40/);
});

test("context bars keep a fixed width and grow with the window", () => {
  const widths = [0, 4000, 8000, 128000, 1_000_000, 5_000_000].map((n) =>
    visibleWidth(contextBar(n, plain)),
  );
  expect(
    widths.every((w) => w === 8),
    widths.join(),
  ).toBeTruthy();
  const filled = (n) =>
    [...strip(contextBar(n, plain))].filter((ch) => ch !== "·").length;
  expect(filled(8000) <= filled(128000)).toBeTruthy();
  expect(filled(128000) <= filled(1_000_000)).toBeTruthy();
  expect(filled(2_000_000) >= filled(1_000_000)).toBeTruthy();
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
  expect(new Set(box.map(visibleWidth)).size).toBe(1);
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
  expect(cut.endsWith("\x1b[0m"), "an open color is closed").toBeTruthy();
  expect(
    !clip("abcdef", 3).includes("\x1b"),
    "no escape codes added to plain text",
  ).toBeTruthy();
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
  for (const line of renderSelect(state, {}, narrow))
    expect(visibleWidth(line) <= 39, line).toBeTruthy();
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

test("the key screen is centered, fits any terminal, and never shows the key", () => {
  const plain = {
    tty: true,
    color: 0,
    unicode: true,
    width: 99,
    motion: false,
  };
  const secret = "sk-cn-v1-very-secret-value";
  for (const status of ["idle", "busy", "error", "done"]) {
    for (const [columns, rows] of [
      [30, 8],
      [36, 14],
      [60, 18],
      [100, 30],
      [160, 50],
    ]) {
      const { lines, left, top } = renderKeyEntry(
        {
          value: secret,
          status,
          message: "Concentrate AI rejected this API key (HTTP 401)",
          frame: 0,
        },
        columns,
        rows,
        plain,
      );
      expect(
        lines.length <= rows,
        `${columns}x${rows} ${status}: too tall`,
      ).toBeTruthy();
      expect(
        top + lines.length <= rows,
        `${columns}x${rows}: runs off the bottom`,
      ).toBeTruthy();
      for (const line of lines)
        expect(
          left + visibleWidth(line) <= columns,
          `${columns}x${rows} ${status}: a line is wider than the terminal`,
        ).toBeTruthy();
      expect(
        !lines.join("\n").includes("secret"),
        "the key must only be drawn as dots",
      ).toBeTruthy();
    }
  }
  const wide = renderKeyEntry(
    { value: "", status: "idle", message: "", frame: 0 },
    100,
    30,
    plain,
  );
  const text = wide.lines.join("\n");
  expect(text).toMatch(/Connect your API key/);
  expect(text).toMatch(/Paste your key here/);
  expect(text).toMatch(/concentrate\.ai\/settings\/api-keys/);
  expect(wide.left > 10, "the card is centered horizontally").toBeTruthy();
  expect(wide.top > 3, "the card is centered vertically").toBeTruthy();
});
