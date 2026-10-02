import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "gitbot-jobs-test-"));
process.env.GITBOT_DATA_DIR = dataDir;

let botStore: any;
let jobStore: any;
let jobModule: any;
let common: any;
let runLog: any;

before(async () => {
  [botStore, jobStore, jobModule, common, runLog] = await Promise.all([
    import("../src/bot-store"),
    import("../src/job-store"),
    import("../src/jobs"),
    import("../src/server-common"),
    import("../src/run-log"),
  ]);
});

function makeBot(repoPath = process.cwd()) {
  return botStore.createBot({
    name: `Job test bot ${randomUUID()}`,
    agent: "claude-code",
    permissionMode: "auto-approve",
    repoPath,
  });
}

function makeJob(
  botId: string,
  name: string,
  policy: Record<string, unknown> = {},
  repoPath?: string,
) {
  const validation = jobStore.validateJobInput({
    name,
    botId,
    prompt: "Run a test task",
    trigger: { type: "manual" },
    ...(repoPath ? { repoPath } : {}),
    policy: { isolation: "in-place", ...policy },
  });
  assert.ok(validation.ok);
  return jobStore.saveJob(validation.job);
}

function fakeStore(input: any) {
  return {
    gitbotId: randomUUID(),
    sdkSessionId: null,
    agent: "claude-code",
    repoPath: process.cwd(),
    permissionMode: input.permissionMode ?? "ask-permissions",
    seq: 0,
    events: [],
    status: "running",
    emitter: new EventEmitter(),
    abortController: null,
    pendingPermissions: new Map(),
    cleanupTimer: null,
    threadId: input.threadId,
    job: input.job,
    runId: randomUUID(),
  } as any;
}

function makeLaunch(calls: Array<{ input: any; store: any }> = []) {
  return (input: any) => {
    const store = fakeStore(input);
    calls.push({ input, store });
    return { ok: true as const, store };
  };
}

function makeResolve(resolutions: any[] = []) {
  return async (store: any, toolUseID: string, approved: boolean, _updatedInput?: unknown, denyMessage?: string) => {
    if (!store.pendingPermissions.has(toolUseID)) return false;
    store.pendingPermissions.delete(toolUseID);
    resolutions.push({ approved, denyMessage });
    return true;
  };
}

function finish(store: any, type = "done") {
  store.emitter.emit("event", { seq: 1, type });
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "gitbot-test@example.com"]);
  execFileSync("git", ["-C", path, "config", "user.name", "GitBot Test"]);
  writeFileSync(join(path, "README.md"), "initial\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-m", "initial"]);
}

test("validates policy, cron, and bot references and defaults approvals to escalation", () => {
  const bot = makeBot();
  const good = jobStore.validateJobInput({ name: "Default", botId: bot.id, prompt: "go" });
  assert.ok(good.ok);
  assert.equal(good.job.policy.approvals, "escalate");
  assert.equal(good.job.policy.approvalTimeoutMinutes, null);
  assert.equal(good.job.policy.isolation, "worktree");

  const autoInPlace = jobStore.validateJobInput({
    name: "Invalid isolation",
    botId: bot.id,
    prompt: "go",
    policy: { approvals: "auto", isolation: "in-place" },
  });
  assert.equal(autoInPlace.ok, false);

  const badCron = jobStore.validateJobInput({
    name: "Invalid cron",
    botId: bot.id,
    prompt: "go",
    trigger: { type: "cron", expr: "60 * * * *" },
  });
  assert.equal(badCron.ok, false);

  const missingBot = jobStore.validateJobInput({ name: "Missing", botId: "missing", prompt: "go" });
  assert.equal(missingBot.ok, false);
});

test("queues jobs FIFO, limits concurrency, and coalesces duplicate triggers", () => {
  const bot = makeBot();
  const calls: Array<{ input: any; store: any }> = [];
  const runner = jobModule.createJobRunner({
    launch: makeLaunch(calls),
    resolve: makeResolve(),
    maxConcurrent: 1,
    availableAgents: ["claude-code"],
  });
  const first = makeJob(bot.id, "First");
  const second = makeJob(bot.id, "Second");

  assert.equal(runner.enqueue(first), "started");
  assert.equal(runner.enqueue(second), "queued");
  assert.equal(calls.length, 1);
  finish(calls[0].store);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].input.job.jobId, second.id);

  assert.equal(runner.enqueue(second), "queued");
  assert.equal(runner.enqueue(second), "duplicate");
  finish(calls[1].store);
  assert.equal(calls.length, 3);
});

test("in-place runs serialize by repo without blocking later eligible queue entries", () => {
  const bot = makeBot();
  const calls: Array<{ input: any; store: any }> = [];
  const runner = jobModule.createJobRunner({
    launch: makeLaunch(calls),
    resolve: makeResolve(),
    maxConcurrent: 2,
    availableAgents: ["claude-code"],
  });
  const first = makeJob(bot.id, "Shared one", {}, "/repo/shared");
  const blocked = makeJob(bot.id, "Shared two", {}, "/repo/shared");
  const later = makeJob(bot.id, "Different repo", {}, "/repo/other");

  assert.equal(runner.enqueue(first), "started");
  assert.equal(runner.enqueue(blocked), "queued");
  assert.equal(runner.enqueue(later), "started");
  assert.deepEqual(calls.map(call => call.input.job.jobId), [first.id, later.id]);
  finish(calls[0].store);
  assert.equal(calls[2].input.job.jobId, blocked.id);
});

