import { createHmac, timingSafeEqual } from "crypto";
import {
  getJob,
  listJobs,
  saveJob,
  validateJobInput,
} from "./job-store";
import { deleteJob as removeJob } from "./jobs";
import type { JobRunner } from "./jobs";
import { listRuns } from "./run-log";
import { jsonError, jsonOk, parseQuery, readBody } from "./server-common";
import type { IRequest, IResponse } from "./server-common";

const WEBHOOK_BODY_LIMIT = 1024 * 1024;

function pathFrom(req: IRequest): string {
  return (req.url ?? "/").split("?")[0];
}

function jobIdFrom(path: string, suffix = ""): string | undefined {
  const match = path.match(new RegExp(`^/jobs/([^/]+)${suffix}$`));
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export async function handleJobRoutes(
  req: IRequest,
  res: IResponse,
  runner?: JobRunner,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const path = pathFrom(req);
  const query = parseQuery(req.url ?? "/");

  if (path === "/jobs" && method === "GET") {
    jsonOk(res, { jobs: listJobs() });
    return true;
  }
  if (path === "/jobs" && method === "POST") {
    const validation = validateJobInput(await readBody(req));
    if (!validation.ok) {
      jsonError(res, 400, validation.message);
      return true;
    }
    jsonOk(res, { job: saveJob(validation.job) });
    return true;
  }

  const runsJobId = jobIdFrom(path, "/runs");
  if (runsJobId && method === "GET") {
    if (!getJob(runsJobId)) {
      jsonError(res, 404, "Job not found");
      return true;
    }
    const parsedLimit = query.limit === undefined ? undefined : Number.parseInt(query.limit, 10);
    jsonOk(res, {
      runs: listRuns({
        jobId: runsJobId,
        limit: parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      }),
    });
    return true;
  }

  const runJobId = jobIdFrom(path, "/run");
  if (runJobId && method === "POST") {
    const job = getJob(runJobId);
    if (!job) {
      jsonError(res, 404, "Job not found");
      return true;
    }
    if (!runner) {
      jsonError(res, 503, "Job runner unavailable");
      return true;
    }
    const status = runner.enqueue(job, "manual");
    if (status === "duplicate") {
      jsonError(res, 409, "Job already has a queued run");
      return true;
    }
    jsonOk(res, { status });
    return true;
  }

  const id = jobIdFrom(path);
  if (!id) return false;
  if (method === "GET") {
    const job = getJob(id);
    if (!job) {
      jsonError(res, 404, "Job not found");
      return true;
    }
    jsonOk(res, { job });
    return true;
  }
  if (method === "PATCH") {
    const existing = getJob(id);
    if (!existing) {
      jsonError(res, 404, "Job not found");
      return true;
    }
    const validation = validateJobInput(await readBody(req), existing);
    if (!validation.ok) {
      jsonError(res, 400, validation.message);
      return true;
    }
    jsonOk(res, { job: saveJob(validation.job) });
    return true;
  }
  if (method === "DELETE") {
    if (!removeJob(id, runner)) {
      jsonError(res, 404, "Job not found");
      return true;
    }
    jsonOk(res, { ok: true });
    return true;
  }
  return false;
}

function readRawBody(req: IRequest): Promise<{ body?: Buffer; tooLarge?: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let tooLarge = false;
    req.on("data", chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > WEBHOOK_BODY_LIMIT) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(buffer);
      }
    });
    req.on("end", () => resolve(tooLarge ? { tooLarge: true } : { body: Buffer.concat(chunks) }));
    req.on("error", reject);
  });
}

function header(req: IRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function validSignature(secret: string, body: Buffer, signature: string | undefined): boolean {
  const match = signature?.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return false;
  const supplied = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function handleJobWebhook(
  req: IRequest,
  res: IResponse,
  runner?: JobRunner,
): Promise<boolean> {
  const path = pathFrom(req);
  if ((req.method ?? "GET") !== "POST") return false;
  const id = path.match(/^\/hooks\/jobs\/([^/]+)$/)?.[1];
  if (!id) return false;

  const raw = await readRawBody(req);
  if (raw.tooLarge) {
    jsonError(res, 413, "Webhook body exceeds 1 MB");
    return true;
  }

  let jobId: string;
  try {
    jobId = decodeURIComponent(id);
  } catch {
    jsonError(res, 404, "Job not found");
    return true;
  }
  const job = getJob(jobId);
  if (!job || !job.enabled || job.trigger.type !== "webhook" || !job.webhookSecret) {
    jsonError(res, 404, "Job not found");
    return true;
  }
  if (!validSignature(job.webhookSecret, raw.body ?? Buffer.alloc(0), header(req, "x-hub-signature-256"))) {
    jsonError(res, 401, "Invalid webhook signature");
    return true;
  }
  if (!runner) {
    jsonError(res, 503, "Job runner unavailable");
    return true;
  }

  const status = runner.enqueue(job, "webhook", {
    event: header(req, "x-github-event") ?? "unknown",
    rawBody: raw.body,
  });
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: status === "duplicate" ? "queued" : status }));
  return true;
}
