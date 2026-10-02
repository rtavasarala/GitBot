import { randomUUID } from "crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import type { WriteStream } from "fs";
import { join } from "path";
import { dataDir } from "./bot-store";
import type { SessionStore, StoredEvent } from "./server-common";

export interface RunSummary {
  runId: string;
  gitbotId: string;
  threadId: string | null;
  botId: string | null;
  agent: SessionStore["agent"];
  repoPath: string;
  model: string | null;
  permissionMode: SessionStore["permissionMode"];
  status: "running" | "done" | "error" | "aborted" | "interrupted";
  startedAt: string;
  endedAt: string | null;
}

const RUNS_DIR = join(dataDir(), "runs");
const INDEX_FILE = join(RUNS_DIR, "index.json");
const streams = new Map<string, WriteStream>();
const closingStreams = new Map<string, Promise<void>>();
const loggedErrors = new Set<string>();
let index: Record<string, RunSummary> | undefined;

function logPersistenceError(runId: string, error: unknown): void {
  if (loggedErrors.has(runId)) return;
  loggedErrors.add(runId);
  console.error(`[run-log] ${runId}: ${error instanceof Error ? error.message : String(error)}`);
}

function ensureRunsDir(): void {
  mkdirSync(RUNS_DIR, { recursive: true, mode: 0o700 });
}

function loadIndex(): Record<string, RunSummary> {
  if (index) return index;
  try {
    index = existsSync(INDEX_FILE)
      ? JSON.parse(readFileSync(INDEX_FILE, "utf-8")) as Record<string, RunSummary>
      : {};
    if (!index || typeof index !== "object" || Array.isArray(index)) index = {};
  } catch (error) {
    logPersistenceError("index", error);
    index = {};
  }
  return index;
}

function writeIndex(runId: string): void {
  try {
    ensureRunsDir();
    const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(loadIndex(), null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, INDEX_FILE);
  } catch (error) {
    logPersistenceError(runId, error);
  }
}

function streamFor(runId: string): WriteStream | undefined {
  const current = streams.get(runId);
  if (current) return current;

  try {
    ensureRunsDir();
    const stream = createWriteStream(join(RUNS_DIR, `${runId}.jsonl`), { flags: "a", mode: 0o600 });
    stream.on("error", error => logPersistenceError(runId, error));
    streams.set(runId, stream);
    return stream;
  } catch (error) {
    logPersistenceError(runId, error);
    return undefined;
  }
}

export function startRun(store: SessionStore): string {
  const runId = randomUUID();
  const run: RunSummary = {
    runId,
    gitbotId: store.gitbotId,
    threadId: store.threadId ?? null,
    botId: store.botPreset?.id ?? null,
    agent: store.agent,
    repoPath: store.repoPath,
    model: store.model ?? null,
    permissionMode: store.permissionMode,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
  };

  loadIndex()[runId] = run;
  streamFor(runId);
  writeIndex(runId);
  return runId;
}

export function appendRunEvent(store: SessionStore, event: StoredEvent): void {
  const runId = store.runId;
  if (!runId) return;
  const stream = streamFor(runId);
  if (!stream) return;

  try {
    stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, error => {
      if (error) logPersistenceError(runId, error);
    });
  } catch (error) {
    logPersistenceError(runId, error);
  }
}

export function finishRun(runId: string, status: RunSummary["status"]): Promise<void> {
  const run = loadIndex()[runId];
  if (run) {
    run.status = status;
    run.endedAt = new Date().toISOString();
    writeIndex(runId);
  }

  const stream = streams.get(runId);
  if (!stream) return closingStreams.get(runId) ?? Promise.resolve();
  streams.delete(runId);

  const closing = new Promise<void>(resolve => {
    const done = () => resolve();
    stream.once("close", done);
    stream.end(done);
  }).finally(() => closingStreams.delete(runId));
  closingStreams.set(runId, closing);
  return closing;
}

export function recoverInterruptedRuns(): number {
  let recovered = 0;
  for (const run of Object.values(loadIndex())) {
    if (run.status !== "running") continue;
    run.status = "interrupted";
    run.endedAt = new Date().toISOString();
    appendRunEvent({ runId: run.runId } as SessionStore, {
      seq: -1,
      type: "interrupted",
      message: "GitBot stopped while this run was in progress",
    });
    void finishRun(run.runId, "interrupted");
    recovered++;
  }
  if (recovered > 0) writeIndex("index");
  return recovered;
}

export function listRuns(options: {
  threadId?: string;
  status?: RunSummary["status"];
  limit?: number;
} = {}): RunSummary[] {
  const limit = Math.max(0, options.limit ?? 100);
  return Object.values(loadIndex())
    .filter(run => (!options.threadId || run.threadId === options.threadId)
      && (!options.status || run.status === options.status))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

export function readRun(runId: string): { run: RunSummary; events: object[] } | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return undefined;

  const run = loadIndex()[runId];
  if (!run) return undefined;
  try {
    const content = readFileSync(join(RUNS_DIR, `${runId}.jsonl`), "utf-8");
    const events = content.split("\n").filter(Boolean).flatMap(line => {
      try {
        return [JSON.parse(line) as object];
      } catch {
        return [];
      }
    });
    return { run, events };
  } catch (error) {
    logPersistenceError(runId, error);
    return { run, events: [] };
  }
}

export function waitForRunLog(runId: string): Promise<void> {
  const closing = closingStreams.get(runId);
  if (closing) return closing;
  const stream = streams.get(runId);
  if (!stream) return Promise.resolve();
  return new Promise(resolve => stream.write("", () => resolve()));
}
