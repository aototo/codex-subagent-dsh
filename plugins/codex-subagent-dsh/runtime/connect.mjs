import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/connect.ts
import { stdin, stderr, stdout } from "node:process";

// src/auth.ts
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

// src/config.ts
import { homedir } from "node:os";
import { resolve } from "node:path";
var DEFAULT_ORIGIN = "http://127.0.0.1:3080";
var DEFAULT_STATE_DIR = resolve(homedir(), ".codex-subagent-dsh");
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function normalizeLoopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DSH_SUBAGENT_URL must be a valid loopback HTTP URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" || !isLoopbackHostname(url.hostname) || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("DSH_SUBAGENT_URL must be a loopback HTTP origin without credentials, path, query, or fragment");
  }
  return url.origin;
}
function loadConfig(env = process.env) {
  const configuredHome = env.DSH_SUBAGENT_HOME?.trim();
  return {
    origin: normalizeLoopbackOrigin(env.DSH_SUBAGENT_URL?.trim() || DEFAULT_ORIGIN),
    stateDir: resolve(configuredHome || DEFAULT_STATE_DIR),
    rpcTimeoutMs: 1e4,
    taskTimeoutMs: 15 * 6e4,
    maxWaitMs: 2e4
  };
}

// src/auth.ts
var CREDENTIAL_VERSION = 1;
var CREDENTIAL_DIRECTORY = "credentials";
var MAX_CREDENTIAL_BYTES = 64 * 1024;
var DshAuthError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "DshAuthError";
    this.code = code;
  }
};
function credentialPath(config) {
  const digest = createHash("sha256").update(checkedOrigin(config)).digest("hex");
  return join(config.stateDir, CREDENTIAL_DIRECTORY, `${digest}.json`);
}
function checkedOrigin(config) {
  try {
    const origin = normalizeLoopbackOrigin(config.origin);
    if (origin !== config.origin) throw new Error("non-canonical origin");
    return origin;
  } catch {
    throw new DshAuthError("ORIGIN_INVALID", "The configured DSH origin must be a canonical loopback HTTP origin");
  }
}
async function ensurePrivateDirectories(config) {
  await mkdir(config.stateDir, { recursive: true, mode: 448 });
  const stateInfo = await lstat(config.stateDir);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
    throw new DshAuthError("CREDENTIAL_DIRECTORY_INVALID", "The DSH credential directory is not a private local directory");
  }
  await chmod(config.stateDir, 448);
  const directory = join(config.stateDir, CREDENTIAL_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 448 });
  const credentialInfo = await lstat(directory);
  if (!credentialInfo.isDirectory() || credentialInfo.isSymbolicLink()) {
    throw new DshAuthError("CREDENTIAL_DIRECTORY_INVALID", "The DSH credential directory is not a private local directory");
  }
  await chmod(directory, 448);
  return directory;
}
function isSafeCookieHeader(value) {
  if (value.length === 0 || value.length > 16384 || /[\r\n]/.test(value)) return false;
  return value.split("; ").every((pair) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21-\x3A\x3C-\x7E]+$/.test(pair));
}
function cookiesFromResponse(headers) {
  const values = headers.getSetCookie();
  const pairs = [];
  for (const value of values) {
    const pair = value.slice(0, value.indexOf(";") === -1 ? value.length : value.indexOf(";")).trim();
    if (!isSafeCookieHeader(pair)) {
      throw new DshAuthError("AUTH_RESPONSE_INVALID", "DSH returned an invalid authentication response");
    }
    pairs.push(pair);
  }
  if (pairs.length === 0) {
    throw new DshAuthError("AUTH_RESPONSE_INVALID", "DSH did not return an authentication cookie");
  }
  const cookie = pairs.join("; ");
  if (!isSafeCookieHeader(cookie)) {
    throw new DshAuthError("AUTH_RESPONSE_INVALID", "DSH returned an invalid authentication response");
  }
  return cookie;
}
async function saveCredential(config, credential) {
  const directory = await ensurePrivateDirectories(config);
  const target = credentialPath(config);
  const temporary = join(directory, `.credential-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384);
    await handle.writeFile(`${JSON.stringify(credential)}
`, "utf8");
    await handle.sync();
    await handle.close();
    handle = void 0;
    await rename(temporary, target);
    await chmod(target, 384);
  } finally {
    await handle?.close().catch(() => void 0);
    await rm(temporary, { force: true }).catch(() => void 0);
  }
}
function validatedLoginUrl(loginUrl, config) {
  const origin = checkedOrigin(config);
  if (loginUrl.length > 16384) {
    throw new DshAuthError("LOGIN_URL_INVALID", "The DSH login URL is invalid");
  }
  let url;
  try {
    url = new URL(loginUrl.trim());
  } catch {
    throw new DshAuthError("LOGIN_URL_INVALID", "The DSH login URL is invalid");
  }
  const tokens = url.searchParams.getAll("token");
  if (url.origin !== origin || url.pathname !== "/" || url.username !== "" || url.password !== "" || url.hash !== "" || tokens.length !== 1 || tokens[0] === "" || [...url.searchParams.keys()].some((key) => key !== "token")) {
    throw new DshAuthError("LOGIN_URL_INVALID", "The DSH login URL must be the exact loopback launch URL for the configured server");
  }
  return url;
}
async function connect(loginUrl, config) {
  const url = validatedLoginUrl(loginUrl, config);
  const origin = checkedOrigin(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.rpcTimeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "cache-control": "no-store" }
    });
    if (response.status === 401 || response.status === 403) {
      throw new DshAuthError("AUTH_REJECTED", "DSH rejected the login URL; use the current URL printed by dsh web");
    }
    if (response.status !== 303) {
      throw new DshAuthError("AUTH_RESPONSE_INVALID", "DSH returned an unexpected authentication response");
    }
    const location = response.headers.get("location");
    if (location === null) {
      throw new DshAuthError("AUTH_RESPONSE_INVALID", "DSH returned an invalid authentication redirect");
    }
    const redirect = new URL(location, origin);
    if (redirect.origin !== origin || redirect.username !== "" || redirect.password !== "") {
      throw new DshAuthError("AUTH_REDIRECT_BLOCKED", "DSH attempted to redirect authentication outside the configured origin");
    }
    const credential = {
      version: CREDENTIAL_VERSION,
      origin,
      cookie: cookiesFromResponse(response.headers),
      connectedAt: Date.now()
    };
    await saveCredential(config, credential);
    return credential;
  } catch (error) {
    if (error instanceof DshAuthError) throw error;
    if (controller.signal.aborted) {
      throw new DshAuthError("AUTH_TIMEOUT", "Timed out while connecting to DSH");
    }
    throw new DshAuthError("AUTH_UNAVAILABLE", "Unable to connect to DSH");
  } finally {
    clearTimeout(timeout);
    url.search = "";
  }
}

// src/connect.ts
async function readLoginUrl() {
  const maxInputLength = 16384;
  if (!stdin.isTTY) {
    let input = "";
    stdin.setEncoding("utf8");
    for await (const chunk of stdin) {
      input += chunk;
      if (input.length > maxInputLength) throw new Error("DSH login URL input is too long");
    }
    const firstLine = input.split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) throw new Error("No DSH login URL was provided on stdin");
    return firstLine;
  }
  if (!stdin.setRawMode) throw new Error("Secure terminal input is unavailable; pipe the login URL through stdin");
  stderr.write("Paste the current DSH login URL (input hidden): ");
  stdin.setEncoding("utf8");
  stdin.resume();
  stdin.setRawMode(true);
  return await new Promise((resolve2, reject) => {
    let value = "";
    const restore = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      process.off("SIGHUP", onSignal);
      process.off("SIGTERM", onSignal);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    const finish = (error) => {
      restore();
      stderr.write("\n");
      if (error) reject(error);
      else resolve2(value.trim());
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "") return finish(new Error("Connection cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\x7F" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") {
          value += character;
          if (value.length > maxInputLength) return finish(new Error("DSH login URL input is too long"));
        }
      }
    };
    const onEnd = () => finish(new Error("Terminal input ended before a DSH login URL was provided"));
    const onError = () => finish(new Error("Unable to read the DSH login URL"));
    const onSignal = () => finish(new Error("Connection cancelled"));
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    process.once("SIGHUP", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
async function main() {
  if (process.argv.length > 2) {
    throw new Error("Do not pass the DSH login URL as a command-line argument; use hidden input or stdin");
  }
  const config = loadConfig();
  const loginUrl = await readLoginUrl();
  if (loginUrl === "") throw new Error("No DSH login URL was provided");
  await connect(loginUrl, config);
  stdout.write(`Connected to DSH at ${config.origin}
`);
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unable to connect to DSH";
  stderr.write(`${message}
`);
  process.exitCode = 1;
});
