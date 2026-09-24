// Request-scoped OTel spans: explicit parents allow propagation across the Worker,
// Durable Object, and Node process without relying on Cloudflare's native span IDs.
type Attributes = Record<string, string | number | boolean>;

type RecordedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attributes;
};

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function randomHex(byteCount: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(byteCount)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createApplicationTrace(requestId: string, serviceName: string, incomingTraceparent?: string | null) {
  const match = incomingTraceparent?.match(traceparentPattern);
  const traceId = match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2]) ? match[1].toLowerCase() : randomHex(16);
  const parentSpanId = traceId === match?.[1].toLowerCase() ? match[2].toLowerCase() : undefined;
  const spans: RecordedSpan[] = [];
  const wallClockStartNs = BigInt(Date.now()) * 1_000_000n;
  const monotonicStartMs = performance.now();
  const timestamp = () => (wallClockStartNs + BigInt(Math.round((performance.now() - monotonicStartMs) * 1_000_000))).toString();

  async function run<T>(name: string, parentId: string | undefined, attributes: Attributes, action: (span: {
    spanId: string;
    traceparent: string;
    setAttribute: (key: string, value: string | number | boolean) => void;
  }) => Promise<T>, kind = 1): Promise<T> {
    const spanId = randomHex(8);
    const startTimeUnixNano = timestamp();
    const fields: Attributes = { "lab.request_id": requestId, ...attributes };
    let failed: unknown;
    try {
      return await action({
        spanId,
        traceparent: `00-${traceId}-${spanId}-01`,
        setAttribute(key, value) { fields[key] = value; },
      });
    } catch (error) {
      failed = error;
      throw error;
    } finally {
      const record = { traceId, spanId, parentSpanId: parentId, name, kind,
        startTimeUnixNano, endTimeUnixNano: timestamp(), attributes: fields };
      spans.push(record);
      console.log(JSON.stringify({ event: "app_span", message: `${name} completed`, layer: serviceName,
        requestId, traceId, spanId, parentSpanId: parentId ?? null, ...(failed ? { error: String(failed) } : {}) }));
    }
  }

  function exportSpans(ctx: Pick<ExecutionContext, "waitUntil">, endpoint?: string, apiKey?: string) {
    if (!endpoint || !spans.length) return;
    const payload = { resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{ scope: { name: "container-log-lab" }, spans: spans.map((span) => ({
        traceId: span.traceId, spanId: span.spanId, ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
        name: span.name, kind: span.kind,
        startTimeUnixNano: span.startTimeUnixNano, endTimeUnixNano: span.endTimeUnixNano,
        attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: typeof value === "string"
          ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : { doubleValue: value } })),
      })) }],
    }] };
    ctx.waitUntil(fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { "dd-api-key": apiKey } : {}) },
      body: JSON.stringify(payload),
    }).then((response) => {
      if (!response.ok) throw new Error(`OTLP export returned ${response.status}`);
    }).catch((error) => {
      console.error(JSON.stringify({ event: "app_trace_export_failed", requestId, error: String(error) }));
    }));
  }

  return { traceId, parentSpanId, run, exportSpans };
}
