import type { Environment } from "../types.js";
import { errorMessage } from "../validation.js";
import { wordmark } from "./brand.js";
import { hints } from "./layout.js";
import { bold, caps, clip, pad, paint, visibleWidth } from "./term.js";
import { glyphs } from "./theme.js";
import { readKeys, wrap } from "./widgets.js";

export type KeyEntryResult = { key: string } | { skipped: true };

type Status = "idle" | "busy" | "error" | "done";

export interface KeyEntryState {
  value: string;
  status: Status;
  message: string;
  frame: number;
}

const URL_TEXT = "concentrate.ai/settings/api-keys";
const MAX_SHOWN = 40;

// The card, centered in the terminal. Pure, so layout can be tested. The key is
// only ever drawn as dots.
export function renderKeyEntry(
  state: KeyEntryState,
  columns: number,
  rows: number,
  c = caps(),
) {
  const g = glyphs(c);
  const inner = Math.max(24, Math.min(56, columns - 10));
  const width = inner + 4;
  const left = Math.max(0, Math.floor((columns - width) / 2));
  const center = (text: string) =>
    " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) +
    text;

  const border: "focus" | "bad" | "ok" =
    state.status === "error" ? "bad" : state.status === "done" ? "ok" : "focus";
  const edge = (text: string) => paint(border, text, {}, c);

  const dots = Math.min(state.value.length, MAX_SHOWN);
  const more =
    state.value.length > MAX_SHOWN
      ? paint("mute", ` +${state.value.length - MAX_SHOWN}`, {}, c)
      : "";
  const field = state.value
    ? paint("core", g.bullet.repeat(dots), {}, c) + more
    : paint("mute", "Paste your key here", {}, c);
  const caret = state.status === "idle" ? paint("focus", g.caret, {}, c) : "";
  const body = state.value ? field + caret : caret + field;

  let status: string;
  if (state.status === "busy")
    status = `${paint("focus", g.spin[state.frame % g.spin.length], {}, c)} ${paint("mute", "Checking your key", {}, c)}`;
  else if (state.status === "error")
    status = `${paint("bad", g.bad, {}, c)} ${state.message}`;
  else if (state.status === "done")
    status = `${paint("ok", g.ok, {}, c)} ${state.message}`;
  else status = paint("mute", "Stored privately on this computer.", {}, c);

  const intro = wrap(
    `Paste your Concentrate API key to get started. You can create one at ${URL_TEXT}.`,
    width,
  ).map((line) => paint("mute", line, {}, c));

  const box = [
    edge(g.tl + g.rule.repeat(width - 2) + g.tr),
    `${edge(g.v)} ${pad(body, width - 4)} ${edge(g.v)}`,
    edge(g.bl + g.rule.repeat(width - 2) + g.br),
    `  ${status}`,
  ];
  const keys = center(
    hints(
      [
        ["↵", "continue"],
        ["esc", "skip for now"],
      ],
      c,
    ).trimStart(),
  );
  const full = [
    center(wordmark(c)),
    center(paint("mute", "One key for every coding agent", {}, c)),
    "",
    bold("Connect your API key", c),
    ...intro,
    "",
    ...box,
    "",
    keys,
  ];
  // A short terminal drops the explanation before it would scroll.
  const lines =
    full.length <= rows
      ? full
      : rows >= box.length + 4
        ? [center(wordmark(c)), "", ...box, "", keys]
        : box;
  const top = Math.max(0, Math.floor((rows - lines.length) / 2) - 1);
  return { lines: lines.map((line) => clip(line, width)), left, top };
}

// A full-screen prompt for the key, with the check done in place: a rejected key
// stays on screen to be corrected, and a good one continues straight on.
export function keyEntry(
  { verify }: { verify: (key: string) => Promise<void> },
  env: Environment = process.env,
) {
  const out = process.stdout;
  const c = caps(env, out);
  const state: KeyEntryState = {
    value: "",
    status: "idle",
    message: "",
    frame: 0,
  };
  const draw = () => {
    const { lines, left, top } = renderKeyEntry(
      state,
      out.columns || 80,
      out.rows || 24,
      c,
    );
    let text = "\x1b[?25l\x1b[H";
    lines.forEach((line, i) => {
      text += `\x1b[${top + i + 1};1H\x1b[2K${" ".repeat(left)}${line}`;
    });
    out.write(text + "\x1b[J");
  };

  return new Promise<KeyEntryResult>((resolve, reject) => {
    let stop = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const finish = (result: KeyEntryResult | Error) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      out.off("resize", draw);
      stop();
      out.write("\x1b[2J\x1b[H");
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const submit = async () => {
      const key = state.value.trim();
      state.status = "busy";
      state.frame = 0;
      timer = setInterval(() => {
        state.frame += 1;
        draw();
      }, 110);
      draw();
      try {
        await verify(key);
      } catch (error) {
        clearInterval(timer);
        state.status = "error";
        // The command-line flag does not apply on this screen.
        state.message = errorMessage(error).replace(
          / Try again or use --no-verify\.?/,
          " Check your connection and try again.",
        );
        draw();
        return;
      }
      clearInterval(timer);
      state.status = "done";
      state.message = "Key verified. Opening Concentrate...";
      draw();
      setTimeout(() => finish({ key }), 700);
    };
    try {
      stop = readKeys(
        (key) => {
          if (state.status === "busy" || state.status === "done") return;
          if (key.name === "interrupt" || key.name === "escape")
            return finish({ skipped: true });
          if (key.name === "enter") {
            if (state.value.trim()) void submit();
            return;
          }
          if (state.status === "error") state.status = "idle";
          if (key.name === "backspace") state.value = state.value.slice(0, -1);
          else if (key.name === "clear") state.value = "";
          else if (key.name === "char")
            state.value += key.char.replace(/\s+/g, "");
          draw();
        },
        (error) => finish(error instanceof Error ? error : new Error("input")),
      );
      out.on("resize", draw);
      draw();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("input"));
    }
  });
}
