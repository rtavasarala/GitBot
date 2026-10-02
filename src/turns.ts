import { randomUUID } from "crypto";
import {
  createSession,
  emitEvent,
  findSession,
  notifyPermissionsChanged,
  scheduleCleanup,
  type BotPreset,
  type PermissionMode,
  type SessionStore,
} from "./server-common";
import { botNeedsSetup, DEFAULT_BOT_AGENT, getBot, getThread, touchThread, updateThread } from "./bot-store";
import { botPermissionToSession } from "./server-common";
import { runAgent as runClaudeCode } from "./start-claude-code";
import { runAgent as runOpencode } from "./start-opencode";
import { runAgent as runCodex } from "./start-codex";
import { startRun } from "./run-log";
import type { JobRunMeta } from "./job-store";

export interface TurnInput {
  repoPath?: string;
  agent?: string;
  sessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  mode?: SessionStore["mode"];
  prompt?: string;
  attachments?: unknown;
  threadId?: string;
  job?: JobRunMeta;
}

export type TurnResult =
  | { ok: true; store: SessionStore }
  | { ok: false; status: number; message: string; extra?: Record<string, unknown> };

function failure(status: number, message: string, extra?: Record<string, unknown>): TurnResult {
  return { ok: false, status, message, ...(extra ? { extra } : {}) };
}

export function startTurn(input: TurnInput, availableAgents: string[]): TurnResult {
  let { repoPath, agent, sessionId: existingId, model, permissionMode } = input;
  const { prompt, threadId } = input;
  const attachments = input.attachments as Array<{ url: string }> | undefined;
  let { mode } = input;

  // A threadId comes from the bot hub: it supplies the repo, the resume handle
  // and the bot preset, so the client need not repeat them.
  let botPreset: BotPreset | undefined;
  if (threadId) {
    const thread = getThread(threadId);
    if (!thread) return failure(404, "Thread not found");
    const bot = getBot(thread.botId);
    if (!bot) return failure(404, "Bot not found");
    repoPath = thread.repoPath;
    // An explicit thread choice wins; older threads without one inherit
    // the bot's configured agent.
    agent = thread.agent ?? bot.agent ?? DEFAULT_BOT_AGENT;
    if (!availableAgents.includes(agent)) {
      return failure(400, `${bot.name} runs on ${agent}, which is not installed on this machine`, {
        agentUnavailable: agent,
      });
    }
    if (thread.agent !== agent) updateThread(threadId, { agent: agent as typeof DEFAULT_BOT_AGENT });
    existingId = thread.sdkSessionId ?? undefined;
    model = model ?? bot.model;
    // Bot presets speak their own vocabulary ("auto-approve", "plan"); the
    // session speaks PermissionMode. Translate, or nothing auto-approves.
    const botPermission = botPermissionToSession(bot.permissionMode, agent as typeof DEFAULT_BOT_AGENT);
    permissionMode = permissionMode ?? (input.job
      ? botPermissionToSession(
        input.job.policy.approvals === "auto" ? "auto-approve" : "ask-permissions",
        agent as typeof DEFAULT_BOT_AGENT,
      ).permissionMode
      : botPermission.permissionMode);
    mode = mode ?? botPermission.mode;
    const isSetup = thread.kind === "setup";
    // Work waits on setup; the setup thread itself is exempt, since it is
    // the thing that clears the block.
    if (!isSetup && botNeedsSetup(bot)) {
      return failure(409, `${bot.name} still needs to set up this machine`, {
        setupRequired: true,
        setupThreadId: bot.setupThreadId,
      });
    }
    botPreset = {
      id: bot.id,
      name: bot.name,
      instructions: bot.instructions,
      // The allow-list fences the bot's work. Its setup run prepares the
      // machine, which can need tools the job itself never uses.
      allowedTools: isSetup ? undefined : bot.allowedTools,
      disallowedTools: bot.disallowedTools,
      ...(isSetup ? { setup: true, setupInstructions: bot.setupInstructions } : {}),
    };
  }

  if (!repoPath) return failure(400, "repoPath is required");
  if (!prompt && (!attachments || attachments.length === 0)) {
    return failure(400, "prompt or attachments is required");
  }
  if (input.attachments != null && (!Array.isArray(input.attachments)
    || input.attachments.some((attachment: any) => typeof attachment?.url !== "string" || !attachment.url))) {
    return failure(400, "attachments must be an array of { url: string }");
  }
  if (agent !== "claude-code" && agent !== "opencode" && agent !== "codex") {
    return failure(400, "agent must be claude-code, opencode, or codex");
  }
  if (!availableAgents.includes(agent)) {
    return failure(400, `Agent '${agent}' is not available`);
  }

  let store = existingId ? findSession(existingId) : undefined;
  if (store) {
    if (store.status === "running") return failure(409, "Session is already running");
    if (store.cleanupTimer) clearTimeout(store.cleanupTimer);
    store.cleanupTimer = null;
    store.status = "running";
    notifyPermissionsChanged();
    store.events = [];
    store.seq = 0;
    if (model) store.model = model;
    if (mode) store.mode = mode;
    if (permissionMode) store.permissionMode = permissionMode as PermissionMode;
    if (threadId) {
      store.threadId = threadId;
      store.botPreset = botPreset;
    }
    store.job = input.job;
    store.runId = startRun(store);
    emitEvent(store, "user_prompt", { prompt: prompt ?? "", ...(attachments?.length ? { attachments } : {}) });
  } else {
    const gitbotId = existingId ?? randomUUID();
    store = createSession(
      gitbotId,
      agent,
      repoPath,
      model,
      mode,
      permissionMode as PermissionMode | undefined,
      { threadId, preset: botPreset },
    );
    if (existingId) store.sdkSessionId = existingId;
    store.job = input.job;
    store.runId = startRun(store);
    emitEvent(store, "user_prompt", { prompt: prompt ?? "", ...(attachments?.length ? { attachments } : {}) });
    notifyPermissionsChanged();
  }

  const activeStore = store;
  if (threadId) touchThread(threadId, prompt ?? "");

  // Anything thrown past runAgent's own handling would otherwise leave the
  // session pinned to "running": every later message on the thread answers
  // 409 for as long as the server lives, and the event stream — which only
  // closes on done/error/aborted — hangs the client that is watching it.
  // Each runAgent already reports its own failures and lands on "error"
  // before returning, so the status check makes this a no-op on every path
  // that handled itself.
  const onRunRejected = (error: any) => {
    console.error("[runAgent] unhandled:", error);
    if (activeStore.status === "running") {
      emitEvent(activeStore, "error", { message: error?.message ?? `${agent} failed to start` });
      activeStore.status = "error";
      scheduleCleanup(activeStore);
      notifyPermissionsChanged();
    }
  };

  if (agent === "claude-code") {
    runClaudeCode(activeStore).catch(onRunRejected);
  } else if (agent === "codex") {
    runCodex(activeStore).catch(onRunRejected);
  } else {
    runOpencode(activeStore).catch(onRunRejected);
  }

  return { ok: true, store: activeStore };
}
