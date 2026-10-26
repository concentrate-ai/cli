import type { Model } from "../types.js";
import { caps, paint } from "./term.js";
import { glyphs } from "./theme.js";

const LOW = Math.log(8_000);
const HIGH = Math.log(2_000_000);
const CELLS = 8;

export function formatTokens(count: number | null) {
  if (count === null || !Number.isFinite(count) || count <= 0) return "";
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
  return `${Math.round(count / 1000)}k`;
}

// Log-scaled so 8k..2M all read distinctly; a half segment gives half-cell precision.
export function contextBar(count: number | null, c = caps()) {
  const g = glyphs(c);
  if (count === null || !Number.isFinite(count) || count <= 0)
    return paint("mute", g.meterTrack.repeat(CELLS), {}, c);
  const fraction = Math.min(
    1,
    Math.max(0, (Math.log(count) - LOW) / (HIGH - LOW)),
  );
  const halves = Math.max(
    1,
    Math.round(fraction * CELLS * (g.meterHalf ? 2 : 1)),
  );
  const whole = g.meterHalf ? Math.floor(halves / 2) : halves;
  const tip = g.meterHalf && halves % 2 ? g.meterHalf : "";
  const used = whole + (tip ? 1 : 0);
  return (
    paint("core", g.meterFull.repeat(whole) + tip, {}, c) +
    paint("mute", g.meterTrack.repeat(CELLS - used), {}, c)
  );
}

function capabilityGlyphs(model: Model, c = caps()) {
  const g = glyphs(c);
  return (
    (model.image ? paint("core", g.vision, {}, c) : " ") +
    (model.reasoning ? paint("core", g.reason, {}, c) : " ")
  );
}

export function modelRight(model: Model, c = caps()) {
  return `${contextBar(model.context, c)} ${formatTokens(model.context).padStart(4)} ${capabilityGlyphs(model, c)}`;
}

export function modelItem(model: Model, c = caps()) {
  return {
    value: model.id,
    label: model.id,
    note: model.name && model.name !== model.id ? model.name : "",
    search: model.name,
    right: modelRight(model, c),
  };
}

export function modelLegend(c = caps()) {
  const g = glyphs(c);
  return [
    `${paint("core", g.vision, {}, c)} ${paint("mute", "vision", {}, c)}`,
    `${paint("core", g.reason, {}, c)} ${paint("mute", "reasoning", {}, c)}`,
    paint("mute", "bar = context window", {}, c),
  ].join("   ");
}
