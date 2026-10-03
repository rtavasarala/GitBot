import http from "node:http";
import {
  createHttpServer,
  setupShutdown,
  handleWorkspaceRoutes,
  shouldAutoApprove,
  findSession,
  emitEvent,
  scheduleCleanup,
  sseHeaders,
  writeSseEvent,
  parseQuery,
  parsePathParam,
  jsonOk,
  jsonError,
  readBody,
  permissionsEmitter,
  buildPermissionsDump,
  buildSessionsDump,
  notifyPermissionsChanged,
  type IRequest,
  type IResponse,
  type PermissionMode,
} from "./server-common";
import { initAgent as initClaudeCode, listSessions as listClaudeSessions, loadTranscript } from "./start-claude-code";
import { initAgent as initOpencode, stopAgent as stopOpencode, listSessions as listOpencodeSessions, getSessionHistory, abortSession as opencodeAbort, respondPermission as opencodePermission } from "./start-opencode";
import { initAgent as initCodex, listSessions as listCodexSessions, loadTranscript as loadCodexTranscript } from "./start-codex";
import { handleBotRoutes } from "./bot-routes";
import { handleMarketplaceRoutes } from "./marketplace-proxy";
import { getBot, touchThread, updateThread } from "./bot-store";
import { uiFileFor } from "./static-ui";
import { isAuthorized, loadOrCreateToken, handleTokenBootstrap } from "./auth";
import {
  claimRunOwnership,
  listRuns,
  readRun,
  recoverInterruptedRuns,
  releaseRunOwnership,
} from "./run-log";
import { resolvePermission } from "./permissions";
import { startTurn } from "./turns";
import { createJobRunner, startScheduler, type JobRunner } from "./jobs";
import { handleJobRoutes, handleJobWebhook } from "./job-routes";

