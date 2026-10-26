import type {
  Environment,
  Key,
  MenuItem,
  Selection,
  SelectOptions,
  SelectState,
  TerminalCapabilities,
} from "../types.js";
import process from "node:process";

import { CnError } from "../errors.js";
import { hints } from "./layout.js";
import {
  bold,
  caps,
  clip,
  fit,
  pad,
  paint,
  surface,
  SURFACE,
  visibleWidth,
} from "./term.js";
import { glyphs } from "./theme.js";

export function interactive(env: Environment = process.env) {
  return (
    Boolean(process.stdin.isTTY && process.stdout.isTTY) && env.TERM !== "dumb"
  );
}

// ---- keys ------------------------------------------------------------------

const TOKEN = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;

export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  for (const token of chunk.match(TOKEN) ?? []) {
    switch (token) {
      case "\x1b[A":
      case "\x1bOA":
        keys.push({ name: "up" });
        break;
      case "\x1b[B":
      case "\x1bOB":
      case "\t":
        keys.push({ name: "down" });
        break;
      case "\x1b[H":
      case "\x1b[1~":
        keys.push({ name: "home" });
        break;
      case "\x1b[F":
      case "\x1b[4~":
        keys.push({ name: "end" });
        break;
      case "\x1b":
        keys.push({ name: "escape" });
        break;
      case "\r":
      case "\n":
        keys.push({ name: "enter" });
        break;
      case "\x7f":
      case "\b":
        keys.push({ name: "backspace" });
        break;
      case "\x15":
        keys.push({ name: "clear" });
        break;
      case "\x03":
        keys.push({ name: "interrupt" });
        break;
      case "\x04":
        keys.push({ name: "eof" });
        break;
      default:
        if (!token.startsWith("\x1b") && token >= " ")
          keys.push({ name: "char", char: token });
    }
  }
  return keys;
}

