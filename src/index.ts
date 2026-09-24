import { env as bindings, tracing } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";
import { createApplicationTrace } from "./application-trace";

type Level = "info" | "error";
type RunEvent = { timestamp: string; level: Level; layer: string; event: string; [key: string]: unknown };

function log(level: Level, event: string, fields: Record<string, unknown>): RunEvent {
  const entry = { timestamp: new Date().toISOString(), level, layer: "worker", event, ...fields };
  if (level === "error") console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
  return entry;
}

function logController(level: Level, event: string, fields: Record<string, unknown>): RunEvent {
  const entry = { timestamp: new Date().toISOString(), level, layer: "container-controller", event, ...fields };
  if (level === "error") console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
  return entry;
}

export class LogLabContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "1m";
  private telemetry = bindings as Env & {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
    DD_API_KEY?: string;
  };
  envVars = {
    OTEL_SERVICE_NAME: "container-log-lab-process",
    ...(this.telemetry.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      ? { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: this.telemetry.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }
      : {}),
    ...(this.telemetry.DD_API_KEY
      ? { OTEL_EXPORTER_OTLP_TRACES_HEADERS: `dd-api-key=${this.telemetry.DD_API_KEY}` }
      : {}),
  };

  override async fetch(request: Request): Promise<Response> {
    const requestId = request.headers.get("x-request-id") ?? "missing";
    const instanceId = this.ctx.id.toString();
    const started = performance.now();
    const appTrace = createApplicationTrace(requestId, "container-log-lab-controller", request.headers.get("traceparent"));
    const events: RunEvent[] = [];
    const record = (level: Level, event: string, fields: Record<string, unknown>) => {
      events.push(logController(level, event, fields));
    };

    try {
      return await tracing.enterSpan("lab.container_controller", async (span) => appTrace.run("app.container_controller", appTrace.parentSpanId, {
        "lab.instance_id": instanceId,
      }, async (appSpan) => {
      span.setAttribute("lab.request_id", requestId);
      span.setAttribute("lab.instance_id", instanceId);
       record("info", "controller_request_received", { requestId, instanceId });

      try {
        const lookupStarted = performance.now();
        const state = await tracing.enterSpan("lab.read_container_state", () =>
          appTrace.run("app.read_container_state", appSpan.spanId, {}, () => this.getState()));
        const stateLookupMs = Math.round(performance.now() - lookupStarted);
        span.setAttribute("lab.state_before", state.status);
        record("info", "controller_state_checked", {
          requestId, instanceId, stateBefore: state.status, stateLookupMs,
        });

        // containerFetch normally performs startup implicitly. Split readiness out on
        // non-healthy runs so the cold-start wait can be measured independently.
        const readyStarted = performance.now();
        if (state.status !== "healthy") await this.startAndWaitForPorts({});
        const readyMs = Number((performance.now() - readyStarted).toFixed(1));
        span.setAttribute("lab.container.ready_ms", readyMs);
        record("info", "container_ready", { requestId, stateBefore: state.status, readyMs,
          readinessWaited: state.status !== "healthy" });

        let proxyMs = 0;
        const response = await tracing.enterSpan("lab.proxy_to_process", async (proxySpan) => appTrace.run(
          "app.proxy_to_process", appSpan.spanId, {}, async (processSpan) => {
          proxySpan.setAttribute("lab.request_id", requestId);
          const processHeaders = new Headers(request.headers);
          processHeaders.set("traceparent", processSpan.traceparent);
          const proxyStarted = performance.now();
          record("info", "process_proxy_started", { requestId });
          const result = await this.containerFetch(new Request(request, { headers: processHeaders }));
          proxyMs = Number((performance.now() - proxyStarted).toFixed(1));
          proxySpan.setAttribute("lab.container.proxy_ms", proxyMs);
          record("info", "process_proxy_completed", { requestId, proxyMs });
          processSpan.setAttribute("http.response.status_code", result.status);
          const phaseOneMs = Number(result.headers.get("x-lab-phase-one-ms"));
          const phaseTwoMs = Number(result.headers.get("x-lab-phase-two-ms"));
          if (result.headers.has("x-lab-phase-one-ms") && Number.isFinite(phaseOneMs) && phaseOneMs >= 0) {
            proxySpan.setAttribute("lab.container.phase_one_ms", phaseOneMs);
          }
          if (result.headers.has("x-lab-phase-two-ms") && Number.isFinite(phaseTwoMs) && phaseTwoMs >= 0) {
            proxySpan.setAttribute("lab.container.phase_two_ms", phaseTwoMs);
          }
          if (result.headers.has("x-lab-phase-one-ms") && result.headers.has("x-lab-phase-two-ms")) {
             record("info", "container_step_timings", { requestId, phaseOneMs, phaseTwoMs });
          }
          return result;
        }));
        const controllerMs = Math.round(performance.now() - started);
        span.setAttribute("lab.controller_ms", controllerMs);
        span.setAttribute("http.response.status_code", response.status);
        appSpan.setAttribute("http.response.status_code", response.status);
         record("info", "controller_response_received", {
          requestId, instanceId, stateBefore: state.status, stateLookupMs, controllerMs, status: response.status,
        });

        const headers = new Headers(response.headers);
        headers.set("x-lab-controller-ms", String(controllerMs));
        headers.set("x-lab-state-before", state.status);
        headers.set("x-lab-ready-ms", String(readyMs));
        headers.set("x-lab-proxy-ms", String(proxyMs));
        const processMs = Number(headers.get("x-lab-process-ms"));
        if (headers.has("x-lab-process-ms") && Number.isFinite(processMs) && processMs >= 0) {
          headers.set("x-lab-proxy-overhead-ms", String(Math.max(0, Number((proxyMs - processMs).toFixed(1)))));
        }
         headers.delete("content-length");
         const body = await response.json() as Record<string, unknown>;
         return Response.json({ ...body, controllerEvents: events }, { status: response.status, headers });
       } catch (error) {
         record("error", "controller_request_failed", {
          requestId, instanceId, controllerMs: Math.round(performance.now() - started), error: String(error),
        });
        throw error;
      }
      }));
    } finally {
      appTrace.exportSpans(this.ctx, this.telemetry.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, this.telemetry.DD_API_KEY);
    }
  }

  override onStart() {
    logController("info", "started", { instanceId: this.ctx.id.toString() });
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }) {
    logController("info", "stopped", { instanceId: this.ctx.id.toString(), exitCode, reason });
  }

  override onError(error: unknown) {
    logController("error", "startup_error", { instanceId: this.ctx.id.toString(), error: String(error) });
    throw error;
  }

  override async onActivityExpired(): Promise<void> {
    logController("info", "idle_timeout", { instanceId: this.ctx.id.toString() });
    await this.stop();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const runMatch = /^\/api\/runs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (runMatch) {
      if (request.method !== "GET") return Response.json({ error: "Use GET" }, { status: 405, headers: { Allow: "GET" } });
      const [run, timing] = await Promise.all([
        env.RUNS.get(`run:${runMatch[1]}`), env.RUNS.get(`run-timing:${runMatch[1]}`),
      ]);
      if (!run) return Response.json({ error: "Run not found or expired" }, { status: 404, headers: { "cache-control": "no-store" } });
      const snapshot = JSON.parse(run) as { metrics: Record<string, unknown>; events: RunEvent[] };
      if (timing) {
        const { kvWriteMs, timestamp } = JSON.parse(timing) as { kvWriteMs: number; timestamp: string };
        snapshot.metrics.kvWriteMs = kvWriteMs;
        snapshot.events.push({ timestamp, level: "info", layer: "worker", event: "run_snapshot_written",
          requestId: runMatch[1], kvWriteMs });
        snapshot.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      }
      return Response.json(snapshot, { headers: { "cache-control": "no-store" } });
    }
    if (/^\/runs\/[0-9a-f-]{36}$/.test(url.pathname)) {
      return env.ASSETS.fetch(new URL("/run.html", url));
    }
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    const match = /^\/api\/run\/(normal|stdout|stderr|slow|error|journey)$/.exec(url.pathname);
    if (!match) return Response.json({ error: "Unknown scenario" }, { status: 404 });
    if (request.method !== "POST") {
      return Response.json({ error: "Use POST" }, { status: 405, headers: { Allow: "POST" } });
    }

    const scenario = match[1];
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const telemetry = env as Env & { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string; DD_API_KEY?: string };
    const appTrace = createApplicationTrace(requestId, "container-log-lab-worker", request.headers.get("traceparent"));
    const events: RunEvent[] = [];
    const record = (level: Level, event: string, fields: Record<string, unknown>) => {
      events.push(log(level, event, fields));
    };
    const persist = async (status: number, metrics: Record<string, string | null>, process: Record<string, unknown> = {}) => {
      const processEvents = Array.isArray(process.events) ? process.events.slice(0, 16) : [];
      const controllerEvents = Array.isArray(process.controllerEvents) ? process.controllerEvents.slice(0, 8) : [];
       const steps = Array.isArray(process.steps) ? process.steps.slice(0, 5) : [];
      const snapshot = {
        requestId, scenario, status, startedAt, finishedAt: new Date().toISOString(),
        appTraceId: appTrace.traceId, otelTraceId: metrics.otelTraceId,
        metrics, steps,
        events: [...events, ...controllerEvents, ...processEvents]
          .filter((item): item is RunEvent => typeof item === "object" && item !== null && typeof item.timestamp === "string")
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      };
      try {
        const writeStarted = performance.now();
        await env.RUNS.put(`run:${requestId}`, JSON.stringify(snapshot), { expirationTtl: 86400 });
        const kvWriteMs = Number((performance.now() - writeStarted).toFixed(1));
        const timestamp = new Date().toISOString();
        try {
          await env.RUNS.put(`run-timing:${requestId}`, JSON.stringify({ kvWriteMs, timestamp }), { expirationTtl: 86400 });
        } catch (error) {
          log("error", "run_timing_store_failed", { requestId, error: String(error) });
        }
        return { url: `/runs/${requestId}`, kvWriteMs };
      } catch (error) {
        log("error", "run_store_failed", { requestId, error: String(error) });
        return null;
      }
    };

    try {
      return await tracing.enterSpan("lab.edge_request", async (span) => appTrace.run("app.edge_request", appTrace.parentSpanId, {
        "lab.scenario": scenario,
      }, async (appSpan) => {
      span.setAttribute("lab.request_id", requestId);
      span.setAttribute("lab.scenario", scenario);
       record("info", "request_started", { requestId, scenario });

      try {
        const forwardedHeaders = new Headers({ "x-request-id": requestId });
        forwardedHeaders.set("traceparent", appSpan.traceparent);
        const tracestate = request.headers.get("tracestate");
        if (tracestate) forwardedHeaders.set("tracestate", tracestate);
        const forwarded = new Request(new URL(url.pathname, "http://localhost"), {
          method: "POST",
          headers: forwardedHeaders,
        });
        const response = await tracing.enterSpan("lab.forward_to_container", async (forwardSpan) => appTrace.run(
          "app.forward_to_container", appSpan.spanId, {}, async (forwardAppSpan) => {
          forwardSpan.setAttribute("lab.request_id", requestId);
          const forwardedRequest = new Request(forwarded, { headers: new Headers(forwarded.headers) });
          forwardedRequest.headers.set("traceparent", forwardAppSpan.traceparent);
          const result = await getContainer(env.LOG_LAB, "lab").fetch(forwardedRequest);
          forwardAppSpan.setAttribute("http.response.status_code", result.status);
          return result;
        }));
        const edgeMs = Math.round(performance.now() - started);
        span.setAttribute("lab.edge_ms", edgeMs);
        span.setAttribute("http.response.status_code", response.status);
        appSpan.setAttribute("http.response.status_code", response.status);
         record(response.ok ? "info" : "error", "request_finished", {
          requestId, scenario, status: response.status, edgeMs,
           controllerMs: response.headers.get("x-lab-controller-ms"),
           processMs: response.headers.get("x-lab-process-ms"),
           otelTraceId: response.headers.get("x-lab-otel-trace-id"),
           stateBefore: response.headers.get("x-lab-state-before"),
        });
        const headers = new Headers(response.headers);
        headers.set("x-request-id", requestId);
        headers.set("x-lab-app-trace-id", appTrace.traceId);
         headers.set("x-lab-edge-ms", String(edgeMs));
         headers.set("cache-control", "no-store");
         headers.delete("content-length");
         const body = await response.json() as Record<string, unknown>;
          const metrics = {
            edgeMs: String(edgeMs), controllerMs: headers.get("x-lab-controller-ms"),
            processMs: headers.get("x-lab-process-ms"), stateBefore: headers.get("x-lab-state-before"),
            readyMs: headers.get("x-lab-ready-ms"), proxyMs: headers.get("x-lab-proxy-ms"),
            proxyOverheadMs: headers.get("x-lab-proxy-overhead-ms"),
            phaseOneMs: headers.get("x-lab-phase-one-ms"), phaseTwoMs: headers.get("x-lab-phase-two-ms"),
            otelTraceId: headers.get("x-lab-otel-trace-id"),
          };
          const saved = await persist(response.status, metrics, body);
          if (saved) {
            headers.set("x-lab-run-url", saved.url);
            headers.set("x-lab-kv-write-ms", String(saved.kvWriteMs));
          }
          headers.set("x-lab-worker-ms", String(Math.round(performance.now() - started)));
          const { events: _events, controllerEvents: _controllerEvents, steps: _steps, ...result } = body;
         return Response.json(result, { status: response.status, headers });
       } catch (error) {
         const edgeMs = Math.round(performance.now() - started);
         record("error", "container_unavailable", { requestId, scenario, edgeMs, error: String(error) });
         appSpan.setAttribute("http.response.status_code", 502);
          const saved = await persist(502, { edgeMs: String(edgeMs), controllerMs: null, processMs: null,
            stateBefore: null, readyMs: null, proxyMs: null, proxyOverheadMs: null,
            phaseOneMs: null, phaseTwoMs: null, otelTraceId: null });
          return Response.json(
            { requestId, scenario, error: "Container unavailable; check lifecycle and process logs." },
            { status: 502, headers: { "x-request-id": requestId, "x-lab-app-trace-id": appTrace.traceId,
              "x-lab-edge-ms": String(edgeMs), "x-lab-worker-ms": String(Math.round(performance.now() - started)),
              "cache-control": "no-store", ...(saved ? { "x-lab-run-url": saved.url, "x-lab-kv-write-ms": String(saved.kvWriteMs) } : {}) } },
        );
      }
      }));
    } finally {
      appTrace.exportSpans(ctx, telemetry.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, telemetry.DD_API_KEY);
    }
  },
} satisfies ExportedHandler<Env>;
