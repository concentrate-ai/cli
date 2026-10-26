import type { Effort, Model } from "./types.js";

/** Canonical gateway effort order shared by decoding and all harness writers. */
export const EFFORTS: readonly Effort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Unknown controls must remain distinct from explicitly unsupported controls. */
export function modelEfforts(model: Model): Effort[] | null {
  if (model.reasoningSupport === false) return [];
  const efforts = model.efforts;
  return efforts ? EFFORTS.filter((level) => efforts.includes(level)) : null;
}

/** Prefer moderate reasoning without inventing an unsupported level. */
export function defaultModelEffort(model: Model): Effort {
  const efforts = modelEfforts(model) ?? [];
  return efforts.includes("medium")
    ? "medium"
    : efforts.includes("low")
      ? "low"
      : (efforts[0] ?? "none");
}
