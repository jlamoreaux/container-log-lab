import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { ExportResultCode } from "@opentelemetry/core";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";

// A compact, line-oriented exporter for the Containers log viewer.
class LogSpanExporter {
  export(spans, done) {
    try {
      for (const span of spans) {
        const durationMs = span.duration[0] * 1000 + span.duration[1] / 1e6;
        console.log(JSON.stringify({
          message: `${span.name} completed in ${durationMs.toFixed(1)} ms`,
          event: "otel_span",
          layer: "container-process",
          requestId: span.attributes["lab.request_id"],
          spanName: span.name,
          durationMs: Math.round(durationMs * 10) / 10,
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          parentSpanId: span.parentSpanContext?.spanId ?? null,
        }));
      }
      done({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      done({ code: ExportResultCode.FAILED, error });
    }
  }

  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}

// An OTLP endpoint switches the lab from immediate console output to batched export.
// The exporter reads its endpoint and optional headers from OTEL_* environment variables.
const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "container-log-lab-process",
  ...(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    ? { traceExporter: new OTLPTraceExporter() }
    : { spanProcessors: [new SimpleSpanProcessor(new LogSpanExporter())] }),
});

sdk.start();

export async function shutdownTracing() {
  await sdk.shutdown();
}
