import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
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
let cookieName: string;
let jobRunner: any;
let jobBot: any;
let webhookEnqueues: any[];

before(async () => {
  const [{ handleRequest }, { authCookieName, handleTokenBootstrap }, botStore] = await Promise.all([
    import("../src/server"),
    import("../src/auth"),
    import("../src/bot-store"),
  ]);
  cookieName = authCookieName(token);
  webhookEnqueues = [];
  jobRunner = {
    enqueue: (job: any, trigger: string, webhook?: any) => {
      webhookEnqueues.push({ job, trigger, webhook });
      return "queued";
    },
    dropQueued: () => {},
  };
  jobBot = botStore.createBot({
    name: "HTTP job test bot",
    agent: "claude-code",
    repoPath: process.cwd(),
  });
  server = createServer((req, res) => {
    if (handleTokenBootstrap(req as any, res as any, token)) return;
    void handleRequest(req as any, res as any, [], process.cwd(), token, jobRunner);
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
  assert.ok(setCookie.startsWith(`${cookieName}=${token};`));
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

test("gates job APIs and accepts only signed webhook triggers", async () => {
  const unauthorizedJobs = await fetch(`${baseUrl}/jobs`);
  assert.equal(unauthorizedJobs.status, 401);

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const createdWebhook = await fetch(`${baseUrl}/jobs`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "HTTP webhook job",
      botId: jobBot.id,
      prompt: "Handle this GitHub event",
      trigger: { type: "webhook" },
    }),
  });
  assert.equal(createdWebhook.status, 200);
  const webhookJob = (await createdWebhook.json() as any).job;
  assert.match(webhookJob.webhookSecret, /^[0-9a-f]{64}$/);

  const payload = JSON.stringify({ action: "opened" });
  const signature = `sha256=${createHmac("sha256", webhookJob.webhookSecret).update(payload).digest("hex")}`;
  const accepted = await fetch(`${baseUrl}/hooks/jobs/${webhookJob.id}`, {
    method: "POST",
    headers: {
      "X-Hub-Signature-256": signature,
      "X-GitHub-Event": "issues",
    },
    body: payload,
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { status: "queued" });
  assert.equal(webhookEnqueues.at(-1).trigger, "webhook");
  assert.equal(webhookEnqueues.at(-1).webhook.event, "issues");
  assert.equal(webhookEnqueues.at(-1).webhook.rawBody.toString(), payload);

  const rejected = await fetch(`${baseUrl}/hooks/jobs/${webhookJob.id}`, {
    method: "POST",
    headers: { "X-Hub-Signature-256": "sha256=bad" },
    body: payload,
  });
  assert.equal(rejected.status, 401);

  const createdManual = await fetch(`${baseUrl}/jobs`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "HTTP manual job",
      botId: jobBot.id,
      prompt: "Manual run",
    }),
  });
  const manualJob = (await createdManual.json() as any).job;
  const notWebhook = await fetch(`${baseUrl}/hooks/jobs/${manualJob.id}`, { method: "POST", body: payload });
  assert.equal(notWebhook.status, 404);

  const oversized = await fetch(`${baseUrl}/hooks/jobs/${webhookJob.id}`, {
    method: "POST",
    body: "x".repeat(1024 * 1024 + 1),
  });
  assert.equal(oversized.status, 413);

  const [{ createSession }, { finishRun, startRun, waitForRunLog }] = await Promise.all([
    import("../src/server-common"),
    import("../src/run-log"),
  ]);
  const matching = createSession(randomUUID(), "claude-code", process.cwd(), undefined, undefined, undefined, {
    threadId: "job-run-thread",
  });
  matching.job = {
    jobId: webhookJob.id,
    trigger: "manual",
    policy: { approvals: "escalate", approvalTimeoutMinutes: null, isolation: "worktree" },
  };
  matching.runId = startRun(matching);
  await finishRun(matching.runId, "done");
  await waitForRunLog(matching.runId);

  const other = createSession(randomUUID(), "claude-code", process.cwd(), undefined, undefined, undefined, {
    threadId: "other-run-thread",
  });
  other.job = {
    jobId: "different-job",
    trigger: "manual",
    policy: { approvals: "escalate", approvalTimeoutMinutes: null, isolation: "worktree" },
  };
  other.runId = startRun(other);
  await finishRun(other.runId, "done");
  await waitForRunLog(other.runId);

  const filtered = await fetch(`${baseUrl}/runs?jobId=${webhookJob.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(filtered.status, 200);
  const filteredRuns = (await filtered.json() as any).runs;
  assert.deepEqual(filteredRuns.map((run: any) => run.runId), [matching.runId]);
});
