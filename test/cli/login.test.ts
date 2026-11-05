import http from "node:http";
import { createHash } from "node:crypto";
import { test, expect, vi } from "vitest";

import { signIn } from "../../src/lib/cli/login.js";
import { json } from "../helpers.js";

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
