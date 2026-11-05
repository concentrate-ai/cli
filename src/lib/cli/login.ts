import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { requestJson } from "../catalog.js";
import { CnError } from "../errors.js";
import { cleanText } from "../safe.js";
import type { Environment } from "../types.js";
import { record } from "../validation.js";

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
  const tokenUrl = text(config.token_endpoint, "sign-in address");
  return device
    ? deviceCode(
        text(config.device_authorization_endpoint, "sign-in address"),
        tokenUrl,
        clientId,
      )
    : browserCode(
        text(config.authorization_endpoint, "sign-in address"),
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
