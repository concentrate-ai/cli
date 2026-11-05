import http from "node:http";
import { createHash } from "node:crypto";
import { test, expect, vi } from "vitest";

import { runLogin, signIn } from "../../src/lib/cli/login.js";
import { runKey } from "../../src/lib/cli/commands.js";
import { readStoredKey } from "../../src/lib/config/settings.js";
import { json, tempDir } from "../helpers.js";

vi.mock("../../src/lib/cli/commands.js", { spy: true });

const env = { CN_APP_URL: "https://app.test" };
const CONFIG = {
  client_id: "cn-client",
  authorization_endpoint: "https://auth.test/authorize",
  token_endpoint: "https://auth.test/token",
  device_authorization_endpoint: "https://auth.test/device",
};

// Routes the stubbed fetch by URL; token responses are served in order.
function stubAuth({ token = [json({ access_token: "at" })], device } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push({ url: String(url), body: init?.body?.toString() });
    if (String(url) === "https://app.test/api/cli/config") return json(CONFIG);
    if (String(url) === CONFIG.device_authorization_endpoint)
      return json(device);
    return token.shift();
  });
  return calls;
}

// Plays the browser: reads the authorize URL and hits the callback.
const browser = (query) => (url) => {
  const params = new URL(url).searchParams;
  const callback = new URL(params.get("redirect_uri"));
  for (const [k, v] of Object.entries(query(params)))
    callback.searchParams.set(k, v);
  http.get(callback, (res) => res.resume());
};
const silent = () => {};

test("PKCE exchanges the code with the verifier it challenged", async () => {
  const calls = stubAuth();
  let challenge;
  const open = browser((params) => {
    challenge = params.get("code_challenge");
    return { code: "c", state: params.get("state") };
  });

  await expect(signIn(env, { device: false, open })).resolves.toBe("at");

  const sent = new URLSearchParams(calls[1].body);
  expect(calls[1].url).toBe(CONFIG.token_endpoint);
  expect(sent.get("code")).toBe("c");
  expect(
    createHash("sha256").update(sent.get("code_verifier")).digest("base64url"),
  ).toBe(challenge);
});

test.each([
  ["a forged state", () => ({ code: "c", state: "forged" }), "did not match"],
  [
    "a denied consent",
    (params) => ({
      error: "access_denied",
      code: "c",
      state: params.get("state"),
    }),
    "not approved",
  ],
])("PKCE refuses %s", async (_, query, message) => {
  stubAuth();

  await expect(
    signIn(env, { device: false, open: browser(query) }),
  ).rejects.toThrow(message);
});

test("device code polls past authorization_pending", async () => {
  const calls = stubAuth({
    device: {
      device_code: "dc",
      user_code: "ABCD",
      verification_uri: "https://auth.test/device",
      interval: 0,
      expires_in: 60,
    },
    token: [
      json({ error: "authorization_pending" }, 400),
      json({ access_token: "at" }),
    ],
  });

  await expect(signIn(env, { device: true, open: silent })).resolves.toBe("at");
  expect(calls).toHaveLength(4);
});

test("PKCE times out when the browser never comes back", async () => {
  stubAuth();

  await expect(
    signIn(env, { device: false, open: silent, timeoutMs: 50 }),
  ).rejects.toThrow("timed out");
});

test("device code stops when it expires", async () => {
  const calls = stubAuth({
    device: {
      device_code: "dc",
      verification_uri_complete: "https://auth.test/d",
      interval: 0,
      expires_in: 0,
    },
  });

  await expect(signIn(env, { device: true, open: silent })).rejects.toThrow(
    "expired",
  );
  expect(calls).toHaveLength(2);
});

const DEVICE = {
  device_code: "dc",
  verification_uri_complete: "https://auth.test/d",
  interval: 0,
  expires_in: 60,
};

// Signs in by device code, then answers the account and key calls in order.
const stubLogin = (...app) =>
  stubAuth({ device: DEVICE, token: [json({ access_token: "at" }), ...app] });
const loginEnv = () => ({ ...env, CN_CONFIG_HOME: tempDir() });

test("cn login saves the key minted for a single account", async () => {
  const calls = stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ key: "sk-cn-v1-minted" }, 201),
  );
  const home = loginEnv();

  await expect(runLogin({ device: true }, home, silent)).resolves.toBe(0);

  expect(readStoredKey(home)).toBe("sk-cn-v1-minted");
  expect(calls[3]).toMatchObject({
    url: "https://app.test/api/cli/accounts",
  });
  expect(JSON.parse(calls[4].body)).toMatchObject({ organization_id: null });
});

test("cn login falls back to pasting a key where it isn't available", async () => {
  stubLogin(json({ error: "Not found" }, 404));
  vi.mocked(runKey).mockResolvedValueOnce(0);

  await expect(runLogin({ device: true }, loginEnv(), silent)).resolves.toBe(0);

  expect(runKey).toHaveBeenCalledTimes(1);
});

test("cn login explains a role that can't create keys", async () => {
  stubLogin(
    json({ accounts: [{ organization_id: "o1", name: "Acme" }] }),
    json({ error: "Forbidden" }, 403),
  );
  const home = loginEnv();

  await expect(runLogin({ device: true }, home, silent)).rejects.toThrow(
    "can't create API keys in Acme",
  );
  expect(readStoredKey(home)).toBeNull();
});

test("cn login uses a device code over SSH", async () => {
  stubLogin(
    json({ accounts: [{ organization_id: null, name: "Personal" }] }),
    json({ key: "sk-cn-v1-minted" }, 201),
  );
  const open = vi.fn();

  await expect(
    runLogin({ device: false }, { ...loginEnv(), SSH_CONNECTION: "1" }, open),
  ).resolves.toBe(0);
  expect(open).not.toHaveBeenCalled();
});

test.each([
  [
    "several accounts without a terminal to choose in",
    {
      accounts: [
        { organization_id: null, name: "Personal" },
        { organization_id: "o1", name: "Acme" },
      ],
    },
    "interactive terminal",
  ],
  ["no accounts", { accounts: [] }, "no accounts"],
])("cn login stops on %s", async (_, accounts, message) => {
  stubLogin(json(accounts));

  await expect(runLogin({ device: true }, loginEnv(), silent)).rejects.toThrow(
    message,
  );
});

test("cn login passes on an unexpected server error", async () => {
  stubLogin(json({}, 500));

  await expect(runLogin({ device: true }, loginEnv(), silent)).rejects.toThrow(
    "HTTP 500",
  );
});
