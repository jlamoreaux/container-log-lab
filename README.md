# Container Log Lab

A small Cloudflare Worker + Container demo for investigating logs and traces. The page runs six scenarios against one container instance and displays each request ID so you can find corresponding events in Cloudflare Observability.

## Run it

Requires Node.js, a running Docker-compatible engine, and (for deployment) a Cloudflare Workers Paid account.

```sh
npm install
npm run typegen
npm run check
npm run dev
```

If your local npm configuration routes `@cloudflare` packages through an unavailable private registry, install with `npm install '--@cloudflare:registry=https://registry.npmjs.org'` instead.

Open the local URL printed by Wrangler (usually `http://localhost:8787`). Wrangler starts the container when the first test runs; the initial request may be slower than subsequent requests. Worker and controller logs print to the development terminal. Wrangler also prints a Local Explorer API URL for querying captured local traces and Worker logs. For **container process** stdout/stderr locally, run `docker ps` to find the `workerd-container-log-lab-LogLabContainer-...` container, then `docker logs <container-name>` while it is running. In production, use the Containers dashboard instead.

To deploy to an account you have selected:

```sh
npm run deploy
```

The first deployment may need a few minutes for container provisioning before test requests succeed.

The `RUNS` KV namespace ID in `wrangler.jsonc` belongs to the original deployment. To deploy into another account, create your own namespace with `npx wrangler kv namespace create RUNS` and replace that ID with the one returned by Wrangler. The ID is a resource identifier, not an API credential.

## What to look for

| Scenario | Expected response | Notable process log |
| --- | --- | --- |
| Normal | 200 | `request_received`, `request_finished` |
| Stdout | 200 | `stdout_sample` on stdout |
| Stderr | 200 | `stderr_sample` on stderr |
| Slow | 200 after ~2 seconds | `slow_work_started`, `slow_work_finished` |
| Handled error | 500 | `handled_error` on stderr |
| Five-activity journey | 200 after ~700 ms | Five `activity_started`/`activity_finished` pairs in one request |

Each response includes an `x-request-id` header and JSON `requestId`. Search for that ID in the Worker and container logs. Worker events have `layer: "worker"`; lifecycle hooks and proxy timing have `layer: "container-controller"`; logs emitted inside the image have `layer: "container-process"`. Controller and process logs also include the same Durable Object instance ID (`instanceId`). The container writes `process_started` and, on graceful shutdown, `sigterm_received` / `process_stopped`. With `sleepAfter: "1m"`, waiting idle for roughly a minute and sending another request gives you a lifecycle comparison. Startup and shutdown events have no request ID because they are instance-level events.

Every scenario also stores one bounded, request-scoped snapshot in the `RUNS` KV namespace for **24 hours**. Follow the activity list's **View timeline + logs** link or open `/runs/<request-id>`; the response includes `x-lab-run-url` when the write succeeds. `/api/runs/<request-id>` returns the snapshot as JSON. The page shows captured Worker, controller and process events, measured nested durations, and the two actual process step timings for Slow or five for Journey. These are explicitly collected by the application during that request; they are not a query over all Cloudflare logs or a Cloudflare-native trace. Lifecycle logs and asynchronous span-export logs are available in their respective log streams, not in the snapshot. KV is eventually consistent across locations, so the run page briefly retries a fresh 404 before showing an expired/not-found message. If KV is unavailable, the scenario still returns its result but omits the run link.

The controller explicitly waits for the container's port if `getState()` is not `healthy`. `x-lab-ready-ms` measures this wait (zero for an already healthy container); `x-lab-proxy-ms` measures the subsequent `containerFetch` round-trip. `x-lab-proxy-overhead-ms` is that round-trip minus Node's `x-lab-process-ms`, and includes transport and response handling. This separates a cold-start readiness wait from proxy overhead rather than attributing the entire controller/process gap to startup. Run Slow twice in quick succession to compare a stopped and healthy instance. The Worker also returns `x-lab-kv-write-ms` for the first KV snapshot write and `x-lab-worker-ms` for its handler through response preparation. These occur **after** the older `x-lab-edge-ms` measurement. The run page reads the KV duration from a second, small timing key: KV permits only one write per second to any single key, so the first snapshot cannot be updated immediately. The second write also contributes to handler time; none of these timings measure downstream network time to the browser.

## Diagnosing a long span

The activity list and response headers show `x-lab-edge-ms`, `x-lab-controller-ms`, `x-lab-process-ms`, and `x-lab-state-before` (`stopped` for a cold start or `healthy` for a warm request). These measurements are **nested, not additive**: edge includes controller, and controller includes process. All logs include ISO timestamps; compare `request_started`, `controller_request_received`, `controller_state_checked`, `controller_response_received`, and the process's `request_received` / `request_finished` to find the gap. Lifecycle events (`started`, `idle_timeout`, `stopped`) show whether work continued after the HTTP response.

