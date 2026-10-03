import { randomBytes, randomUUID } from "crypto";
import { join } from "path";
import { nextCronTime, parseCron } from "./cron";
import { dataDir, getBot, readCollection, writeCollection } from "./bot-store";

export type JobTrigger =
  | { type: "manual" }
  | { type: "interval"; everyMinutes: number }
  | { type: "cron"; expr: string }
  | { type: "webhook"; events?: string[] };

export interface JobPolicy {
  approvals: "escalate" | "auto" | "deny";
  approvalTimeoutMinutes: number | null;
  isolation: "worktree" | "in-place";
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export interface JobRunMeta {
  jobId: string;
  trigger: JobTrigger["type"];
  policy: JobPolicy;
  worktreePath?: string;
  branch?: string;
  baseSha?: string;
}

export interface Job {
  id: string;
  name: string;
  botId: string;
  prompt: string;
  repoPath?: string;
  trigger: JobTrigger;
  policy: JobPolicy;
  enabled: boolean;
  webhookSecret?: string;
  nextRunAt: string | null;
  lastRunId?: string;
  lastRunAt?: string;
  lastRunStatus?: "done" | "error" | "aborted" | "interrupted";
  createdAt: string;
  updatedAt: string;
}

export type JobValidationResult =
  | { ok: true; job: Job }
  | { ok: false; message: string };

const JOBS_FILE = join(dataDir(), "jobs.json");
const now = () => new Date().toISOString();

export function listJobs(): Job[] {
  return readCollection<Job>(JOBS_FILE).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getJob(id: string): Job | undefined {
  return readCollection<Job>(JOBS_FILE).find(job => job.id === id);
}

export function saveJob(job: Job): Job {
  const jobs = readCollection<Job>(JOBS_FILE);
  const index = jobs.findIndex(item => item.id === job.id);
  if (index < 0) jobs.push(job);
  else jobs[index] = job;
  writeCollection(JOBS_FILE, jobs);
  return job;
}

export function deleteJob(id: string): boolean {
  const jobs = readCollection<Job>(JOBS_FILE);
  const remaining = jobs.filter(job => job.id !== id);
  if (remaining.length === jobs.length) return false;
  writeCollection(JOBS_FILE, remaining);
  return true;
}

function valueFrom<T>(input: Record<string, any>, existing: Job | undefined, key: keyof Job, fallback: T): T {
  if (Object.prototype.hasOwnProperty.call(input, key)) return input[key] as T;
  if (existing && existing[key] !== undefined) return existing[key] as T;
  return fallback;
}

function policyValue<T>(
  input: Record<string, any>,
  existing: Job | undefined,
  key: keyof JobPolicy,
  fallback: T,
): T {
  if (Object.prototype.hasOwnProperty.call(input, key)) return input[key] as T;
  const old = existing?.policy?.[key];
  return old !== undefined ? old as T : fallback;
}

export function validateJobInput(input: unknown, existing?: Job): JobValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "Job must be an object" };
  }
  const values = input as Record<string, any>;

  const nameValue = valueFrom(values, existing, "name", "");
  const botIdValue = valueFrom(values, existing, "botId", "");
  const promptValue = valueFrom(values, existing, "prompt", "");
  if (typeof nameValue !== "string" || !nameValue.trim()) return { ok: false, message: "name is required" };
  if (typeof botIdValue !== "string" || !botIdValue.trim()) return { ok: false, message: "botId is required" };
  if (!getBot(botIdValue.trim())) return { ok: false, message: "Bot not found" };
  if (typeof promptValue !== "string" || !promptValue.trim()) return { ok: false, message: "prompt is required" };

  const triggerValue = valueFrom<JobTrigger>(values, existing, "trigger", { type: "manual" });
  if (!triggerValue || typeof triggerValue !== "object" || typeof (triggerValue as any).type !== "string") {
    return { ok: false, message: "trigger is invalid" };
  }
  let trigger: JobTrigger;
  switch ((triggerValue as any).type) {
    case "manual":
      trigger = { type: "manual" };
      break;
    case "interval":
      if (!Number.isInteger((triggerValue as any).everyMinutes) || (triggerValue as any).everyMinutes < 1) {
        return { ok: false, message: "everyMinutes must be an integer of at least 1" };
      }
      trigger = { type: "interval", everyMinutes: (triggerValue as any).everyMinutes };
      break;
    case "cron":
      if (typeof (triggerValue as any).expr !== "string") return { ok: false, message: "cron expr is required" };
      try {
        parseCron((triggerValue as any).expr);
        nextCronTime((triggerValue as any).expr, new Date());
      } catch (error) {
        return { ok: false, message: `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}` };
      }
      trigger = { type: "cron", expr: (triggerValue as any).expr };
      break;
    case "webhook":
      if ((triggerValue as any).events !== undefined) {
        const events = (triggerValue as any).events;
        if (!Array.isArray(events) || events.length === 0
          || events.some((event: unknown) => typeof event !== "string" || !event.trim())) {
          return { ok: false, message: "webhook events must be a non-empty array of non-empty strings" };
        }
        trigger = { type: "webhook", events: events.map((event: string) => event.trim()) };
      } else {
        trigger = { type: "webhook" };
      }
      break;
    default:
      return { ok: false, message: "trigger type must be manual, interval, cron, or webhook" };
  }

  const rawPolicy = values.policy;
  if (rawPolicy !== undefined && (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy))) {
    return { ok: false, message: "policy must be an object" };
  }
  const policyInput = (rawPolicy ?? {}) as Record<string, any>;
  const approvals = policyValue<"escalate" | "auto" | "deny">(policyInput, existing, "approvals", "escalate");
  const approvalTimeoutMinutes = policyValue<number | null>(policyInput, existing, "approvalTimeoutMinutes", null);
  const isolation = policyValue<"worktree" | "in-place">(policyInput, existing, "isolation", "worktree");
  const maxTurns = policyValue<number | undefined>(policyInput, existing, "maxTurns", undefined);
  const maxBudgetUsd = policyValue<number | undefined>(policyInput, existing, "maxBudgetUsd", undefined);

  if (approvals !== "escalate" && approvals !== "auto" && approvals !== "deny") {
    return { ok: false, message: "approvals must be escalate, auto, or deny" };
  }
  if (isolation !== "worktree" && isolation !== "in-place") {
    return { ok: false, message: "isolation must be worktree or in-place" };
  }
  if (approvals === "auto" && isolation === "in-place") {
    return { ok: false, message: "auto approvals require worktree isolation" };
  }
  if (approvalTimeoutMinutes !== null
    && (!Number.isInteger(approvalTimeoutMinutes) || approvalTimeoutMinutes < 1)) {
    return { ok: false, message: "approvalTimeoutMinutes must be null or an integer of at least 1" };
  }
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
    return { ok: false, message: "maxTurns must be an integer of at least 1" };
  }
  if (maxBudgetUsd !== undefined && (typeof maxBudgetUsd !== "number" || !(maxBudgetUsd > 0))) {
    return { ok: false, message: "maxBudgetUsd must be greater than 0" };
  }

  const enabled = valueFrom<boolean>(values, existing, "enabled", true);
  if (typeof enabled !== "boolean") return { ok: false, message: "enabled must be a boolean" };

  const repoPathValue = valueFrom<string | undefined>(values, existing, "repoPath", undefined);
  if (repoPathValue !== undefined && repoPathValue !== null && typeof repoPathValue !== "string") {
    return { ok: false, message: "repoPath must be a string" };
  }
  const repoPath = typeof repoPathValue === "string" ? (repoPathValue.trim() || undefined) : undefined;
  const currentTime = new Date();
  let nextRunAt: string | null = null;
  if (enabled && trigger.type === "interval") {
    nextRunAt = new Date(currentTime.getTime() + trigger.everyMinutes * 60_000).toISOString();
  } else if (enabled && trigger.type === "cron") {
    nextRunAt = nextCronTime(trigger.expr, currentTime).toISOString();
  }
  if (existing?.enabled && enabled && existing.nextRunAt !== null
    && JSON.stringify(trigger) === JSON.stringify(existing.trigger)) {
    nextRunAt = existing.nextRunAt;
  }

  const policy: JobPolicy = {
    approvals,
    approvalTimeoutMinutes,
    isolation,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
  };
  const job: Job = {
    id: existing?.id ?? randomUUID(),
    name: nameValue.trim(),
    botId: botIdValue.trim(),
    prompt: promptValue.trim(),
    ...(repoPath ? { repoPath } : {}),
    trigger,
    policy,
    enabled,
    ...(trigger.type === "webhook"
      ? { webhookSecret: existing?.trigger.type === "webhook" && existing.webhookSecret
        ? existing.webhookSecret
        : randomBytes(32).toString("hex") }
      : {}),
    nextRunAt,
    ...(existing?.lastRunId ? { lastRunId: existing.lastRunId } : {}),
    ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
    ...(existing?.lastRunStatus ? { lastRunStatus: existing.lastRunStatus } : {}),
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  };
  return { ok: true, job };
}
