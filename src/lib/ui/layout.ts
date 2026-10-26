import type { Tone, ColorRole } from "../types.js";
import {
  bold,
  caps,
  pad,
  paint,
  surface,
  SURFACE,
  visibleWidth,
} from "./term.js";
import { glyphs } from "./theme.js";

const TONE_ROLE: Record<Tone, ColorRole> = {
  ok: "ok",
  warn: "focus",
  bad: "bad",
  mute: "mute",
  info: "core",
};

const LABEL_WIDTH = 13;

// One status row: marker, muted label, value. The marker carries the tone.
export function ledger(tone: Tone, label: string, value = "", c = caps()) {
  const g = glyphs(c);
  const mark = {
    ok: g.ok,
    warn: g.half,
    bad: g.bad,
    mute: g.off,
    info: g.info,
  }[tone];
  return `  ${paint(TONE_ROLE[tone], mark, {}, c)} ${paint("mute", pad(label, LABEL_WIDTH), {}, c)} ${value}`;
}

// Keys drawn as caps; without background color they fall back to plain accented text.
export function hints(pairs: string[][], c = caps()) {
  const key = (name: string) =>
    c.color === 24 || c.color === 256
      ? surface(SURFACE.keycap, paint("text", ` ${name} `, {}, c), c)
      : paint("core", name, {}, c);
  return (
    "  " +
    pairs
      .map(([name, label]) => `${key(name)} ${paint("mute", label, {}, c)}`)
      .join("   ")
  );
}

// Rounded box with the title set into the top edge.
export function panel(title: string, lines: string[], c = caps()) {
  const g = glyphs(c);
  const content = Math.max(visibleWidth(title) + 1, ...lines.map(visibleWidth));
  const edge = (text: string) => paint("mute", text, {}, c);
  const top = `${edge(g.tl + g.rule)} ${bold(title, c)} ${edge(g.rule.repeat(content - visibleWidth(title) - 1) + g.tr)}`;
  const body = lines.map(
    (line) => `${edge(g.v)} ${pad(line, content)} ${edge(g.v)}`,
  );
  const bottom = edge(g.bl + g.rule.repeat(content + 2) + g.br);
  return [top, ...body, bottom].map((line) => `  ${line}`);
}
