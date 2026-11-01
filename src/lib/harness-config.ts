import type { Effort, Environment, ModelCost } from "./types.js";

export interface ClaudeSettings {
  hooks?: {
    SessionEnd: { hooks: { type: "command"; command: string }[] }[];
  };
  enabledPlugins?: Record<string, boolean>;
  apiKeyHelper: string;
  env: Environment;
  modelPicker: {
    replaceBuiltInOptions: boolean;
    options: { model: string; label: string; description: string }[];
  };
}
export interface OpenCodeModel {
  name: string;
  package?: string;
  settings?: { baseURL: string };
  limit?: { context?: number; output?: number };
  cost?:
    | { input: number; output: number; cache: { read: number; write: number } }
    | {
        input: number;
        output: number;
        cache_read: number;
        cache_write: number;
      };
  capabilities?: {
    tools?: boolean;
    input: string[];
    output: string[];
    reasoning?: { supported: boolean; effort?: Effort[]; toggle?: boolean };
  };
  modalities?: { input: string[]; output: string[] };
  toolcall?: boolean;
  reasoning?: boolean;
  variants?:
    | Record<string, { reasoningEffort: Effort }>
    | { id: Effort; body: { reasoning_effort: Effort } }[];
}
export interface PiModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  input: string[];
  reasoning: boolean;
  cost?: ModelCost;
  thinkingLevelMap?: Record<string, string | null>;
}
