import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const labels = {
  locations: "List locations",
  counts: "Get inventory counts",
  catalog: "List catalog items",
  purchase_orders: "List purchase orders",
  inspect: "Inspect saved files",
};

// The shell reports boundaries; the Node parent measures them and writes JSON logs.
// No command output is logged: the mock data stays in the script's temporary files.
export function runShellDemo(requestId, record, steps) {
  return new Promise((resolve, reject) => {
    const script = fileURLToPath(new URL("./shell-steps.sh", import.meta.url));
    const child = spawn("bash", [script], {
      env: { ...process.env, REQUEST_ID: requestId },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const active = new Map();
    let pending = "";
    let completed = 0;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const [kind, name, exitCode] = line.split("\t");
        if (!(name in labels) || !["START", "DONE", "FAILED"].includes(kind)) {
          record("error", "shell_diagnostic", { requestId, message: line.slice(0, 200) });
          continue;
        }
        if (kind === "START") {
          active.set(name, { startedAt: new Date().toISOString(), started: performance.now() });
          record("info", "shell_step_started", { requestId, name, label: labels[name] });
        } else {
          const start = active.get(name);
          if (!start) continue;
          active.delete(name);
          const durationMs = Number((performance.now() - start.started).toFixed(1));
          const finishedAt = new Date().toISOString();
          steps.push({ name: `shell.${name}`, label: labels[name], startedAt: start.startedAt, finishedAt, durationMs });
          record(kind === "DONE" ? "info" : "error", kind === "DONE" ? "shell_step_finished" : "shell_step_failed", {
            requestId, name, label: labels[name], durationMs,
            ...(kind === "FAILED" ? { exitCode: Number(exitCode) } : {}),
          });
          if (kind === "DONE") completed++;
        }
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && completed === Object.keys(labels).length) resolve({ completedSteps: completed });
      else reject(new Error(`Shell demo stopped after ${completed} steps (exit ${code})`));
    });
  });
}
