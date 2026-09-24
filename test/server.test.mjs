import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

test("container process emits correlated logs, responses, and OTLP step spans", async () => {
  const exports = [];
  const collector = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    exports.push({ path: request.url, headers: request.headers, payload: Buffer.concat(chunks) });
    response.writeHead(200);
    response.end();
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  const child = spawn(process.execPath, ["container/server.mjs"], {
    env: {
      ...process.env,
      PORT: "0",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${collector.address().port}/v1/traces`,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "dd-api-key=lab-test-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let port;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const stdoutLines = { value: "" };
  const stderrLines = { value: "" };

  function collect(chunk, pending, events, onEvent = () => {}) {
    pending.value += chunk;
    let newline;
    while ((newline = pending.value.indexOf("\n")) !== -1) {
      const line = pending.value.slice(0, newline);
      pending.value = pending.value.slice(newline + 1);
      if (line) {
        const event = JSON.parse(line);
        events.push(event);
        onEvent(event);
      }
    }
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => collect(chunk, stdoutLines, stdout, (event) => {
    if (event.event === "process_started") { port = event.port; ready(); }
  }));
  child.stderr.on("data", (chunk) => collect(chunk, stderrLines, stderr));

  try {
    await Promise.race([started, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not start")), 5000);
      timer.unref();
    })]);
    const run = async (scenario, id, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/run/${scenario}`, { method: "POST", headers: { "x-request-id": id, ...headers } });
      const body = await response.json();
      assert.equal(body.requestId, id);
      assert.match(response.headers.get("x-lab-process-ms"), /^\d+$/);
       return { response, body };
    };

    assert.equal((await fetch(`http://127.0.0.1:${port}/ping`)).status, 200);
     const stdoutRun = await run("stdout", "stdout-id");
     assert.equal(stdoutRun.response.status, 200);
     assert.ok(stdoutRun.body.events.some((event) => event.event === "stdout_sample" && event.level === "info"));
     const stderrRun = await run("stderr", "stderr-id");
     assert.equal(stderrRun.response.status, 200);
     assert.ok(stderrRun.body.events.some((event) => event.event === "stderr_sample" && event.level === "error"));
    const slowStarted = Date.now();
    const parentTraceId = "0123456789abcdef0123456789abcdef";
    const parentSpanId = "fedcba9876543210";
     const slowRun = await run("slow", "slow-id", {
       traceparent: `00-${parentTraceId}-${parentSpanId}-01`,
     });
     const slowResponse = slowRun.response;
     assert.equal(slowResponse.status, 200);
     assert.deepEqual(slowRun.body.steps.map((step) => step.name), ["slow.phase_one", "slow.phase_two"]);
     assert.ok(slowRun.body.steps.every((step) => step.traceId === parentTraceId && step.durationMs > 0 && step.startedAt < step.finishedAt));
    assert.equal(slowResponse.headers.get("x-lab-otel-trace-id"), parentTraceId);
    assert.ok(Number(slowResponse.headers.get("x-lab-phase-one-ms")) >= 700);
     assert.ok(Number(slowResponse.headers.get("x-lab-phase-two-ms")) >= 1200);
     assert.ok(Date.now() - slowStarted >= 1900);
     const journeyRun = await run("journey", "journey-id", {
       traceparent: `00-${parentTraceId}-${parentSpanId}-01`,
     });
     assert.equal(journeyRun.response.status, 200);
     assert.equal(journeyRun.response.headers.get("x-lab-otel-trace-id"), parentTraceId);
     assert.deepEqual(journeyRun.body.steps.map((activity) => activity.name), [
       "journey.prepare", "journey.filter", "journey.aggregate", "journey.enrich", "journey.checksum",
     ]);
     assert.ok(journeyRun.body.steps.every((activity) => activity.traceId === parentTraceId && activity.spanId && activity.label && activity.durationMs >= 80));
     assert.ok(journeyRun.body.steps[3].durationMs >= 300);
     assert.equal(journeyRun.body.summary.count, 80);
     assert.equal(journeyRun.body.summary.currency, "USD");
     assert.match(journeyRun.body.summary.checksum, /^[0-9a-f]{16}$/);
     assert.equal(journeyRun.body.events.filter((event) => event.event === "activity_started").length, 5);
     assert.equal(journeyRun.body.events.filter((event) => event.event === "activity_finished").length, 5);
     assert.ok(journeyRun.body.events.every((event) => event.requestId === "journey-id"));
     const errorRun = await run("error", "error-id");
     assert.equal(errorRun.response.status, 500);
     assert.ok(errorRun.body.events.some((event) => event.event === "handled_error"));
    assert.ok(stdout.some((event) => event.event === "stdout_sample" && event.requestId === "stdout-id"));
    assert.ok(stderr.some((event) => event.event === "stderr_sample" && event.requestId === "stderr-id"));
    assert.ok(stderr.some((event) => event.event === "handled_error" && event.requestId === "error-id"));
    assert.ok(stdout.some((event) => event.event === "slow_work_finished" && event.requestId === "slow-id"));
    assert.equal(stdout.filter((event) => event.event === "request_finished" && event.status === 404).length, 0);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    collector.close();
  }
  assert.ok(stdout.some((event) => event.event === "sigterm_received"));
  assert.ok(stdout.some((event) => event.event === "process_stopped"));
  assert.ok(exports.some((entry) => entry.path === "/v1/traces" && entry.headers["dd-api-key"] === "lab-test-key"));
  const spans = Buffer.concat(exports.map((entry) => entry.payload)).toString("utf8");
   for (const name of ["container.request", "slow.phase_one", "slow.phase_two", "slow-id",
     "journey.prepare", "journey.filter", "journey.aggregate", "journey.enrich", "journey.checksum", "journey-id"]) {
    assert.ok(spans.includes(name), `OTLP payload should contain ${name}`);
  }
  assert.ok(exports.some((entry) => entry.payload.includes(Buffer.from("0123456789abcdef0123456789abcdef", "hex"))),
    "container spans should continue a valid upstream traceparent");
  assert.ok(exports.some((entry) => entry.payload.includes(Buffer.from("fedcba9876543210", "hex"))),
    "container.request should preserve the application proxy span as its parent");
});

test("container prints readable messages with separate span metadata without an OTLP endpoint", async () => {
  const child = spawn(process.execPath, ["container/server.mjs"], {
    env: {
      ...process.env,
      PORT: "0",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const port = /"event":"process_started","port":(\d+)/.exec(stdout)?.[1];
      if (port) resolve(Number(port));
    });
  });
  try {
    const port = await Promise.race([ready, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 5000);
      timer.unref();
    })]);
    const response = await fetch(`http://127.0.0.1:${port}/api/run/slow`, {
      method: "POST", headers: { "x-request-id": "console-id" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-lab-otel-trace-id"), /^[0-9a-f]{32}$/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.every((event) => typeof event.message === "string" && event.message.length > 0));
  const spans = events.filter((event) => event.event === "otel_span");
  assert.deepEqual(spans.map((span) => span.spanName), ["slow.phase_one", "slow.phase_two", "container.request"]);
  assert.ok(spans.every((span) => span.requestId === "console-id" && span.traceId === spans[0].traceId));
  assert.ok(spans.every((span) => span.message === `${span.spanName} completed in ${span.durationMs.toFixed(1)} ms`));
  assert.ok(spans.slice(0, 2).every((span) => span.parentSpanId === spans[2].spanId));
  assert.ok(spans[0].durationMs >= 700 && spans[1].durationMs >= 1200);
  assert.ok(spans[2].durationMs >= 1900 && spans[2].durationMs < 3000);
});
