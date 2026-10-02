import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
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

test("environment token overrides the stored token", async () => {
  const { loadOrCreateToken } = await import("../src/auth");
  process.env.GITBOT_TOKEN = "  override-token  ";
  assert.equal(loadOrCreateToken(), "  override-token  ");
  delete process.env.GITBOT_TOKEN;
});

test("authorizes bearer and cookie credentials using timing-safe comparisons", async () => {
  const { isAuthorized } = await import("../src/auth");
  const token = "sample-token";
  const req = (headers: Record<string, string>) => ({ headers }) as any;

  assert.equal(isAuthorized(req({ authorization: `Bearer ${token}` }), token), true);
  assert.equal(isAuthorized(req({ cookie: `theme=dark; gitbot_token=${token}; other=value` }), token), true);
  assert.equal(isAuthorized(req({}), token), false);
  assert.equal(isAuthorized(req({ authorization: "Bearer wrong-token" }), token), false);
  assert.equal(isAuthorized(req({ authorization: "Bearer short" }), token), false);
});