export async function handleRequest(
  req: IRequest,
  res: IResponse,
  availableAgents: string[],
  workspaceCwd: string,
  token: string,
  jobRunner?: JobRunner,
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const path = url.split("?")[0];
  const query = parseQuery(url);

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // SPA served by createHttpServer's listener — only handle API routes here
  if (method === "GET" && (path === "/" || path === "")) return;
  try {
    if (await handleJobWebhook(req, res, jobRunner)) return;
    if (!isAuthorized(req, token)) {
      jsonError(res, 401, "Unauthorized", { authRequired: true });
      return;
    }

    if (await handleJobRoutes(req, res, jobRunner)) return;

    // Marketplace: proxied to the gitbot-api service
    if (await handleMarketplaceRoutes(req, res)) return;

    // Workspace + file system routes
    if (await handleWorkspaceRoutes(req, res, workspaceCwd, availableAgents)) return;

    // Run logs
    if (method === "GET" && path === "/runs") {
      const parsedLimit = query.limit === undefined ? undefined : Number.parseInt(query.limit, 10);
      jsonOk(res, {
        runs: listRuns({
          threadId: query.threadId,
          jobId: query.jobId,
          status: query.status as ReturnType<typeof listRuns>[number]["status"] | undefined,
          limit: parsedLimit,
        }),
      });
      return;
    }
    const runId = parsePathParam(path, "/runs/");
    if (method === "GET" && runId) {
      const run = readRun(runId);
      if (!run) { jsonError(res, 404, "Run not found"); return; }
      jsonOk(res, run);
      return;
    }

    // Bot hub: /bots and /threads
    if (await handleBotRoutes(req, res, workspaceCwd)) return;

    // GET /sessions
    if (method === "GET" && path === "/sessions") {
      const repoPath = query.repoPath ?? workspaceCwd;
      const agent = query.agent as "claude-code" | "opencode" | "codex" | undefined;

      if (!agent || agent === "claude-code") {
        const list = await listClaudeSessions(repoPath);
        jsonOk(res, { sessions: list });
        return;
      }
      if (agent === "opencode") {
        const list = await listOpencodeSessions(repoPath);
        jsonOk(res, { sessions: list });
        return;
      }
      if (agent === "codex") {
        const list = await listCodexSessions(repoPath);
        jsonOk(res, { sessions: list });
        return;
      }
      jsonOk(res, { sessions: [] });
      return;
    }

    // GET /sessions/:id/history
    const historyId = parsePathParam(path, "/sessions/")?.replace(/\/history$/, "");
    if (method === "GET" && path.endsWith("/history") && historyId) {
      const store = findSession(historyId);
      if (!store) {
        const agentParam = query.agent as "claude-code" | "opencode" | "codex" | undefined;
        if (agentParam === "opencode") {
          const history = await getSessionHistory(historyId, query.repoPath ?? workspaceCwd);
          jsonOk(res, { messages: history });
        } else if (agentParam === "codex") {
          const repoPath = query.repoPath ?? workspaceCwd;
          const history = await loadCodexTranscript(historyId, repoPath);
          jsonOk(res, { messages: history });
        } else {
          const repoPath = query.repoPath ?? workspaceCwd;
          const history = await loadTranscript(historyId, repoPath);
          jsonOk(res, { messages: history });
        }
        return;
      }
      if (store.agent === "opencode" && store.sdkSessionId) {
        const history = await getSessionHistory(store.sdkSessionId, store.repoPath);
        jsonOk(res, { messages: history });
      } else if (store.agent === "codex") {
        if (!store.sdkSessionId) {
          jsonOk(res, { messages: [] });
          return;
        }
        const history = await loadCodexTranscript(store.sdkSessionId, store.repoPath);
        jsonOk(res, { messages: history });
      } else {
        const history = await loadTranscript(store.sdkSessionId ?? historyId, store.repoPath);
        jsonOk(res, { messages: history });
      }
      return;
    }

    // GET /sessions/:id/config
    const configId = parsePathParam(path, "/sessions/")?.replace(/\/config$/, "");
    if (method === "GET" && path.endsWith("/config") && configId) {
      const store = findSession(configId);
      if (!store) { jsonError(res, 404, "Session not found"); return; }
      jsonOk(res, {
        gitbotId: store.gitbotId,
        sessionId: store.sdkSessionId,
        agent: store.agent,
        model: store.model ?? null,
        mode: store.mode ?? null,
        permissionMode: store.permissionMode,
      });
      return;
    }

    // GET /sessions/:id/status
    const statusId = parsePathParam(path, "/sessions/")?.replace(/\/status$/, "");
    if (method === "GET" && path.endsWith("/status") && statusId) {
      const store = findSession(statusId);
      if (!store) { jsonError(res, 404, "Session not found"); return; }
      jsonOk(res, { streaming: store.status === "running", sdkSessionId: store.sdkSessionId ?? null });
      return;
    }

    // GET /sessions/:id/permissions — which tool requests are still awaiting an
    // answer. A client rejoining a running turn replays events it has already
    // seen, and must not re-offer approvals that were resolved while it was away.
    const permsId = parsePathParam(path, "/sessions/")?.replace(/\/permissions$/, "");
    if (method === "GET" && path.endsWith("/permissions") && permsId) {
      const store = findSession(permsId);
      if (!store) { jsonError(res, 404, "Session not found"); return; }
      jsonOk(res, { pending: [...store.pendingPermissions.keys()] });
      return;
    }

    // POST /sessions/:id/abort
    const abortId = parsePathParam(path, "/sessions/")?.replace(/\/abort$/, "");
    if (method === "POST" && path.endsWith("/abort") && abortId) {
      const store = findSession(abortId);
      if (!store) { jsonError(res, 404, "Session not found"); return; }
      if (store.status !== "running") { jsonOk(res, { ok: true }); return; }
      if (store.agent === "claude-code" && store.abortController) {
        store.abortController.abort();
      } else if (store.agent === "codex" && store.abortController) {
        store.abortController.abort();
      } else if (store.agent === "opencode" && store.sdkSessionId) {
        await opencodeAbort(store.sdkSessionId, store.repoPath).catch(() => {});
        store.status = "done";
        store.pendingPermissions.clear();
        notifyPermissionsChanged();
        emitEvent(store, "aborted", { message: "Aborted by user" });
        scheduleCleanup(store);
      }
      console.log(`[abort] session ${abortId}`);
      jsonOk(res, { ok: true });
      return;
    }

    // POST /sessions/:id/permission
    const permBase = parsePathParam(path, "/sessions/")?.replace(/\/permission$/, "");
    if (method === "POST" && path.endsWith("/permission") && permBase) {
      const store = findSession(permBase);
      if (!store) { jsonError(res, 404, "Session not found"); return; }
      const body = await readBody(req);
      const { toolUseID, approved, updatedInput } = body;
      if (!toolUseID) { jsonError(res, 400, "toolUseID is required"); return; }
      console.log(`[permission] id=${toolUseID} approved=${approved}`);

      await resolvePermission(store, toolUseID, approved, updatedInput);
      jsonOk(res, { ok: true });
      return;
    }

    // POST /chat
    if (method === "POST" && path === "/chat") {
      const body = await readBody(req);
      const result = startTurn(body, availableAgents);
      if (!result.ok) {
        jsonError(res, result.status, result.message, result.extra);
        return;
      }
      jsonOk(res, { sessionId: result.store.gitbotId });
      return;
    }

    // GET /events?sessionId=X
    if (method === "GET" && path === "/events") {
      const sessionId = query.sessionId;
      if (!sessionId) { jsonError(res, 400, "sessionId is required"); return; }

      const store = findSession(sessionId);
      if (!store) { jsonError(res, 404, "Session not found"); return; }

      const lastSeq = parseInt(req.headers["last-event-id"] as string ?? "0", 10) || 0;

      res.writeHead(200, sseHeaders());

      for (const event of store.events) {
        if (event.seq > lastSeq) {
          writeSseEvent(res, event);
        }
      }

      if (store.status !== "running") {
        res.end();
        return;
      }

      const listener = (event: any) => {
        writeSseEvent(res, event);
        if (event.type === "done" || event.type === "error" || event.type === "aborted") {
          res.end();
        }
      };

      store.emitter.on("event", listener);

      req.on("close", () => {
        store.emitter.off("event", listener);
      });

      return;
    }

    // GET /permissions/events
    if (method === "GET" && path === "/permissions/events") {
      res.writeHead(200, sseHeaders());

      const sendDump = (permissions: ReturnType<typeof buildPermissionsDump>, sessions: ReturnType<typeof buildSessionsDump>) => {
        if (res.writableEnded) return;
        res.write(`event: permissions\ndata: ${JSON.stringify({ permissions, sessions })}\n\n`);
      };

      sendDump(buildPermissionsDump(), buildSessionsDump());

      permissionsEmitter.on("update", sendDump);
      req.on("close", () => {
        permissionsEmitter.off("update", sendDump);
      });

      return;
    }

    // PATCH /sessions/:id — update session settings mid-run
    if (method === "PATCH" && path.startsWith("/sessions/")) {
      const sessionId = path.slice("/sessions/".length);
      const store = findSession(sessionId);
      if (!store) { jsonError(res, 404, "Session not found"); return; }

      const body = await readBody(req);
      if (body.permissionMode !== undefined) {
        const valid: PermissionMode[] = ["ask-permissions", "allow-all-edits", "yolo"];
        if (!valid.includes(body.permissionMode)) {
          jsonError(res, 400, "Invalid permissionMode"); return;
        }
        store.permissionMode = body.permissionMode as PermissionMode;

        if (store.agent === "claude-code") {
          for (const [id, perm] of store.pendingPermissions) {
            if (shouldAutoApprove(store.agent, perm.toolName, store.permissionMode)) {
              store.pendingPermissions.delete(id);
              perm.resolve({ behavior: "allow", updatedInput: perm.input });
            }
          }
          notifyPermissionsChanged();
        } else if (store.agent === "codex") {
          // codex applies approvalPolicy at thread start — mode change takes effect next turn
        } else if (store.agent === "opencode" && store.sdkSessionId) {
          for (const [id, perm] of store.pendingPermissions) {
            if (shouldAutoApprove(store.agent, perm.toolName, store.permissionMode)) {
              store.pendingPermissions.delete(id);
              const respondSdkId = perm.askedBySdkSessionId ?? store.sdkSessionId;
              await opencodePermission(respondSdkId, id, true, store.repoPath).catch(() => {});
            }
          }
          notifyPermissionsChanged();
        }
      }

      jsonOk(res, { sessionId: store.gitbotId, permissionMode: store.permissionMode });
      return;
    }

    jsonError(res, 404, "Not found");
  } catch (err: any) {
    console.error("[request] unhandled error:", err.message);
    if (!res.headersSent) {
      jsonError(res, 500, "Internal server error");
    }
  }
}

