import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Environment } from "./types.js";
import { CnError } from "./errors.js";
import { parseConfig } from "./config-formats.js";
import { record } from "./validation.js";
import { startCodexRelay } from "./codex-relay.js";
import { version } from "./version.js";

const TIMEOUT_MS = 10000;

// Codex's local control socket speaks the same JSON-RPC protocol as app-server,
// over WebSocket. It is not the raw JSONL transport used by --stdio.
export class CodexRpc {
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private constructor(private socket: WebSocket) {
    socket.on("message", (raw) => {
      let data: Record<string, unknown>;
      try {
        data = record(JSON.parse(raw.toString()));
      } catch {
        this.close();
        return;
      }
      if (typeof data.method === "string") return;
      const pending = this.pending.get(Number(data.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(data.id));
      // Server errors can contain provider configuration. Never echo them.
      if (data.error)
        pending.reject(
          new CnError(
            "Codex's background server rejected the session handoff.",
          ),
        );
      else pending.resolve(data.result);
    });
    socket.on("close", () => this.rejectPending());
    socket.on("error", () => this.rejectPending());
  }
  static async connect(socketPath: string) {
    const socket = new WebSocket("ws://localhost/", {
      createConnection: () => net.createConnection(socketPath),
      handshakeTimeout: TIMEOUT_MS,
      maxPayload: 4 * 1024 * 1024,
    });
    const client = new CodexRpc(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", (cause) =>
          reject(
            Object.assign(
              new CnError(
                "Could not connect to Codex's local background server.",
              ),
              { cause },
            ),
          ),
        );
      });
      await client.request("initialize", {
        clientInfo: { name: "concentrate_cli", version: version() },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: "initialized" }));
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CnError(
            "Codex's background server did not complete the session handoff in time.",
          ),
        );
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) this.rejectPending();
      });
    });
  }
  private rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new CnError(
          "Codex's background server disconnected during the session handoff.",
        ),
      );
    }
    this.pending.clear();
  }
  close() {
    this.rejectPending();
    this.socket.terminate();
  }
}

function merge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const child = record(target[key]);
      merge(child, record(value));
      target[key] = child;
    } else target[key] = value;
  }
}

// Like Codex, take a value that is not valid TOML (`-c model_reasoning_effort=high`)
// as a literal string.
function overrideDocument(override: string) {
  try {
    return parseConfig(override, "toml");
  } catch (error) {
    const split = override.indexOf("=");
    if (split <= 0) throw error;
    const value = override.slice(split + 1).trim();
    return parseConfig(
      `${override.slice(0, split)}=${JSON.stringify(value)}`,
      "toml",
    );
  }
}

export function codexOverrideConfig(overrides: string[]) {
  const config: Record<string, unknown> = {};
  for (const value of overrides) merge(config, overrideDocument(value));
  return config;
}

export interface CodexHandoff {
  remote: string;
  overrides: string[];
  cleanup(): void;
}

