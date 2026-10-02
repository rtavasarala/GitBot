import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

process.env.GITBOT_DATA_DIR = mkdtempSync(join(tmpdir(), "gitbot-turns-test-"));

let botStore: any;
let turns: any;

before(async () => {
  [botStore, turns] = await Promise.all([
    import("../src/bot-store"),
    import("../src/turns"),
  ]);
});

test("rejects a thread whose repository folder no longer exists", () => {
  const bot = botStore.createBot({
    name: "Missing folder test bot",
    agent: "claude-code",
    repoPath: process.cwd(),
  });
  const missingPath = join(process.env.GITBOT_DATA_DIR, "deleted-repository");
  const thread = botStore.createThread(bot.id, missingPath, "Missing folder", "chat", "claude-code");

  const result = turns.startTurn({ threadId: thread.id, prompt: "Continue" }, ["claude-code"]);
  assert.deepEqual(result, {
    ok: false,
    status: 409,
    message: `This thread's folder no longer exists (${missingPath}); start a new thread`,
    extra: { repoMissing: true },
  });
});
