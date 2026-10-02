import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
});