// A kill signal skips the "exit" hook, so put the terminal back first, then die as asked.
function guardSignals(restore: () => void) {
  const handlers: [NodeJS.Signals, () => void][] = [
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
  ].map((signal) => {
    const handler = () => {
      release();
      restore();
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
    return [signal as NodeJS.Signals, handler];
  });
  const release = () =>
    handlers.forEach(([signal, handler]) => process.off(signal, handler));
  return release;
}

// An escape sequence can arrive split across reads; a trailing ESC waits briefly for the rest.
const PARTIAL_ESCAPE = /\x1b(?:\[[0-9;]*|O)?$/;
const ESCAPE_WAIT_MS = 40;

function readKeys(onKey: (key: Key) => void, onFail: (error: unknown) => void) {
  const { stdin, stdout } = process;
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const emit = (text: string) => {
    try {
      for (const key of parseKeys(text)) onKey(key);
    } catch (error) {
      onFail(error);
    }
  };
  const onData = (chunk: string) => {
    clearTimeout(timer);
    const text = pending + chunk;
    pending = "";
    const partial = PARTIAL_ESCAPE.exec(text);
    if (!partial) return emit(text);
    pending = partial[0];
    emit(text.slice(0, partial.index));
    timer = setTimeout(() => {
      const rest = pending;
      pending = "";
      emit(rest);
    }, ESCAPE_WAIT_MS);
  };
  const restore = () => {
    clearTimeout(timer);
    stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\x1b[?25h");
  };
  const unguard = guardSignals(restore);
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  return () => {
    unguard();
    restore();
  };
}

let exitHookSet = false;
function hideCursor(out: NodeJS.WriteStream) {
  if (!exitHookSet) {
    exitHookSet = true;
    process.once("exit", () => out.write("\x1b[?25h"));
  }
  out.write("\x1b[?25l");
}

// ---- select: state, reducer, renderer -------------------------------------------

export function visible({
  items,
  query,
  allowCustom,
}: Pick<SelectState, "items" | "query" | "allowCustom">) {
  if (!query) return items;
  const needle = query.toLowerCase();
  const matches = items.filter(
    (item) =>
      !item.group &&
      `${item.label} ${item.note ?? ""} ${item.search ?? ""}`
        .toLowerCase()
        .includes(needle),
  );
  if (allowCustom && !items.some((item) => item.value === query)) {
    matches.push({
      value: query,
      label: query,
      note: "use as a custom ID",
      tone: "focus",
    });
  }
  return matches;
}

function selectable(list: MenuItem[], from: number, direction: number) {
  const count = list.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (((from + direction * step) % count) + count) % count;
    if (!list[index].group) return index;
  }
  return from;
}

const firstSelectable = (list: MenuItem[]) => {
  const index = list.findIndex((item) => !item.group);
  return index === -1 ? 0 : index;
};

export function createSelect(
  items: MenuItem[],
  {
    initial,
    filterable = false,
    allowCustom = false,
    rows = 10,
  }: Omit<SelectOptions, "items"> = {},
): SelectState {
  const state = { items, query: "", cursor: 0, filterable, allowCustom, rows };
  const list = visible(state);
  const at = list.findIndex((item) => !item.group && item.value === initial);
  return { ...state, cursor: at === -1 ? firstSelectable(list) : at };
}

export function reduce(state: SelectState, key: Key): SelectState {
  const list = visible(state);
  const refocus = (next: SelectState) => ({
    ...next,
    cursor: firstSelectable(visible(next)),
  });
  switch (key.name) {
    case "up":
      return list.length
        ? { ...state, cursor: selectable(list, state.cursor, -1) }
        : state;
    case "down":
      return list.length
        ? { ...state, cursor: selectable(list, state.cursor, 1) }
        : state;
    case "home":
      return { ...state, cursor: firstSelectable(list) };
    case "end":
      return list.length
        ? { ...state, cursor: selectable(list, 0, -1) }
        : state;
    case "enter": {
      const item = list[state.cursor];
      return item && !item.group && item.value !== undefined
        ? { ...state, done: { value: item.value } }
        : state;
    }
    case "escape":
      return state.filterable && state.query
        ? refocus({ ...state, query: "" })
        : { ...state, done: { cancel: true } };
    case "eof":
      return { ...state, done: { cancel: true } };
    case "interrupt":
      return { ...state, done: { cancel: true, interrupted: true } };
    case "backspace":
      return refocus({ ...state, query: state.query.slice(0, -1) });
    case "clear":
      return refocus({ ...state, query: "" });
    case "char":
      if (state.filterable)
        return refocus({ ...state, query: state.query + key.char });
      return key.char === "q" ? { ...state, done: { cancel: true } } : state;
    default:
      return state;
  }
}

// Break plain text into lines of at most `max` columns, at spaces where possible.
export function wrap(text: string, max: number) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if ([...line].length + 1 + [...word].length <= max) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
    while ([...line].length > max) {
      lines.push([...line].slice(0, max).join(""));
      line = [...line].slice(max).join("");
    }
  }
  return lines.length || line ? [...lines, line].filter(Boolean) : [""];
}

// Column widths shared by every row, so labels, names, and models line up.
function columns(list: MenuItem[]) {
  const rows = list.filter((item) => !item.group);
  const widest = (key: "label" | "note", cap: number) =>
    Math.min(
      cap,
      Math.max(0, ...rows.map((item) => [...(item[key] ?? "")].length)),
    );
  return {
    label: widest("label", 30),
    note: rows.some((item) => item.meta !== undefined) ? widest("note", 18) : 0,
  };
}

