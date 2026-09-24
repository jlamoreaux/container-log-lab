# Container Log Lab

A **proof of concept for logging individual events inside a Cloudflare Container** and correlating them with the Worker request that triggered them. The web page runs six demo scenarios against one container; **Five-activity journey** emits five pairs of start/finish events during a single request.

## Start with the logging code

- [`container/server.mjs`](container/server.mjs): `log()` writes one structured JSON object per line to stdout or stderr. The `record()` wrapper also captures a small number of those events for the demo page. Look at the `journey` case for five named activities, each logged with `requestId`, `name`, and `label`.
- [`container/tracing.mjs`](container/tracing.mjs): `LogSpanExporter` prints completed OpenTelemetry spans as readable JSON log entries **when no OTLP endpoint is configured**. If an endpoint is configured, spans are exported there instead; ordinary event logs in `server.mjs` still go to stdout/stderr.
- [`src/index.ts`](src/index.ts): `log()` and `logController()` write Worker and container-controller events. The Worker creates `x-request-id` and forwards it to the container; search that ID to correlate events across all three layers.
- [`src/application-trace.ts`](src/application-trace.ts): optional application-owned trace propagation and export, separate from ordinary event logging.

Process events include a timestamp, severity (`level`), `layer: "container-process"`, `event`, readable `message`, and an `instanceId`. Request events also carry `requestId`; lifecycle events such as `process_started` do not belong to any request. **Stderr event** demonstrates an error-level diagnostic without failing the HTTP request; **Handled error** returns an intentional HTTP 500.

## Run the POC

Requires Node.js and Docker (or another Docker-compatible engine):

```sh
npm install
npm run typegen
npm run check
npm run dev
```

Open the local URL Wrangler prints, click **Five-activity journey**, and search the displayed request ID in the logs. Worker/controller logs appear in the Wrangler terminal; use `docker ps` and `docker logs <container-name>` to inspect the container process locally. In production, use the [Containers dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers) for container logs.

For deployment, a Cloudflare Workers Paid account is required. The `RUNS` KV namespace ID in [`wrangler.jsonc`](wrangler.jsonc) belongs to the original deployment: create your own with `npx wrangler kv namespace create RUNS`, replace the ID, then run `npm run deploy`.

The **View timeline + logs** link shows a bounded, request-scoped copy of captured events stored in KV for 24 hours; it is **not** a query of Cloudflare logs. The synthetic activities, 100% observability sampling, and KV snapshot are for demonstration rather than production defaults.
