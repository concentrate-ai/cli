import type { ModContext, RegisterHook } from "./mod-types.js";
import { limits, capabilities, preferences } from "./limits.mjs";

// Runs inside Claude Code's mod host, using its public API (no Node globals).
export function contextLimit(
  model: string,
  table: Record<string, number> = limits,
) {
  // Claude knows its own model windows, including provider-prefixed Claude IDs.
  if (/claude-|\[1m\]/i.test(model)) return undefined;
  const value = table[model] ?? table[model.split("/").pop() ?? model];
  return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
}

const nativeModel = (model: string) => /claude-|\[1m\]/i.test(model);
const details = (model: string) =>
  nativeModel(model)
    ? undefined
    : (capabilities[model] ?? capabilities[model.split("/").pop() ?? model]);

// Keep Claude's 32K default unless a smaller model cap (or user preference)
// requires less. Setting every model to its maximum would shrink usable context.
export function outputLimit(
  cap: number | null | undefined,
  preference: string | null | undefined,
) {
  const requested =
    preference == null ? 32000 : Number(String(preference).replaceAll("_", ""));
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0)
    return preference ?? undefined;
  return String(
    Math.min(
      Number.isSafeInteger(requested) && requested > 0 ? requested : 32000,
      cap,
    ),
  );
}

export function supportedEffort(
  requested: string | undefined,
  levels: readonly string[] | null | undefined,
) {
  if (!Array.isArray(levels)) return requested;
  const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const choices = order.filter(
    (level) => levels.includes(level) && level !== "minimal",
  );
  // Claude has no minimal/none choice on this API. Do not invent a mapping.
  if (!choices.length || choices.includes(requested ?? "")) return requested;
  const rank = order.indexOf(requested ?? "medium");
  return (
    choices.filter((level) => order.indexOf(level) <= rank).at(-1) ?? choices[0]
  );
}

async function syncContext($: ModContext) {
  const model = await $.session.model();
  const cap = details(model);
  const value = contextLimit(model);
  if (
    !preferences.fixedContext &&
    (await $.env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS")) !== value
  ) {
    await $.env.set("CLAUDE_CODE_MAX_CONTEXT_TOKENS", value);
  }
  const output = outputLimit(cap?.output, preferences.output);
  if ((await $.env.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS")) !== output) {
    await $.env.set("CLAUDE_CODE_MAX_OUTPUT_TOKENS", output);
  }
  const thinking =
    preferences.disableThinking ?? (cap?.reasoning === false ? "1" : undefined);
  if ((await $.env.get("CLAUDE_CODE_DISABLE_THINKING")) !== thinking) {
    await $.env.set("CLAUDE_CODE_DISABLE_THINKING", thinking);
  }
}

export function register(on: RegisterHook) {
  // Effort is rewritten at the request boundary for the actual request model.
  // Returning to a native Claude ID leaves its own capability handling intact.
  on("turn.step", async function* ($, e, next) {
    const effort = supportedEffort(e.effort, details(e.model)?.efforts);
    yield* next(effort === e.effort ? e : { ...e, effort });
  });
  on("session.start", async ($, e, next) => {
    if (preferences.dynamic) {
      preferences.fixedContext = Boolean(
        await $.env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"),
      );
      preferences.output = await $.env.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS");
      preferences.disableThinking = await $.env.get(
        "CLAUDE_CODE_DISABLE_THINKING",
      );
    }
    await syncContext($);
    return next(e);
  });
  // Read the actual model, rather than the requested one: a switch may be denied
  // or superseded. Also covers resume, automatic fallback, and the SDK.
  on("classic.PostModelSwitch", async ($, e, next) => {
    await syncContext($);
    return next(e);
  });
  // PostModelSwitch can run asynchronously. This awaited gate guarantees that
  // the next user prompt sees the selected model's limit before it starts.
  on("prompt.submit", async ($, e, next) => {
    await syncContext($);
    return next(e);
  }).catch(async () => ({
    drop: "cn could not update the selected model's capabilities. Restart through cn before continuing.",
  }));
  // Commands such as /context and /compact must see the current limit too.
  on("command.run", async ($, e, next) => {
    await syncContext($);
    try {
      return await next(e);
    } finally {
      await syncContext($);
    }
  });
}
