import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const labels = {
  locations: "List locations",
  inventory_counts: "Get inventory counts",
  catalog_items: "List catalog items",
  purchase_orders: "List purchase orders",
};

export function runOptInDemo(requestId, record, steps) {
  return new Promise((resolve, reject) => {
    const script = fileURLToPath(new URL("./opt-in-steps.sh", import.meta.url));
    const shimDirectory = fileURLToPath(new URL("./cli-shims/", import.meta.url));
    const realCli = fileURLToPath(new URL("./mock-bin/democtl", import.meta.url));
    const child = spawn("bash", [script], {
      env: {
        ...process.env, REQUEST_ID: requestId,
        DEMOCTL_REAL_BIN: realCli, DEMOCTL_ORIGINAL_PATH: process.env.PATH,
        PATH: `${shimDirectory}${delimiter}${process.env.PATH}`,
      },
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    const active = new Map();
    let pending = "";
    let completed = 0;
    let invalidEvent = false;
    child.stderr.resume(); // Drain CLI diagnostics without treating them as telemetry.
    child.stdio[3].setEncoding("utf8");
    child.stdio[3].on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let entry;
        try { entry = JSON.parse(line); } catch { invalidEvent = true; continue; }
        if (!Object.hasOwn(labels, entry.operation) || typeof entry.invocationId !== "string") {
          invalidEvent = true;
          continue;
        }
        const { operation, invocationId } = entry;
        const label = labels[operation];
        if (entry.event === "cli_invocation_started") {
          active.set(invocationId, { operation, startedAt: entry.startedAt });
          record("info", entry.event, { requestId, invocationId, operation, label });
        } else if (entry.event === "cli_invocation_finished" || entry.event === "cli_invocation_failed") {
          const start = active.get(invocationId);
          if (!start || start.operation !== operation) { invalidEvent = true; continue; }
          active.delete(invocationId);
          const durationMs = entry.durationMs;
          if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) { invalidEvent = true; continue; }
          steps.push({ name: `cli.${operation}`, label, startedAt: start.startedAt,
            finishedAt: new Date().toISOString(), durationMs });
          record(entry.event === "cli_invocation_finished" ? "info" : "error", entry.event, {
            requestId, invocationId, operation, label, durationMs, exitCode: entry.exitCode,
          });
          if (entry.event === "cli_invocation_finished") completed++;
        } else invalidEvent = true;
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && completed === Object.keys(labels).length && !invalidEvent && !pending.trim()) {
        resolve({ completedCalls: completed });
      } else reject(new Error(`Opt-in CLI demo stopped after ${completed} calls (exit ${code})`));
    });
  });
}