Cloudflare traces now include custom `lab.edge_request`, `lab.forward_to_container`, `lab.container_controller`, `lab.read_container_state`, and `lab.proxy_to_process` spans. The request ID is attached as `lab.request_id` on these spans. Worker traces do not automatically instrument code inside the Node.js container; correlate those logs using the request ID and `instanceId`. If a platform-generated Durable Object handler span remains open after its parent request has finished, **do not treat its wall time as user-visible request latency** without comparing these app-level timings and events first.

For **Slow**, the process returns measured `x-lab-phase-one-ms` and `x-lab-phase-two-ms` headers. The controller adds these as `lab.container.phase_one_ms` and `lab.container.phase_two_ms` attributes on its `lab.proxy_to_process` span, and emits a `container_step_timings` Worker log inside that span. Open that span's details in the Cloudflare trace to see the two durations and its associated log. These measurements come from the container; they are **not** separate child bars in the Cloudflare waterfall.

The lab's activity list also shows a two-color phase bar for Slow, scaled to the process time. Read `edge → controller → process` as progressively narrower nested durations (do not add them together), then read the two colored steps within `process`. The run page aligns measured timestamps and durations, but for the full span parent-child waterfall across all three layers, inspect the application-owned OpenTelemetry trace in an OTLP backend. It is distinct from Cloudflare's native trace.

For a single-request, five-activity demo, run **Five-activity journey**. Node prepares 120 sample orders, filters active orders, aggregates totals, simulates a 350 ms external enrichment, then computes a SHA-256 summary checksum. The short in-process operations each have a 90 ms demo pause to make their spans legible. Each activity emits start/finish logs and a child OTel span under the same `container.request` parent, using the same request ID and app trace ID through all three layers. The run detail displays all five activities as individual timeline lanes. The enrichment is simulated; no external service is contacted.

## Trace steps inside the container with Datadog

The Worker starts an application-owned `app.edge_request` span and passes its W3C `traceparent` to the Durable Object. The controller creates `app.container_controller` and `app.proxy_to_process` spans, then passes the proxy span's context to Node.js. Node creates a real `container.request` child span with `slow.phase_one` (~750 ms) and `slow.phase_two` (~1,250 ms) children. `app.forward_to_container` and `app.read_container_state` mark the intervening steps. Every span carries `lab.request_id`, and `x-lab-app-trace-id` equals `x-lab-otel-trace-id` on a successful container response. The activity list shows the shared trace ID. This demonstrates instrumenting real application stages; replace the two timers with your actual steps.

**No setup required for the POC:** without an OTLP endpoint, a compact OpenTelemetry exporter prints **one JSON log entry per completed span** to container stdout. Its top-level `message` reads, for example, `slow.phase_two completed in 1251.2 ms`; `requestId`, `durationMs`, `traceId`, `spanId`, and `parentSpanId` are separate metadata fields. Application-owned Worker/controller spans are also logged as `app_span` with trace, span, and parent IDs. In the [Containers dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers), open the `container-log-lab-loglabcontainer` application's logs, run **Slow**, and search for its request ID or `otel_span`. Other process events also set `message` so they have readable rows. Locally, `docker logs <container-name>` shows the same output. These console records are separate from the Cloudflare Worker trace waterfall.

To send those spans to Datadog instead of stdout, set these **Worker secrets** in the account where you deploy (Wrangler prompts for the values):

```sh
npx wrangler secret put OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
npx wrangler secret put DD_API_KEY
```

For the first secret, enter the Datadog endpoint for your site, `https://cloudflare.integrations.otlp.<YOUR_DATADOG_SITE>/v1/traces`. For the second, enter your Datadog API key. The Worker and controller export request-scoped OTLP/HTTP JSON with a `dd-api-key` header. The Worker also passes these values to the container at startup as `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS=dd-api-key=...`; Node exports OTLP/HTTP protobuf to the same endpoint. No credentials are baked into the image. Restart the container after changing these values so its environment takes effect. Search Datadog APM by the activity list's app trace ID to see services `container-log-lab-worker`, `container-log-lab-controller`, and `container-log-lab-process` together; all spans also have `lab.request_id`.

If your organization already has an OTLP Collector or Datadog Agent, point the endpoint at its OTLP/HTTP **traces** URL instead and use the headers it requires. The lab currently supports the Datadog API-key header when `DD_API_KEY` is set.

To export the *native Cloudflare* spans to Datadog as well, configure a [Workers Observability traces destination](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) and add its name to `observability.traces.destinations` in `wrangler.jsonc`. Native spans will remain a separate trace because Cloudflare's tracing API does not expose its span context for manually parenting the Node spans. The application-owned trace instead supplies its own context across the Worker → controller → container boundary. If an upstream caller sends a valid W3C `traceparent`, the application-owned edge span continues it. This does **not** join the native Cloudflare trace.

The Worker config enables Cloudflare observability with **100% log sampling and 100% trace sampling**. In the [Containers dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers), inspect container process logs and live tailing. In Worker Observability, inspect Worker logs and traces; the slow scenario makes the request duration particularly easy to identify.

See the [Containers logging FAQ](https://developers.cloudflare.com/containers/faq/#how-do-container-logs-work) and [Workers Observability documentation](https://developers.cloudflare.com/workers/observability/) for platform details.
