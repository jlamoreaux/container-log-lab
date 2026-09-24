import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createApplicationTrace } from "../src/application-trace.ts";

test("application spans propagate a real parent ID and export OTLP JSON", async () => {
  const requests = [];
  const collector = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ headers: request.headers, payload: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(202);
    response.end();
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  try {
    const traceId = "0123456789abcdef0123456789abcdef";
    const upstreamId = "fedcba9876543210";
    const edge = createApplicationTrace("test-id", "lab-worker", `00-${traceId}-${upstreamId}-01`);
    let childTraceparent;
    await edge.run("app.edge_request", edge.parentSpanId, { "lab.scenario": "slow" }, async (root) => {
      assert.equal(root.traceparent.slice(3, 35), traceId);
      await edge.run("app.forward_to_container", root.spanId, {}, async (child) => {
        childTraceparent = child.traceparent;
        child.setAttribute("http.response.status_code", 200);
      });
    }, 2);
    const controller = createApplicationTrace("test-id", "lab-controller", childTraceparent);
    await controller.run("app.container_controller", controller.parentSpanId, {}, async (span) => {
      assert.equal(span.traceparent.slice(3, 35), traceId);
      assert.equal(controller.parentSpanId, childTraceparent.slice(36, 52));
    });

    const pending = [];
    const ctx = { waitUntil(promise) { pending.push(promise); } };
    const endpoint = `http://127.0.0.1:${collector.address().port}/v1/traces`;
    edge.exportSpans(ctx, endpoint, "test-key");
    controller.exportSpans(ctx, endpoint, "test-key");
    await Promise.all(pending);

    assert.equal(requests.length, 2);
    assert.ok(requests.every((entry) => entry.headers["content-type"] === "application/json" && entry.headers["dd-api-key"] === "test-key"));
    const spans = requests.flatMap((entry) => entry.payload.resourceSpans[0].scopeSpans[0].spans);
    const root = spans.find((span) => span.name === "app.edge_request");
    const forward = spans.find((span) => span.name === "app.forward_to_container");
    const doSpan = spans.find((span) => span.name === "app.container_controller");
    assert.equal(root.parentSpanId, upstreamId);
    assert.equal(forward.parentSpanId, root.spanId);
    assert.equal(doSpan.parentSpanId, forward.spanId);
    assert.ok(spans.every((span) => span.traceId === traceId &&
      BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)));
  } finally {
    collector.close();
  }
});
