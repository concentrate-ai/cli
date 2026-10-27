import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { record } from "./validation.js";

// The native remote TUI drops provider definitions from its config overrides.
// Forward those definitions through the supported per-thread RPC config field,
// without changing the daemon's global configuration or any saved login.
export async function startCodexRelay(
  socketPath: string,
  provider: string,
  config: Record<string, unknown>,
  threadId: string,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cn-link-"));
  fs.chmodSync(directory, 0o700);
  const endpoint = path.join(directory, "cli.sock");
  const server = http.createServer();
  const sockets = new Set<WebSocket>();
  const ws = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 });
  const owned = new Set([threadId]);
  let catalog: Record<string, unknown>[] | undefined;
  if (typeof config.model_catalog_json === "string") {
    try {
      const rows = record(
        JSON.parse(fs.readFileSync(config.model_catalog_json, "utf8")),
      ).models;
      if (Array.isArray(rows))
        catalog = rows
          .map(record)
          .filter((entry) => typeof entry.slug === "string");
    } catch {
      /* Codex validates the catalog separately. */
    }
  }
  ws.on("connection", (front) => {
    sockets.add(front);
    front.pause();
    const back = new WebSocket("ws://localhost/", {
      createConnection: () => net.createConnection(socketPath),
      handshakeTimeout: 10000,
      maxPayload: 64 * 1024 * 1024,
    });
    sockets.add(back);
    const pending = new Map<string, { method: string; threadId?: unknown }>();
    const send = (socket: WebSocket, data: unknown) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(typeof data === "string" ? data : JSON.stringify(data));
    };
    const error = (id: unknown, message: string) =>
      send(front, { id, error: { code: -32600, message } });
    front.on("message", (raw) => {
      let data: Record<string, unknown>;
      try {
        data = record(JSON.parse(raw.toString()));
      } catch {
        front.close(1003);
        return;
      }
      if (typeof data.method === "string") {
        const params = record(data.params);
        if (
          ["turn/start", "thread/compact/start"].includes(data.method) &&
          !owned.has(String(params.threadId))
        ) {
          error(
            data.id,
            "cn has not verified Concentrate routing for this conversation. Resume it through cn before sending a prompt.",
          );
          return;
        }
        if (
          ["thread/resume", "thread/start", "thread/fork"].includes(data.method)
        ) {
          data.params = {
            ...params,
            modelProvider: provider,
            config: { ...record(params.config), ...config },
          };
          if (typeof params.model === "string")
            record(record(data.params).config).model = params.model;
        }
        if (data.id !== undefined)
          pending.set(JSON.stringify(data.id), {
            method: data.method,
            threadId: params.threadId,
          });
      }
      send(back, data);
    });
    back.on("message", (raw) => {
      let data: Record<string, unknown>;
      try {
        data = record(JSON.parse(raw.toString()));
      } catch {
        front.close(1003);
        return;
      }
      if (data.method === undefined && data.id !== undefined) {
        const request = pending.get(JSON.stringify(data.id));
        const method = request?.method;
        pending.delete(JSON.stringify(data.id));
        if (
          method &&
          ["thread/resume", "thread/start", "thread/fork"].includes(method) &&
          data.result
        ) {
          const result = record(data.result);
          if (
            result.modelProvider !== provider ||
            typeof record(result.thread).id !== "string" ||
            (method === "thread/resume" &&
              typeof request?.threadId === "string" &&
              record(result.thread).id !== request.threadId)
          ) {
            error(
              data.id,
              "Codex kept another provider for this conversation. cn blocked the prompt; close the original connection and retry.",
            );
            return;
          }
          owned.add(String(record(result.thread).id));
        }
        if (method === "model/list" && catalog && data.result) {
          const result = record(data.result);
          const template = Array.isArray(result.data)
            ? record(result.data[0])
            : {};
          if (Object.keys(template).length)
            result.data = catalog.map((entry) => ({
              ...template,
              id: entry.slug,
              model: entry.slug,
              displayName: entry.display_name || entry.slug,
              description: entry.description || "Concentrate AI model",
              upgrade: null,
              upgradeInfo: null,
              availabilityNux: null,
              hidden: false,
              modelSpecialty: null,
              supportedReasoningEfforts: entry.supported_reasoning_levels,
              defaultReasoningEffort: entry.default_reasoning_level,
              inputModalities: entry.input_modalities,
              additionalSpeedTiers: [],
              serviceTiers: [],
              defaultServiceTier: null,
              availableAccessPrograms: null,
              isDefault: entry.slug === config.model,
            }));
          result.nextCursor = null;
        }
      }
      send(front, data);
    });
    back.once("open", () => front.resume());
    front.on("error", () => back.terminate());
    back.on("error", () => front.terminate());
    front.on("close", () => {
      sockets.delete(front);
      back.terminate();
    });
    back.on("close", () => {
      sockets.delete(back);
      front.terminate();
    });
  });
  const close = () => {
    for (const socket of sockets) socket.terminate();
    ws.close();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    return { remote: `unix://${endpoint}`, close };
  } catch (error) {
    close();
    throw error;
  }
}
