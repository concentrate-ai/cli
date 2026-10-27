import process from "node:process";
import { wordmark } from "./brand.js";
import { caps, paint } from "./term.js";
import { glyphs } from "./theme.js";

// Keep cn's screens out of shell scrollback. A child tool gets the normal
// terminal, including the ability to manage its own alternate screen.
let current: ReturnType<typeof createScreen> | undefined;

export const fullScreenActive = () => Boolean(current?.active);

function createScreen(out: NodeJS.WriteStream) {
  let active = false;
  const enter = () => {
    if (active) return;
    active = true;
    out.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l");
  };
  const leave = () => {
    if (!active) return;
    active = false;
    out.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  };
  return {
    get active() {
      return active;
    },
    enter,
    leave,
  };
}

export function openScreen(out = process.stdout) {
  const screen = createScreen(out);
  current = screen;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal: NodeJS.Signals) => {
    close();
    process.kill(process.pid, signal);
  };
  const handlers = signals.map((signal) => {
    const handler = () => onSignal(signal);
    return [signal, handler] as const;
  });
  const attach = () => {
    for (const [signal, handler] of handlers) process.on(signal, handler);
  };
  const detach = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  const close = () => {
    screen.leave();
    if (current === screen) current = undefined;
    process.off("exit", close);
    detach();
  };
  process.once("exit", close);
  attach();
  screen.enter();
  return {
    close,
    // While a child tool owns the terminal its signals are its own business: a
    // Ctrl+C meant for it must not tear this screen down.
    suspend() {
      detach();
      screen.leave();
    },
    resume() {
      attach();
      screen.enter();
    },
  };
}

export function clearScreen(title?: string) {
  if (!fullScreenActive()) return;
  process.stdout.write("\x1b[2J\x1b[H");
  if (title) {
    const c = caps();
    process.stdout.write(
      `  ${wordmark(c)}\n  ${paint("mute", title, {}, c)}\n${paint("edge", glyphs(c).rule.repeat(c.width), {}, c)}\n\n`,
    );
  }
}