function renderRow(
  item: MenuItem,
  focused: boolean,
  cols: { label: number; note: number },
  width: number,
  c: TerminalCapabilities,
) {
  const g = glyphs(c);
  if (item.group)
    return `  ${paint("mute", item.group.toUpperCase(), { bold: true }, c)}`;
  const edge = focused ? paint("focus", g.bar, {}, c) : " ";
  const label = paint(
    focused ? "text" : "mute",
    pad(item.label ?? "", cols.label),
    { bold: focused },
    c,
  );
  const right = item.right ?? "";
  const lead = ` ${edge} ${label}  `;
  const room = Math.max(
    0,
    width - visibleWidth(lead) - (right ? visibleWidth(right) + 2 : 0),
  );
  let body = "";
  if (item.meta !== undefined) {
    const meta = (text: number) =>
      paint(
        focused ? "core" : "soft",
        fit(item.meta ?? "", text, g.ellipsis),
        {},
        c,
      );
    // On a narrow terminal the model matters more than the product name.
    if (room - cols.note - 2 >= Math.min(16, [...item.meta].length)) {
      body = `${paint("mute", pad(fit(item.note ?? "", cols.note, g.ellipsis), cols.note), {}, c)}  ${meta(room - cols.note - 2)}`;
    } else {
      body = meta(room);
    }
  } else if (item.note) {
    body = paint(item.tone ?? "mute", fit(item.note, room, g.ellipsis), {}, c);
  }
  let line = lead + body;
  if (right)
    line +=
      " ".repeat(
        Math.max(1, width - visibleWidth(line) - visibleWidth(right)),
      ) + right;
  return focused ? surface(SURFACE.selected, pad(line, width), c) : line;
}

export function renderSelect(
  state: SelectState,
  options: Omit<SelectOptions, "items"> = {},
  c = caps(),
) {
  const g = glyphs(c);
  const list = visible(state);
  const width = Math.min(c.width, 72);
  const lines = [];
  if (options.title) lines.push(`  ${bold(options.title, c)}`, "");
  if (state.filterable) {
    const typed = state.query
      ? state.query + paint("focus", g.caret, {}, c)
      : paint("mute", "type to filter", {}, c);
    const total = state.items.filter((item) => !item.group).length;
    const count = paint(
      "mute",
      `${list.filter((item) => !item.group).length}/${total}`,
      {},
      c,
    );
    const left = `  ${paint("focus", g.info, {}, c)} ${typed}`;
    lines.push(
      left +
        " ".repeat(
          Math.max(1, width - visibleWidth(left) - visibleWidth(count)),
        ) +
        count,
    );
  }
  const cols = columns(list);
  const rows = Math.max(3, state.rows);
  const windowed = list.length > rows;
  const offset = windowed
    ? Math.min(
        Math.max(0, state.cursor - Math.floor(rows / 2)),
        list.length - rows,
      )
    : 0;
  const shown = windowed ? list.slice(offset, offset + rows) : list;
  const more = (count: number, arrow: string) =>
    count > 0 ? `    ${paint("mute", `${arrow} ${count} more`, {}, c)}` : "";
  if (windowed) lines.push(more(offset, g.up));
  if (!list.length) lines.push(`    ${paint("mute", "no matches", {}, c)}`);
  shown.forEach((item, index) => {
    // Space before each section after the first, instead of a rule.
    if (item.group && index > 0) lines.push("");
    lines.push(
      renderRow(item, offset + index === state.cursor, cols, width, c),
    );
  });
  if (windowed) lines.push(more(list.length - offset - shown.length, g.down));
  const focused = list[state.cursor];
  if (options.detail && focused && !focused.group) {
    const text = options.detail(focused).join(" ");
    const [first, ...rest] = wrap(text, width - 4);
    lines.push(
      "",
      `  ${paint("focus", g.info, {}, c)} ${paint("mute", first, {}, c)}`,
      ...rest.map((line) => `    ${paint("mute", line, {}, c)}`),
    );
  }
  lines.push("");
  if (options.legend) lines.push(`  ${options.legend}`);
  lines.push(
    hints(
      options.hints ?? [
        [`${g.up}${g.down}`, "move"],
        [g.enter, "select"],
        ["esc", "back"],
      ],
      c,
    ),
  );
  return lines;
}

