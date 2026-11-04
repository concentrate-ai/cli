/** The small public mod-host surface used by CN's session-only hook. */
export interface ModContext {
  session: { model: () => Promise<string> };
  env: {
    get: (name: string) => Promise<string | undefined>;
    set: (name: string, value: string | undefined) => Promise<void>;
  };
}
export type ModEvent = Record<string, unknown>;
export interface TurnEvent extends ModEvent {
  model: string;
  effort?: string;
}
export interface HookRegistration {
  catch: (handler: () => Promise<{ drop: string }>) => void;
}
export interface RegisterHook {
  (
    name: "turn.step",
    handler: (
      host: ModContext,
      event: TurnEvent,
      next: (event: TurnEvent) => AsyncIterable<unknown>,
    ) => AsyncIterable<unknown>,
  ): HookRegistration;
  (
    name:
      | "session.start"
      | "classic.PostModelSwitch"
      | "prompt.submit"
      | "command.run",
    handler: (
      host: ModContext,
      event: ModEvent,
      next: (event: ModEvent) => Promise<unknown>,
    ) => Promise<unknown>,
  ): HookRegistration;
}