test("denies job permissions according to policy", () => {
  const bot = makeBot();
  const calls: Array<{ input: any; store: any }> = [];
  const resolutions: any[] = [];
  const runner = jobModule.createJobRunner({
    launch: makeLaunch(calls),
    resolve: makeResolve(resolutions),
    maxConcurrent: 1,
    availableAgents: ["claude-code"],
  });
  const job = makeJob(bot.id, "Deny", { approvals: "deny" });
  runner.enqueue(job);
  const store = calls[0].store;
  store.pendingPermissions.set("tool-1", { toolUseID: "tool-1" });
  store.emitter.emit("event", { seq: 1, type: "permission_request", toolUseID: "tool-1" });
  assert.deepEqual(resolutions, [{ approved: false, denyMessage: "Denied by job policy" }]);
});

test("denies pending job permissions when their approval timer expires", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const bot = makeBot();
    const calls: Array<{ input: any; store: any }> = [];
    const resolutions: any[] = [];
    const runner = jobModule.createJobRunner({
      launch: makeLaunch(calls),
      resolve: makeResolve(resolutions),
      maxConcurrent: 1,
      availableAgents: ["claude-code"],
    });
    const job = makeJob(bot.id, "Timeout", { approvalTimeoutMinutes: 1 });
    runner.enqueue(job);
    const store = calls[0].store;
    store.pendingPermissions.set("tool-timeout", { toolUseID: "tool-timeout" });
    store.emitter.emit("event", { seq: 1, type: "permission_request", toolUseID: "tool-timeout" });

    await t.mock.timers.tick(60_000);
    assert.deepEqual(resolutions, [{ approved: false, denyMessage: "Approval timed out" }]);
    finish(store);
  } finally {
    t.mock.timers.reset();
  }
});

test("creates worktrees and removes only clean, unchanged branches", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gitbot-job-repo-clean-"));
  initRepo(repo);
  const bot = makeBot(repo);
  const job = makeJob(bot.id, "Clean worktree", { isolation: "worktree" }, repo);
  const calls: Array<{ input: any; store: any }> = [];
  const launch = (input: any) => {
    const store = fakeStore(input);
    store.repoPath = botStore.getThread(input.threadId).repoPath;
    store.runId = runLog.startRun(store);
    calls.push({ input, store });
    return { ok: true as const, store };
  };
  const runner = jobModule.createJobRunner({
    launch,
    resolve: makeResolve(),
    maxConcurrent: 1,
    availableAgents: ["claude-code"],
  });

  assert.equal(runner.enqueue(job), "started");
  const { input, store } = calls[0];
  const worktree = input.job.worktreePath;
  const branch = input.job.branch;
  assert.ok(worktree && branch);
  assert.equal(execFileSync("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(), branch);
  assert.equal(botStore.getThread(input.threadId).jobId, job.id);

  common.emitEvent(store, "done", {});
  await runLog.waitForRunLog(store.runId);
  assert.equal(existsSync(worktree), false);
  assert.equal(execFileSync("git", ["-C", repo, "branch", "--list", branch], { encoding: "utf8" }).trim(), "");
  const logged = runLog.readRun(store.runId);
  assert.ok(logged);
  assert.equal(logged.run.jobId, job.id);
  assert.equal(logged.run.trigger, "manual");
  assert.equal(logged.run.worktreePath, null);
  assert.equal(logged.run.branch, null);
});

test("keeps worktrees with uncommitted output", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gitbot-job-repo-dirty-"));
  initRepo(repo);
  const bot = makeBot(repo);
  const job = makeJob(bot.id, "Dirty worktree", { isolation: "worktree" }, repo);
  const calls: Array<{ input: any; store: any }> = [];
  const launch = (input: any) => {
    writeFileSync(join(input.job.worktreePath, "output.txt"), "keep this output");
    const store = fakeStore(input);
    store.repoPath = botStore.getThread(input.threadId).repoPath;
    store.runId = runLog.startRun(store);
    calls.push({ input, store });
    return { ok: true as const, store };
  };
  const runner = jobModule.createJobRunner({
    launch,
    resolve: makeResolve(),
    maxConcurrent: 1,
    availableAgents: ["claude-code"],
  });

  runner.enqueue(job);
  const { input, store } = calls[0];
  const worktree = input.job.worktreePath;
  common.emitEvent(store, "done", {});
  await runLog.waitForRunLog(store.runId);
  assert.equal(existsSync(join(worktree, "output.txt")), true);
  const logged = runLog.readRun(store.runId);
  assert.ok(logged);
  assert.equal(logged.run.worktreePath, worktree);
  assert.equal(logged.run.branch, input.job.branch);
});
