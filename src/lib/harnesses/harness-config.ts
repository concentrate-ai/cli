import type { Effort, Environment, ModelCost } from "../types.js";

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
  tool_call?: boolean;
  release_date?: string;
  releaseDate?: string;
  reasoning?: boolean;
  variants?:
    | Record<string, Record<string, unknown>>
    | { id: Effort; body: Record<string, unknown> }[];
  // OpenCode 2: a different provider package for this model.
  package?: string;
  settings?: { baseURL: string };
  // OpenCode 1.x: the same, in its own shape.
  provider?: { npm: string };
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
  api?: string;
  baseUrl?: string;
  compat?: { forceAdaptiveThinking?: boolean };
}