export async function prepareCodexHandoff({
  forwarded,
  overrides,
  model,
  key,
  env,
}: {
  forwarded: string[];
  overrides: string[];
  model: string;
  key: string;
  env: Environment;
}): Promise<CodexHandoff | null> {
  // Remote exec is not a supported native CLI mode. Leave scripted invocations
  // and explicitly selected remote servers in their native path.
  if (
    forwarded[0] !== "resume" ||
    forwarded.some((arg) => arg === "--remote" || arg.startsWith("--remote="))
  )
    return null;
  const threadId = forwarded[1];
  if (
    !threadId ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)
  )
    return null;
  const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
  const socketPath = path.join(
    home,
    "app-server-control",
    "app-server-control.sock",
  );
  try {
    const stat = fs.statSync(socketPath);
    if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid()))
      return null;
  } catch {
    return null;
  }
  // Everything up to the first routing change is a read-only check. If the
  // background server cannot answer it (stale socket, older version), Codex's
  // own resume still works, so fall back instead of blocking.
  let client: CodexRpc;
  try {
    client = await CodexRpc.connect(socketPath);
  } catch {
    return null;
  }
  let temporary: string | undefined;
  let credentials: net.Server | undefined;
  let relay: Awaited<ReturnType<typeof startCodexRelay>> | undefined;
  const credentialClients = new Set<net.Socket>();
  let handedOff = false;
  const cleanup = () => {
    relay?.close();
    relay = undefined;
    client.close();
    for (const socket of credentialClients) socket.destroy();
    try {
      credentials?.close();
    } catch {
      /* A failed listen has no open server. */
    }
    credentials = undefined;
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    process.off("exit", cleanup);
  };
  try {
    let status: unknown;
    try {
      let found = false;
      let cursor: unknown;
      for (let page = 0; page < 50 && !found; page += 1) {
        const loaded = record(
          await client.request(
            "thread/loaded/list",
            typeof cursor === "string" ? { cursor } : {},
          ),
        );
        if (!Array.isArray(loaded.data)) return null;
        found = loaded.data.includes(threadId);
        cursor = loaded.nextCursor;
        if (typeof cursor !== "string" || !cursor) break;
      }
      if (!found) return null;
      const read = record(
        await client.request("thread/read", { threadId, includeTurns: false }),
      );
      status = record(record(read.thread).status).type;
    } catch {
      return null;
    }
    if (status !== "idle")
      throw new CnError(
        "The original Codex session is still running or waiting for input. Finish or stop its current task, then retry the same resume command.",
      );

    // Each invocation gets its own provider ID: this forces an idle cached
    // thread to reload settings instead of retaining an old key or endpoint.
    const provider = `cn_${randomUUID().replaceAll("-", "")}`;
    // The daemon cannot inherit the launching shell's environment, and it keeps
    // this thread loaded after cn exits. Serve the key from memory over a private
    // local socket: it never enters a file, command line, or RPC payload, and once
    // cn exits the thread can no longer authenticate, so it cannot go on billing
    // your API key unnoticed.
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cn-key-"));
    fs.chmodSync(temporary, 0o700);
    const credentialSocket = path.join(temporary, "key.sock");
    credentials = net.createServer((socket) => {
      credentialClients.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => credentialClients.delete(socket));
      socket.end(key + "\n");
    });
    await new Promise<void>((resolve, reject) => {
      credentials!.once("error", () =>
        reject(
          new CnError(
            "Could not prepare the private Codex credential connection.",
          ),
        ),
      );
      credentials!.listen(credentialSocket, resolve);
    });
    const helper = path.join(temporary, "credential.mjs");
    fs.writeFileSync(
      helper,
      `import net from "node:net";\nconst socket = net.connect(${JSON.stringify(credentialSocket)});\nsocket.setTimeout(5000, () => { socket.destroy(); process.exitCode = 1; });\nsocket.on("data", (data) => process.stdout.write(data));\nsocket.on("error", () => { process.exitCode = 1; });\n`,
      { mode: 0o600 },
    );
    process.once("exit", cleanup);
    const credentialArgs = [helper];
    const remapped = overrides
      .filter(
        (value) => !/^model_providers\.concentrate\.env_key\s*=/.test(value),
      )
      .map((value) =>
        value.replace(
          /^model_providers\.concentrate\./,
          `model_providers.${provider}.`,
        ),
      )
      .filter((value) => !/^model_provider\s*=/.test(value));
    remapped.push(
      `model_provider=${JSON.stringify(provider)}`,
      `model_providers.${provider}.auth.command=${JSON.stringify(process.execPath)}`,
      `model_providers.${provider}.auth.args=${JSON.stringify(credentialArgs)}`,
      `model_providers.${provider}.auth.refresh_interval_ms=300000`,
    );
    const scopedConfig = codexOverrideConfig(remapped);
    scopedConfig.model = model;
    const resumed = record(
      await client.request("thread/resume", {
        threadId,
        model,
        modelProvider: provider,
        config: scopedConfig,
        excludeTurns: true,
      }),
    );
    if (
      resumed.modelProvider !== provider ||
      resumed.model !== model ||
      record(resumed.thread).id !== threadId
    )
      throw new CnError(
        "Codex kept the original session's model or provider. cn did not send a prompt. Close its original CLI connection and retry; cn will not fall back to your subscription.",
      );
    relay = await startCodexRelay(socketPath, provider, scopedConfig, threadId);
    handedOff = true;
    return { remote: relay.remote, overrides: remapped, cleanup };
  } finally {
    if (!handedOff) cleanup();
  }
}
