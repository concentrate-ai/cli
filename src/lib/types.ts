/** Shared contracts between the catalog, commands, and harness adapters. */
export type Environment = NodeJS.ProcessEnv;
export type HarnessId = "claude" | "codex" | "opencode" | "pi";
export type ConfigurableToolId = HarnessId | "cursor";
export type Preferences = Record<HarnessId, string>;
export type Effort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface Model {
  id: string;
  name: string;
  context: number | null;
  output: number | null;
  claude: boolean;
  codex: boolean;
  chat_candidate: boolean;
  image: boolean;
  reasoning: boolean;
  reasoningSupport: boolean | null;
  efforts: Effort[] | null;
  variants?: Model[];
}
export interface PrepareOptions {
  executable: string;
  model: string;
  key: string;
  available: Model[];
  forwarded: string[];
  env: Environment;
}
export interface PreparedHarness {
  args: string[];
  env: Environment;
  unset?: readonly string[];
  recall?: () => string | null;
  cleanup: () => void;
}
export interface Harness {
  id: HarnessId;
  label: string;
  binary: string;
  installHint: string;
  modelFlags?: readonly string[];
  version?: (executable: string) => string | null;
  prepare: (options: PrepareOptions) => Promise<PreparedHarness>;
}
export interface LaunchOptions {
  model?: string;
  forwarded?: string[];
  tty?: boolean;
}
export interface TerminalCapabilities {
  tty: boolean;
  color: number;
  unicode: boolean;
  width: number;
  motion: boolean;
}
export type ColorRole =
  "edge" | "core" | "focus" | "ok" | "bad" | "mute" | "text" | "soft";
export type Tone = "ok" | "warn" | "bad" | "mute" | "info";
export interface MenuItem {
  group?: string;
  value?: string;
  label?: string;
  note?: string;
  search?: string;
  tone?: ColorRole;
  meta?: string;
  right?: string;
  about?: string;
  ready?: boolean;
}
export type Selection =
  | { value: string; cancel?: false; interrupted?: false }
  | { cancel: true; interrupted?: boolean; value?: undefined };
export interface SelectOptions {
  items: MenuItem[];
  initial?: string;
  filterable?: boolean;
  allowCustom?: boolean;
  rows?: number;
  title?: string;
  detail?: (item: MenuItem) => string[];
  legend?: string;
  hints?: string[][];
}
export interface SelectState {
  items: MenuItem[];
  query: string;
  cursor: number;
  filterable: boolean;
  allowCustom: boolean;
  rows: number;
  done?: Selection;
}
export type Key =
  | { name: "char"; char: string }
  | {
      name:
        | "up"
        | "down"
        | "home"
        | "end"
        | "escape"
        | "enter"
        | "backspace"
        | "clear"
        | "interrupt"
        | "eof";
    };
export interface ModelCapability {
  output: number | null;
  reasoning: boolean | null;
  efforts: Effort[] | null;
}
export interface CapabilityPreferences {
  dynamic?: boolean;
  fixedContext?: boolean;
  output?: string | null;
  disableThinking?: string | null;
}
