// Posts synthetic telemetry to the collector so the viewer can be exercised
// without live CLI sessions.  node fake-feed.mjs [--once]
const BASE = "http://127.0.0.1:4317";
const once = process.argv.includes("--once");

let claudeCtx = 42000, codexCtx = 91000, codexCumulative = 2400000, plan = 34;

async function tick() {
  claudeCtx = Math.min(195000, claudeCtx + Math.random() * 6000);
  codexCtx = Math.min(250000, codexCtx + Math.random() * 9000);
  codexCumulative += Math.round(70000 + Math.random() * 80000);
  plan = Math.min(99, plan + Math.random() * 0.4);

  // Claude statusline-shaped payload (matches real capture, CC 2.1.232)
  await post("/ingest/claude?replay=1", {
    session_id: "fake-claude-1",
    session_name: "Fake feed session",
    model: { id: "claude-fable-5", display_name: "Fable 5" },
    effort: { level: "high" },
    workspace: { current_dir: "E:\\Projects\\AgentTerminal" },
    cost: { total_cost_usd: claudeCtx / 90000 },
    context_window: {
      context_window_size: 200000,
      total_input_tokens: Math.round(claudeCtx),
      total_output_tokens: 12000,
      current_usage: { input_tokens: 2, output_tokens: 655, cache_creation_input_tokens: 83, cache_read_input_tokens: Math.round(claudeCtx) - 85 },
      used_percentage: Math.round(100 * claudeCtx / 200000),
      remaining_percentage: 100 - Math.round(100 * claudeCtx / 200000),
    },
    rate_limits: {
      five_hour: { used_percentage: plan / 3, resets_at: Math.round(Date.now() / 1000) + 7200 },
      seven_day: { used_percentage: plan, resets_at: Math.round(Date.now() / 1000) + 200000 },
    },
  });

  // Codex, already-normalized shape
  await post("/ingest/test", {
    source: "codex",
    sessionId: "fake-codex-1",
    model: "gpt-5.6-sol",
    effort: "high",
    cwd: "E:\\Projects\\AgentTerminal",
    contextUsed: Math.round(codexCtx),
    contextWindow: 258400,
    contextLabel: "counted",
    tokens: {
      input: codexCumulative - 6000,
      cachedInput: Math.max(0, codexCumulative - 240000),
      output: 6000,
      reasoningOutput: 2500,
      total: codexCumulative,
    },
    rateLimits: [
      { label: "7d", usedPercent: plan, windowMinutes: 10080, resetsAt: null },
    ],
  });

  console.log(`tick: claude ${Math.round(claudeCtx)} / codex context ${Math.round(codexCtx)} / cumulative ${codexCumulative} / plan ${plan.toFixed(1)}%`);
}

async function post(p, body) {
  await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch((e) => console.error(p, e.message));
}

await tick();
if (!once) setInterval(tick, 2000);
