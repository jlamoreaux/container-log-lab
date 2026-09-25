import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { runShellDemo } from "./shell-demo.mjs";
import { runOptInDemo } from "./opt-in-demo.mjs";
import { shutdownTracing } from "./tracing.mjs";

const port = Number(process.env.PORT ?? 8080);
const instanceId = process.env.CLOUDFLARE_DURABLE_OBJECT_ID ?? "local";
const tracer = trace.getTracer("container-log-lab");

function log(level, event, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(), level, layer: "container-process", instanceId, event,
    ...fields, message: fields.message ?? event.replaceAll("_", " "),
  };
  if (level === "error") console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
  return entry;
}

async function step(requestId, name, operation, recordDuration) {
  return tracer.startActiveSpan(name, { attributes: { "lab.request_id": requestId } }, async (span) => {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    try {
      return await operation();
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      recordDuration(Number((performance.now() - started).toFixed(1)), {
        name, startedAt, finishedAt: new Date().toISOString(),
        traceId: span.spanContext().traceId, spanId: span.spanContext().spanId,
      });
      span.end();
    }
  });
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && ["/", "/ping", "/ready"].includes(pathname)) {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  const scenario = pathname.split("/").pop();
  const requestId = request.headers["x-request-id"] ?? randomUUID();
  const started = Date.now();
  const parent = propagation.extract(context.active(), request.headers);
  const stepTimings = {};
  const events = [];
  const steps = [];
  const record = (level, event, fields) => {
    if (events.length < 16) events.push(log(level, event, fields));
    else log(level, event, fields);
  };

  return tracer.startActiveSpan("container.request", {
    kind: SpanKind.SERVER,
    attributes: { "lab.request_id": requestId, "lab.scenario": scenario, "lab.instance_id": instanceId },
  }, parent, async (span) => {
    const reply = (status, result) => {
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      const processMs = Date.now() - started;
      const traceId = span.isRecording() ? span.spanContext().traceId : undefined;
       record(status >= 500 ? "error" : "info", "request_finished", {
        requestId, scenario, status, processMs, ...(traceId ? { traceId } : {}),
      });
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
         "x-lab-process-ms": String(processMs),
         ...(stepTimings.phaseOneMs !== undefined ? { "x-lab-phase-one-ms": String(stepTimings.phaseOneMs) } : {}),
         ...(stepTimings.phaseTwoMs !== undefined ? { "x-lab-phase-two-ms": String(stepTimings.phaseTwoMs) } : {}),
         ...(traceId ? { "x-lab-otel-trace-id": traceId } : {}),
      });
       response.end(JSON.stringify({ requestId, scenario, ...result, events, steps }));
    };

    try {
      if (request.method !== "POST" || !["normal", "stdout", "stderr", "slow", "error", "journey", "shell", "opt-in"].includes(scenario) || pathname !== `/api/run/${scenario}`) {
        reply(404, { error: "Unknown scenario" });
        return;
      }

       record("info", "request_received", { requestId, scenario });

      switch (scenario) {
        case "stdout":
           record("info", "stdout_sample", { requestId, message: "An informational event on stdout" });
          break;
        case "stderr":
           record("error", "stderr_sample", { requestId, message: "A diagnostic event on stderr (request still succeeds)" });
          break;
        case "slow":
           record("info", "slow_work_started", { requestId });
          await step(requestId, "slow.phase_one", () => new Promise((resolve) => setTimeout(resolve, 750)),
             (durationMs, details) => { stepTimings.phaseOneMs = durationMs; steps.push({ ...details, durationMs }); });
          await step(requestId, "slow.phase_two", () => new Promise((resolve) => setTimeout(resolve, 1250)),
             (durationMs, details) => { stepTimings.phaseTwoMs = durationMs; steps.push({ ...details, durationMs }); });
           record("info", "slow_work_finished", { requestId });
           break;
        case "journey": {
          const activities = [
            ["journey.prepare", "Prepare sample orders", () =>
              Array.from({ length: 120 }, (_, index) => ({ id: index + 1, amount: (index % 9 + 1) * 10, active: index % 3 !== 0 }))],
            ["journey.filter", "Filter active orders", (orders) => orders.filter((order) => order.active)],
            ["journey.aggregate", "Aggregate order totals", (orders) => ({ count: orders.length, total: orders.reduce((sum, order) => sum + order.amount, 0) })],
            ["journey.enrich", "Simulate external enrichment", async (summary) => {
              await new Promise((resolve) => setTimeout(resolve, 350));
              return { ...summary, currency: "USD" };
            }],
            ["journey.checksum", "Calculate summary checksum", (summary) => ({
              ...summary, checksum: createHash("sha256").update(JSON.stringify(summary)).digest("hex").slice(0, 16),
            })],
          ];
          let result;
          for (const [name, label, operation] of activities) {
            record("info", "activity_started", { requestId, name, label });
            result = await step(requestId, name, async () => {
              const output = await operation(result);
              // Keep short in-process operations visible beside the simulated enrichment in a demo trace.
              if (name !== "journey.enrich") await new Promise((resolve) => setTimeout(resolve, 90));
              return output;
            }, (durationMs, details) => {
              steps.push({ ...details, label, durationMs });
            });
            record("info", "activity_finished", { requestId, name, label, durationMs: steps.at(-1).durationMs });
          }
          reply(200, { message: "Five activities completed in one request", summary: result });
          return;
        }
        case "shell": {
          const result = await runShellDemo(requestId, record, steps);
          reply(200, { message: "Five shell commands completed", ...result });
          return;
        }
        case "opt-in": {
          const result = await runOptInDemo(requestId, record, steps);
          reply(200, { message: "Four targeted CLI calls completed", ...result });
          return;
        }
        case "error":
           record("error", "handled_error", { requestId, message: "Intentional demo failure" });
          reply(500, { error: "Intentional demo failure" });
          return;
      }

      reply(200, { message: `${scenario} scenario completed` });
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (!response.headersSent) reply(500, { error: "Unexpected process failure" });
    } finally {
      span.end();
    }
  });
});

server.listen(port, "0.0.0.0", () => log("info", "process_started", { port: server.address().port, pid: process.pid }));

process.on("SIGTERM", () => {
  log("info", "sigterm_received", { pid: process.pid });
  server.close(async () => {
    await shutdownTracing();
    log("info", "process_stopped", { pid: process.pid });
    process.exit(0);
  });
});
