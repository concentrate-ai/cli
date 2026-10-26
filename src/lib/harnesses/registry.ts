import type { Harness, HarnessId } from "../types.js";
import { CnError } from "../errors.js";
import claude from "./claude.js";
import codex from "./codex.js";
import opencode from "./opencode.js";
import pi from "./pi.js";

const REGISTRY = new Map<HarnessId, Harness>(
  [claude, codex, opencode, pi].map((adapter) => [adapter.id, adapter]),
);

export function isHarness(id: string): id is HarnessId {
  return REGISTRY.has(id as HarnessId);
}

export function getHarness(id: HarnessId): Harness {
  const adapter = REGISTRY.get(id);
  if (!adapter) throw new CnError(`Unknown tool: ${id}`, 2);
  return adapter;
}

export function listHarnesses() {
  return [...REGISTRY.values()];
}
