# Container Log Lab

A **proof of concept for logging individual events inside a Cloudflare Container** and correlating them with the Worker request that triggered them. The web page runs seven demo scenarios against one container. **Shell steps** demonstrates logging each command in a single multi-command job.

## Start with the logging code

- [`container/server.mjs`](container/server.mjs): `log()` writes one structured JSON object per line to stdout or stderr. The `record()` wrapper also captures a small number of those events for the demo page. Look at the `journey` case for five named activities, each logged with `requestId`, `name`, and `label`.
- [`container/shell-steps.sh`](container/shell-steps.sh): a small Bash `run_step` wrapper around five mock CLI-style commands; their stdout goes to temporary files while start/finish markers remain visible on stderr.
- [`container/shell-demo.mjs`](container/shell-demo.mjs): starts the script, converts those markers into structured, request-correlated container logs, and measures each command. The shell steps are log-derived intervals, not individual OTel spans.
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

Open the local URL Wrangler prints, click **Shell steps**, then **View timeline + logs** to see each command's start, finish, and duration without grepping Bash. Worker/controller logs appear in the Wrangler terminal; use `docker ps` and `docker logs <container-name>` to inspect the container process locally. In production, use the [Containers dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers) for container logs.

For deployment, a Cloudflare Workers Paid account is required. The `RUNS` KV namespace ID in [`wrangler.jsonc`](wrangler.jsonc) belongs to the original deployment: create your own with `npx wrangler kv namespace create RUNS`, replace the ID, then run `npm run deploy`.

The **View timeline + logs** link shows a bounded, request-scoped copy of captured events stored in KV for 24 hours; it is **not** a query of Cloudflare logs. The synthetic activities, 100% observability sampling, and KV snapshot are for demonstration rather than production defaults.
