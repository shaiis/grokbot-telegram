import { configStatus } from "./config.js";
import type { AppDeps } from "./deps.js";
import { json, routePath } from "./http.js";
import { handleWebhook } from "./inbound.js";
import { handleMediaDownload, matchMediaPath } from "./media.js";
import { handleSend, handleTypingHeartbeat, handleTypingStop } from "./outbound.js";

export async function handleHealth(deps: AppDeps): Promise<Response> {
  const configured = configStatus(deps.config);
  const ready = Object.values(configured).every(Boolean) && deps.config.problems.length === 0;
  return json(200, {
    ok: true,
    service: "grokbot-telegram",
    ready,
    configured,
    // Setting names only, never values.
    problems: deps.config.problems,
  });
}

export async function handleRequest(request: Request, deps: AppDeps): Promise<Response> {
  try {
    return await route(request, deps);
  } catch (err) {
    // A store or upstream failure must not surface a platform error page or stack.
    deps.log({ event: "request_failed", error: err instanceof Error ? err.name : "error" });
    return json(500, { ok: false, error: "internal_error" });
  }
}

async function route(request: Request, deps: AppDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = routePath(url, deps.config.pathPrefix);
  const mediaId = matchMediaPath(path);
  if (mediaId) {
    if (request.method !== "GET") return json(405, { ok: false, error: "method_not_allowed" });
    return handleMediaDownload(request, deps, mediaId);
  }
  if (request.method === "GET" || request.method === "HEAD") {
    if (path === "/healthz") {
      const response = await handleHealth(deps);
      if (request.method === "HEAD") return new Response(null, { status: response.status, headers: response.headers });
      return response;
    }
  }
  if (request.method === "POST" && path === "/webhook") return handleWebhook(request, deps);
  if (request.method === "POST" && path === "/send") return handleSend(request, deps);
  if (request.method === "POST" && path === "/typing/stop") return handleTypingStop(request, deps);
  if (request.method === "POST" && path === "/typing/heartbeat") return handleTypingHeartbeat(request, deps);
  if (["/healthz", "/webhook", "/send", "/typing/stop", "/typing/heartbeat"].includes(path)) {
    return json(405, { ok: false, error: "method_not_allowed" });
  }
  return json(404, { ok: false, error: "not_found" });
}

export { handleSend, handleTypingHeartbeat, handleTypingStop, handleWebhook };
