import process from "node:process";

import { caps, mix, paint, paintRgb, PALETTE, visibleWidth } from "./term.js";
import { glyphs } from "./theme.js";

export const NAME = "Concentrate AI";
const TAGLINE = "one key for every coding agent";

// The mark: a ring closing on an amber point, a lens bringing light into focus.
// Drawn in half blocks (9x8 "pixels"), shading from deep to light indigo.
const RING = [" ▄▄███▄▄ ", "██▀   ▀██", "██▄   ▄██", " ▀▀███▀▀ "];
// Quarter blocks centre a square point across the two middle rows.
const POINT = ["", "▗▄▖", "▝▀▘", ""];

function mark(c: ReturnType<typeof caps>) {
  return RING.map((row, index) => {
    const ring = (text: string) =>
      paintRgb(mix(PALETTE.edge.rgb, PALETTE.core.rgb, index / 3), text, {}, c);
    if (!POINT[index]) return ring(row);
    return `${ring(row.slice(0, 3))}${paint("focus", POINT[index], {}, c)}${ring(row.slice(6))}`;
  });
}

export function wordmark(c = caps()) {
  return `${paint("text", "Concentrate", { bold: true }, c)} ${paint("focus", "AI", { bold: true }, c)}`;
}

// Header with the mark, name, tagline, and an optional status line. Narrow,
// plain, or non-Unicode terminals get a single line instead.
export function header(version: string, { status = "" } = {}, c = caps()) {
  const g = glyphs(c);
  const width = Math.min(c.width, 72);
  const tag = paint("mute", `v${version}`, {}, c);
  const spread = (left: string) =>
    left +
    " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(tag))) +
    tag;
  if (!c.unicode || !c.color || width < 58) {
    return [
      spread(`  ${paint("focus", g.on, { bold: true }, c)} ${wordmark(c)}`),
      ...(status ? [`  ${status}`] : []),
    ];
  }
  const [first, second, third, fourth] = mark(c);
  return [
    `  ${first}`,
    spread(`  ${second}  ${wordmark(c)}`),
    `  ${third}  ${paint("mute", TAGLINE, {}, c)}`,
    `  ${fourth}  ${status}`,
  ];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The aperture closes in before the header settles. Skipped without a capable TTY.
export async function focusIn(c = caps(), out = process.stdout) {
  if (!c.motion) return;
  const g = glyphs(c);
  for (const frame of g.focusIn) {
    out.write(
      `\r\x1b[2K  ${paint("focus", frame, { bold: true }, c)}  ${paint("mute", NAME, {}, c)}`,
    );
    await sleep(80);
  }
  out.write("\r\x1b[2K");
}
