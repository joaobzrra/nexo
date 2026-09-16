import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCodexBinding } from "./codex-telemetry.mjs";

const DEFAULT_PORT = 4317;

export function notificationToBinding(notification, env = process.env, now = () => new Date()) {
  if (notification?.type !== "agent-turn-complete") return null;
  return normalizeCodexBinding({
    "thread-id": notification["thread-id"],
    paneId: env.AGENTTERMINAL_PANE_ID,
    cwd: notification.cwd,
    updatedAt: now().toISOString(),
  });
}

export async function postBinding(binding, env = process.env, fetchImpl = fetch) {
  if (!binding) return false;
  const port = Number(env.AGENTTERMINAL_TELEMETRY_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const response = await fetchImpl("http://127.0.0.1:" + port + "/ingest/codex-pane", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.AGENTTERMINAL_TELEMETRY_TOKEN || ""}`,
    },
    body: JSON.stringify(binding),
    signal: AbortSignal.timeout(1500),
  });
  return response.ok;
}

export function runDelegate(commandAndArgs, rawPayload) {
  if (!commandAndArgs.length) return Promise.resolve();
  const [command, ...args] = commandAndArgs;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [...args, rawPayload], {
        env: process.env,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve();
    }, 10000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const rawPayload = process.argv.at(-1) ?? "";
  const args = process.argv.slice(2, -1);
  const delegate = args[0] === "--delegate" ? args.slice(1) : [];
  let notification = null;
  try {
    notification = JSON.parse(rawPayload);
  } catch {}

  const binding = notificationToBinding(notification);
  await Promise.allSettled([
    postBinding(binding),
    runDelegate(delegate, rawPayload),
  ]);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
