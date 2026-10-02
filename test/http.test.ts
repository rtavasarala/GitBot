import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "gitbot-http-test-"));
process.env.GITBOT_DATA_DIR = dataDir;

const token = "http-test-token";
let server: ReturnType<typeof createServer> | undefined;
let baseUrl: string;

before(async () => {
  const [{ handleRequest }, { handleTokenBootstrap }] = await Promise.all([
    import("../src/server"),
    import("../src/auth"),
  ]);
  server = createServer((req, res) => {
    if (handleTokenBootstrap(req as any, res as any, token)) return;
    void handleRequest(req as any, res as any, [], process.cwd(), token);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
});

test("gates API routes, bootstraps a cookie, and removes wildcard CORS", async () => {
  const denied = await fetch(`${baseUrl}/bots`);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "Unauthorized", authRequired: true });

  const authorized = await fetch(`${baseUrl}/bots`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(authorized.status, 200);

  const bootstrap = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: "manual" });
  assert.equal(bootstrap.status, 302);
  assert.equal(bootstrap.headers.get("location"), "/");
  const setCookie = bootstrap.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0];

  const cookieAuthorized = await fetch(`${baseUrl}/bots`, {
    headers: { Cookie: `theme=dark; ${cookie}; other=value` },
  });
  assert.equal(cookieAuthorized.status, 200);

  const invalidBootstrap = await fetch(`${baseUrl}/?token=bad`, { redirect: "manual" });
  assert.equal(invalidBootstrap.status, 401);
  assert.equal(await invalidBootstrap.text(), "Invalid GitBot token");

  const preflight = await fetch(`${baseUrl}/chat`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);

  const runsResponse = await fetch(`${baseUrl}/runs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(runsResponse.status, 200);
  assert.deepEqual(await runsResponse.json(), { runs: [] });

  const missingRun = await fetch(`${baseUrl}/runs/00000000-0000-4000-8000-000000000000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(missingRun.status, 404);
});
