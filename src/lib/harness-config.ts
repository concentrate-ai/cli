import type { Effort, Environment } from "./types.js";

export interface ClaudeSettings {
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
  limit?: { context?: number; output?: number };
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
  thinkingLevelMap?: Record<string, string | null>;
}
