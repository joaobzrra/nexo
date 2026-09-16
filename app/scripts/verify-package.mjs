import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll, listPackage } from "@electron/asar";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const packageRoot = path.resolve(appRoot, process.argv[2] || "dist-packaged/win-unpacked");
const resources = path.join(packageRoot, "resources");
const asarFile = path.join(resources, "app.asar");
const failures = [];

function fail(message) { failures.push(message); }
function slash(value) { return value.replaceAll(path.sep, "/"); }

if (!fs.existsSync(path.join(packageRoot, "Nexo.exe"))) fail("missing packaged Nexo.exe");
if (!fs.existsSync(asarFile)) fail("missing resources/app.asar");

const allowedResourceRoots = new Set([
  "app-update.yml",
  "app.asar",
  "app.asar.unpacked",
  "brand",
  "elevate.exe",
  "telemetry",
]);
if (fs.existsSync(resources)) {
  for (const entry of fs.readdirSync(resources, { withFileTypes: true })) {
    if (!allowedResourceRoots.has(entry.name)) fail(`unexpected packaged resource: ${entry.name}`);
  }
}
if (!fs.existsSync(path.join(resources, "brand", "nexo.ico"))) fail("missing packaged resources/brand/nexo.ico");

// App-owned source roots are enforced separately by allowedAsarRoots. Here we
// block privacy-sensitive names anywhere without rejecting legitimate
// dependency folders such as node-addon-api/tools.
const bannedPath = /(^|[\\/])(?:\.git|\.github|screenshots?|\.planning)(?:[\\/]|$)|(?:handoff|captured-|\.jsonl$|\.map$|\.env(?:\.|$))/i;
if (fs.existsSync(asarFile)) {
  const entries = listPackage(asarFile);
  const allowedAsarRoots = new Set([
    "build", "main.js", "node_modules", "package.json", "preload.js", "renderer",
    "setup-preload.js", "telemetry-hook.js", "telemetry-integration.js", "updater.js",
  ]);
  for (const raw of entries) {
    const entry = raw.replace(/^[\\/]+/, "");
    const root = entry.split(/[\\/]/)[0];
    if (root && !allowedAsarRoots.has(root)) fail(`unexpected app.asar root: ${root}`);
    if (bannedPath.test(entry)) fail(`banned path in app.asar: ${entry}`);
  }
}

function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, visit);
    else visit(file);
  }
}

walk(resources, (file) => {
  const rel = slash(path.relative(resources, file));
  if (bannedPath.test(rel)) fail(`banned packaged path: ${rel}`);
});

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nexo-package-audit-"));
try {
  if (fs.existsSync(asarFile)) extractAll(asarFile, temp);
  const ownedRoots = [
    "main.js", "preload.js", "setup-preload.js", "telemetry-hook.js",
    "telemetry-integration.js", "updater.js", "renderer",
  ];
  const textExtensions = new Set([".cmd", ".js", ".html", ".css", ".json", ".mjs", ".txt", ".yml", ".yaml"]);
  // Private strings are never written in this file, or it would publish what
  // it exists to catch. On a developer machine they are derived from the build
  // itself (the checkout folder and the OS account name). Anything else goes in
  // NEXO_PRIVATE_STRINGS, comma-separated, set in the environment.
  const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const extraPrivate = (process.env.NEXO_PRIVATE_STRINGS || "")
    .split(",").map((item) => item.trim()).filter(Boolean);
  const localPrivate = process.env.CI ? [] : [
    { label: "private workspace path", regex: new RegExp(escapeRegex(path.resolve(appRoot, "..")), "i") },
    { label: "developer username", regex: new RegExp(`\\b${escapeRegex(os.userInfo().username)}\\b`, "i") },
  ];
  const secretPatterns = [
    { label: "local Windows user path", regex: /C:\\Users\\[^\\\s"']+/i },
    ...localPrivate,
    ...extraPrivate.map((item) => ({ label: "private string", regex: new RegExp(escapeRegex(item), "i") })),
    { label: "GitHub token", regex: /\b(?:gho_|ghp_|github_pat_)[A-Za-z0-9_]{16,}/ },
    { label: "OpenAI-style secret", regex: /\bsk-[A-Za-z0-9_-]{20,}/ },
  ];
  const scanText = (file, label) => {
    if (!textExtensions.has(path.extname(file).toLowerCase())) return;
    const content = fs.readFileSync(file, "utf8");
    for (const pattern of secretPatterns) {
      if (pattern.regex.test(content)) fail(`${pattern.label} found in ${label}`);
    }
  };
  for (const root of ownedRoots) {
    const target = path.join(temp, root);
    if (!fs.existsSync(target)) continue;
    if (fs.statSync(target).isDirectory()) {
      walk(target, (file) => scanText(file, `app.asar/${slash(path.relative(temp, file))}`));
    } else scanText(target, `app.asar/${root}`);
  }
  const telemetryRoot = path.join(resources, "telemetry");
  walk(telemetryRoot, (file) => scanText(file, `resources/${slash(path.relative(resources, file))}`));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

if (failures.length) {
  console.error("PACKAGE VERIFICATION FAILED");
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("PACKAGE VERIFICATION PASS — strict resources, privacy scan, and secret scan are clean");
