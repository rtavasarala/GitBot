import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "gitbot-auth-test-"));
process.env.GITBOT_DATA_DIR = dataDir;
delete process.env.GITBOT_TOKEN;

test("creates a private token file and reuses it", async () => {
  const { loadOrCreateToken } = await import("../src/auth");
  const token = loadOrCreateToken();
  const tokenPath = join(dataDir, "token");
  assert.equal(readFileSync(tokenPath, "utf-8"), token);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  assert.equal(loadOrCreateToken(), token);
});

test("repairs permissions on an existing token file", async () => {
  const { loadOrCreateToken } = await import("../src/auth");
  const tokenPath = join(dataDir, "token");
  const token = loadOrCreateToken();
  chmodSync(tokenPath, 0o644);

  assert.equal(loadOrCreateToken(), token);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
});

test("environment token overrides the stored token", async () => {
  const { loadOrCreateToken } = await import("../src/auth");
  const storedToken = readFileSync(join(dataDir, "token"), "utf-8");
  process.env.GITBOT_TOKEN = "  override-token  ";
  assert.equal(loadOrCreateToken(), "override-token");
  process.env.GITBOT_TOKEN = "  \t ";
  assert.equal(loadOrCreateToken(), storedToken);
  delete process.env.GITBOT_TOKEN;
});

test("regenerates an empty token file with private permissions", async () => {
  const { loadOrCreateToken } = await import("../src/auth");
  const tokenPath = join(dataDir, "token");
  writeFileSync(tokenPath, " \n\t");
  const token = loadOrCreateToken();
  assert.notEqual(token, "");
  assert.equal(readFileSync(tokenPath, "utf-8"), token);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
});

test("authorizes bearer and cookie credentials using timing-safe comparisons", async () => {
  const { authCookieName, isAuthorized } = await import("../src/auth");
  const token = "sample-token";
  const req = (headers: Record<string, string>) => ({ headers }) as any;

  assert.equal(isAuthorized(req({ authorization: `Bearer ${token}` }), token), true);
  assert.equal(isAuthorized(req({ cookie: `theme=dark; ${authCookieName(token)}=${token}; other=value` }), token), true);
  assert.equal(isAuthorized(req({}), token), false);
  assert.equal(isAuthorized(req({ authorization: "Bearer wrong-token" }), token), false);
  assert.equal(isAuthorized(req({ authorization: "Bearer short" }), token), false);
  assert.equal(isAuthorized(req({ cookie: "gitbot_token=" }), ""), false);
});

test("isolates cookies between tokens while accepting both cookies", async () => {
  const { authCookieName, isAuthorized } = await import("../src/auth");
  const tokenA = "node-a-token";
  const tokenB = "node-b-token";
  const cookieA = `${authCookieName(tokenA)}=${tokenA}`;
  const cookieB = `${authCookieName(tokenB)}=${tokenB}`;
  const req = (cookie: string) => ({ headers: { cookie } }) as any;

  assert.equal(isAuthorized(req(cookieA), tokenB), false);
  assert.equal(isAuthorized(req(`${cookieA}; ${cookieB}`), tokenA), true);
  assert.equal(isAuthorized(req(`${cookieA}; ${cookieB}`), tokenB), true);
});
