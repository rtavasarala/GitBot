import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "gitbot-run-log-test-"));
process.env.GITBOT_DATA_DIR = dataDir;

function createStore(threadId: string) {
  return {
    gitbotId: `gitbot-${threadId}`,
    sdkSessionId: null,
    agent: "claude-code",
    repoPath: "/tmp/repo",
    model: "sonnet",
    mode: "build",
    permissionMode: "ask-permissions",
    seq: 0,
    events: [],
    status: "running",
    emitter: {},
    abortController: null,
    pendingPermissions: new Map(),
    cleanupTimer: null,
    threadId,
    botPreset: { id: `bot-${threadId}`, name: "Test", instructions: "" },
  } as any;
}

test("persists a run's ordered events and recovers running runs", async () => {
  const { appendRunEvent, finishRun, listRuns, readRun, recoverInterruptedRuns, startRun, waitForRunLog } =
    await import("../src/run-log");
  const first = createStore("thread");
  first.runId = startRun(first);
  appendRunEvent(first, { seq: 1, type: "user_prompt", prompt: "hello" });
  appendRunEvent(first, { seq: 2, type: "assistant", text: "working" });
  appendRunEvent(first, { seq: 3, type: "done" });
  await finishRun(first.runId, "done");
  appendRunEvent(first, { seq: 4, type: "error", message: "after finish" });

  const firstRun = readRun(first.runId);
  assert.ok(firstRun);
  assert.equal(firstRun.run.status, "done");
  assert.deepEqual(firstRun.events.map((event: any) => event.type), ["user_prompt", "assistant", "done"]);

  await new Promise(resolve => setTimeout(resolve, 5));
  const second = createStore("thread");
  second.runId = startRun(second);
  appendRunEvent(second, { seq: 1, type: "user_prompt", prompt: "resume" });

  assert.equal(recoverInterruptedRuns(), 1);
  await waitForRunLog(second.runId);
  const interruptedRun = readRun(second.runId);
  assert.ok(interruptedRun);
  assert.equal(interruptedRun.run.status, "interrupted");
  assert.equal(interruptedRun.events.at(-1)?.type, "interrupted");

  const runs = listRuns({ threadId: "thread" });
  assert.deepEqual(runs.map(run => run.runId), [second.runId, first.runId]);
  assert.deepEqual(listRuns({ status: "done" }).map(run => run.runId), [first.runId]);
  assert.equal(readRun("../x"), undefined);

  const outcome = createStore("outcome");
  outcome.runId = startRun(outcome);
  appendRunEvent(outcome, { seq: 1, type: "user_prompt", prompt: "fail" });
  await finishRun(outcome.runId, "error");
  const endedAt = readRun(outcome.runId)?.run.endedAt;
  await finishRun(outcome.runId, "done");
  appendRunEvent(outcome, { seq: 2, type: "done" });
  await waitForRunLog(outcome.runId);
  const outcomeRun = readRun(outcome.runId);
  assert.ok(outcomeRun);
  assert.equal(outcomeRun.run.status, "error");
  assert.equal(outcomeRun.run.endedAt, endedAt);
  assert.deepEqual(outcomeRun.events.map((event: any) => event.type), ["user_prompt"]);
});

const runsDir = join(dataDir, "runs");
const ownerFile = join(runsDir, "owner.json");

test("refuses ownership when another live process owns the data directory", async () => {
  const { claimRunOwnership } = await import("../src/run-log");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(ownerFile, JSON.stringify({
    pid: process.ppid,
    port: 3000,
    startedAt: new Date().toISOString(),
  }));
  assert.equal(claimRunOwnership(3001), false);
});

test("claims ownership when the recorded process is dead or the file is malformed", async () => {
  const { claimRunOwnership } = await import("../src/run-log");
  const deadProcess = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(deadProcess.status, 0);
  assert.ok(deadProcess.pid);

  writeFileSync(ownerFile, JSON.stringify({
    pid: deadProcess.pid,
    port: 3000,
    startedAt: new Date().toISOString(),
  }));
  assert.equal(claimRunOwnership(3001), true);
  assert.equal(JSON.parse(readFileSync(ownerFile, "utf-8")).pid, process.pid);

  writeFileSync(ownerFile, "{");
  assert.equal(claimRunOwnership(3002), true);
  assert.equal(JSON.parse(readFileSync(ownerFile, "utf-8")).pid, process.pid);
});

test("releases only ownership held by this process", async () => {
  const { releaseRunOwnership } = await import("../src/run-log");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(ownerFile, JSON.stringify({
    pid: process.pid,
    port: 3000,
    startedAt: new Date().toISOString(),
  }));
  releaseRunOwnership();
  assert.equal(existsSync(ownerFile), false);

  writeFileSync(ownerFile, JSON.stringify({
    pid: process.ppid,
    port: 3000,
    startedAt: new Date().toISOString(),
  }));
  releaseRunOwnership();
  assert.equal(existsSync(ownerFile), true);
  unlinkSync(ownerFile);
});
