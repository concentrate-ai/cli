import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { HttpError, requestJson } from "../catalog.js";
import { writeKey } from "../config/settings.js";
import { CnError } from "../errors.js";
import { refreshConfiguredKey } from "../harnesses/tool-config.js";
import { cleanText } from "../safe.js";
import type { Environment } from "../types.js";
import { ledger } from "../ui/layout.js";
import { interactive, select } from "../ui/widgets.js";
import { errorMessage, isRecord, record } from "../validation.js";
import { runKey } from "./commands.js";

const TRY_KEY = "Run cn key to paste a key instead.";

const appRoot = (env: Environment) =>
  (env.CN_APP_URL ?? "https://concentrate.ai").replace(/\/$/, "");

// Server-sent text shown to the user or used in a URL, cleaned and required
const text = (value: unknown, what: string) => {
  if (typeof value !== "string" || !value)
    throw new CnError(`Sign-in returned no ${what}. ${TRY_KEY}`);
  return cleanText(value, 2048);
};

// OAuth endpoints take form bodies and report errors in a JSON body, even on 400.
async function postForm(url: string, params: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  return record(await response.json().catch(() => null));
}

// Endpoints from the server must be https; plain http only for a local server
function endpoint(value: unknown, what: string) {
  const url = new URL(text(value, what));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new CnError(`Sign-in ${what} must use https. ${TRY_KEY}`);
  return url.href;
}

function accessToken(body: Record<string, unknown>) {
  if (body.error)
    throw new CnError(`Sign-in failed (${cleanText(body.error)}). ${TRY_KEY}`);
  return text(body.access_token, "access token");
}

/** Signs in to Concentrate AI in the browser or with a device code; returns the access token. */
export async function signIn(
  env: Environment,
  {
    device,
    open,
    timeoutMs = 300_000,
  }: { device: boolean; open: (url: string) => void; timeoutMs?: number },
): Promise<string> {
  const config = await requestJson(`${appRoot(env)}/api/cli/config`);
  const clientId = text(config.client_id, "client id");
  const tokenUrl = endpoint(config.token_endpoint, "address");
  return device
    ? deviceCode(
        endpoint(config.device_authorization_endpoint, "address"),
        tokenUrl,
        clientId,
      )
    : browserCode(
        endpoint(config.authorization_endpoint, "address"),
        tokenUrl,
        clientId,
        open,
        timeoutMs,
      );
}

async function browserCode(
  authorizeUrl: string,
  tokenUrl: string,
  clientId: string,
  open: (url: string) => void,
  timeoutMs: number,
) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  let server!: http.Server;
  let timer!: NodeJS.Timeout;
  const code = new Promise<string>((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/callback"))
        return void res.writeHead(404).end();
      const query = new URL(req.url, "http://127.0.0.1").searchParams;
      res.end("Signed in to cn. You can close this tab.");
      if (query.get("error"))
        reject(new CnError(`Sign-in was not approved. ${TRY_KEY}`));
      else if (query.get("state") !== state || !query.get("code"))
        reject(new CnError(`Sign-in response did not match. ${TRY_KEY}`));
      else resolve(query.get("code")!);
    });
    timer = setTimeout(
      () => reject(new CnError(`Sign-in timed out. ${TRY_KEY}`)),
      timeoutMs,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const url = `${authorizeUrl}?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "openid",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    })}`;
    console.log(
      `Opening your browser to sign in. If it doesn't open, visit:\n  ${url}`,
    );
    open(url);
    return accessToken(
      await postForm(tokenUrl, {
        grant_type: "authorization_code",
        code: await code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }),
    );
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

async function deviceCode(
  deviceUrl: string,
  tokenUrl: string,
  clientId: string,
) {
  const start = await postForm(deviceUrl, { client_id: clientId });
  const deviceCode = text(start.device_code, "device code");
  console.log(
    typeof start.verification_uri_complete === "string"
      ? `To sign in, visit:\n  ${text(start.verification_uri_complete, "sign-in address")}`
      : `To sign in, visit ${text(start.verification_uri, "sign-in address")} and enter ${text(start.user_code, "code")}`,
  );
  let interval = typeof start.interval === "number" ? start.interval : 5;
  const deadline =
    Date.now() +
    (typeof start.expires_in === "number" ? start.expires_in : 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const body = await postForm(tokenUrl, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: clientId,
    });
    if (body.error === "slow_down") interval += 5;
    else if (body.error !== "authorization_pending") return accessToken(body);
  }
  throw new CnError(`The sign-in code expired. ${TRY_KEY}`);
}

// Best effort: the sign-in URL is always printed too.
function openBrowser(url: string) {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler"]
        : ["xdg-open"];
  spawn(command, [...args, url], { detached: true, stdio: "ignore" })
    .on("error", () => {})
    .unref();
}

async function chooseAccount(
  accounts: { organization_id: string | null; name: string }[],
  env: Environment,
) {
  if (accounts.length === 1) return accounts[0];
  if (!interactive(env))
    throw new CnError(
      `Choosing an account needs an interactive terminal. ${TRY_KEY}`,
    );
  const choice = await select(
    {
      title: "Create an API key in",
      // Start on the first organization; Personal is the fallback, not the default
      initial: String(accounts.findIndex((a) => a.organization_id !== null)),
      items: accounts.map((account, index) => ({
        value: String(index),
        label: account.name,
      })),
    },
    env,
  );
  if (choice.cancel) throw new CnError("Cancelled", 130);
  return accounts[Number(choice.value)];
}

/** cn login: sign in, pick an account, and save a new API key for it. */
export function runLogin(
  options: { device: boolean },
  env: Environment = process.env,
  open = openBrowser,
) {
  return login(options, env, open).catch((error) => {
    if (error instanceof CnError) throw error;
    throw new CnError(`Sign-in failed (${errorMessage(error)}). ${TRY_KEY}`);
  });
}

async function login(
  { device }: { device: boolean },
  env: Environment,
  open: (url: string) => void,
) {
  const token = await signIn(env, {
    device: Boolean(device || env.SSH_CONNECTION || env.SSH_TTY),
    open,
  });
  const headers = { Authorization: `Bearer ${token}` };
  const listed = await requestJson(`${appRoot(env)}/api/cli/accounts`, {
    headers,
  }).catch((error) => {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  });
  if (!listed) {
    console.log(
      ledger(
        "warn",
        "login",
        "browser sign-in isn't available, paste a key instead",
      ),
    );
    return runKey({}, env);
  }
  const accounts = (Array.isArray(listed.accounts) ? listed.accounts : [])
    .filter(isRecord)
    .map((account) => ({
      organization_id:
        typeof account.organization_id === "string"
          ? account.organization_id
          : null,
      name: cleanText(account.name, 80),
    }));
  if (accounts.length === 0)
    throw new CnError(`Sign-in returned no accounts. ${TRY_KEY}`);
  const account = await chooseAccount(accounts, env);

  const minted = await requestJson(`${appRoot(env)}/api/cli/keys`, {
    headers,
    body: {
      organization_id: account.organization_id,
      name: `cn on ${os.hostname()}`.slice(0, 64),
    },
  }).catch((error) => {
    throw error instanceof HttpError && error.status === 403
      ? new CnError(
          `Your role can't create API keys in ${account.name}. Ask an owner of that organization.`,
        )
      : error;
  });
  writeKey(minted.key, env);
  refreshConfiguredKey(env);
  console.log(ledger("ok", "login", `key saved for ${account.name}`));
  return 0;
}