export async function start(network: string = "local", portOverride?: number, caffeinate: boolean = false) {
  const token = loadOrCreateToken();
  const workspaceCwd = process.cwd();
  console.log(`gitbot — starting workspace server in ${workspaceCwd}`);

  // Claude Code refuses to spawn inside another Claude Code session, which would
  // otherwise surface only as an opaque "exited with code 1" on the first message.
  if (process.env.CLAUDECODE) {
    console.warn(`  warning: CLAUDECODE is set — this shell is inside a Claude Code session.`);
    console.warn(`  The claude-code agent will refuse to start. Run gitbot from a plain terminal,`);
    console.warn(`  or launch it with: env -u CLAUDECODE gitbot start -p <port>`);
  }

  const claudeAvailable = await initClaudeCode();
  const opencodeAvailable = await initOpencode();
  const codexAvailable = await initCodex();
  const availableAgents: string[] = [
    ...(claudeAvailable ? ["claude-code"] : []),
    ...(opencodeAvailable ? ["opencode"] : []),
    ...(codexAvailable ? ["codex"] : []),
  ];
  console.log(`  available agents: ${availableAgents.join(", ") || "none"}`);

  const { server, caffeinatePid, PORT } = await createHttpServer({
    portOverride,
    caffeinate,
    network,
    label: "gitbot server",
    token,
  });

  if (claimRunOwnership(PORT)) {
    const recoveredRuns = recoverInterruptedRuns();
    if (recoveredRuns > 0) console.log(`  recovered ${recoveredRuns} interrupted run${recoveredRuns === 1 ? "" : "s"}`);
  }

  const maxConcurrentJobs = Number.parseInt(process.env.GITBOT_MAX_CONCURRENT_JOBS ?? "2", 10);
  const jobRunner = createJobRunner({
    launch: startTurn,
    resolve: resolvePermission,
    maxConcurrent: Number.isInteger(maxConcurrentJobs) && maxConcurrentJobs > 0 ? maxConcurrentJobs : 2,
    availableAgents,
  });
  startScheduler(jobRunner);

  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (res.headersSent || res.writableEnded) return;
    // UI files are answered by createHttpServer's listener
    if (uiFileFor(req.method, req.url)) return;
    if (handleTokenBootstrap(req as unknown as IRequest, res as unknown as IResponse, token)) return;
    handleRequest(req as unknown as IRequest, res as unknown as IResponse, availableAgents, workspaceCwd, token, jobRunner);
  });

  process.on("exit", stopOpencode);
  process.on("exit", releaseRunOwnership);
  setupShutdown(() => {
    stopOpencode();
    releaseRunOwnership();
    server.close(() => process.exit(0));
  }, caffeinatePid);
}