// Settles a widget exactly once, always giving the terminal back first.
function settleOnce(cleanup: () => void) {
  let done = false;
  return (settle: () => void) => {
    if (done) return;
    done = true;
    try {
      cleanup();
    } finally {
      settle();
    }
  };
}

export function select(options: SelectOptions, env: Environment = process.env) {
  const out = process.stdout;
  const c = caps(env, out);
  let state = createSelect(options.items, options);
  let printed = 0;
  const erase = () => {
    if (printed) out.write(`\x1b[${printed}A\r\x1b[J`);
    printed = 0;
  };
  // Lines are clipped to the terminal so none wraps; otherwise the redraw would miscount.
  const draw = () => {
    const columns = Math.max(20, (out.columns || 80) - 1);
    const lines = renderSelect(state, options, c).map((line) =>
      clip(line, columns),
    );
    erase();
    out.write(lines.join("\n") + "\n");
    printed = lines.length;
  };
  return new Promise<Selection>((resolve, reject) => {
    let stop = () => {};
    const finish = settleOnce(() => {
      stop();
      erase();
    });
    const fail = (error: unknown) => finish(() => reject(error));
    try {
      hideCursor(out);
      stop = readKeys((key) => {
        state = reduce(state, key);
        if (!state.done) return draw();
        const { done } = state;
        return finish(() =>
          done.interrupted
            ? reject(new CnError("Cancelled", 130))
            : resolve(done),
        );
      }, fail);
      draw();
    } catch (error) {
      fail(error);
    }
  });
}

// ---- masked input ---------------------------------------------------------------

export function password(
  { label, placeholder = "" }: { label: string; placeholder?: string },
  env: Environment = process.env,
) {
  const out = process.stdout;
  const c = caps(env, out);
  const g = glyphs(c);
  let value = "";
  const draw = () => {
    const shown = value
      ? paint("core", g.bullet.repeat(Math.min(value.length, 36)), {}, c) +
        (value.length > 36
          ? paint("mute", ` +${value.length - 36}`, {}, c)
          : "")
      : paint("mute", placeholder, {}, c);
    out.write(
      `\r\x1b[2K${clip(`  ${paint("focus", g.info, { bold: true }, c)} ${bold(label, c)}  ${shown}`, Math.max(20, (out.columns || 80) - 1))}`,
    );
  };
  return new Promise<string>((resolve, reject) => {
    let stop = () => {};
    const finish = settleOnce(() => {
      stop();
      out.write("\r\x1b[2K");
    });
    const fail = (error: unknown) => finish(() => reject(error));
    try {
      stop = readKeys((key) => {
        if (key.name === "enter" || key.name === "eof")
          return finish(() => resolve(value.trim()));
        if (key.name === "interrupt")
          return finish(() => reject(new CnError("Cancelled", 130)));
        if (key.name === "backspace") value = value.slice(0, -1);
        else if (key.name === "clear") value = "";
        else if (key.name === "char") value += key.char;
        return draw();
      }, fail);
      draw();
    } catch (error) {
      fail(error);
    }
  });
}

// ---- spinner: a breathing aperture ------------------------------------------------

export function spinner(text: string, env: Environment = process.env) {
  const out = process.stdout;
  const c = caps(env, out);
  const frames = glyphs(c).spin;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  const draw = () =>
    out.write(
      `\r\x1b[2K  ${paint("focus", frames[frame++ % frames.length], {}, c)} ${paint("mute", text, {}, c)}`,
    );
  let unguard = () => {};
  const restore = () => out.write("\r\x1b[2K\x1b[?25h");
  const end = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    unguard();
    restore();
  };
  if (c.motion) {
    hideCursor(out);
    unguard = guardSignals(restore);
    draw();
    timer = setInterval(draw, 110);
  }
  return {
    succeed(line: string) {
      end();
      out.write(line + "\n");
    },
    stop: end,
  };
}
