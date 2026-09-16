import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Nexo beta packaging supports Windows x64 only; got ${process.platform}-${process.arch}`);
}
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(appRoot, "node_modules", "node-pty", "prebuilds", "win32-x64");
for (const binary of ["pty.node", "conpty.node"]) {
  const file = path.join(root, binary);
  if (!fs.existsSync(file) || fs.statSync(file).size < 100_000) {
    throw new Error(`Missing node-pty Windows x64 prebuilt: ${file}`);
  }
}
console.log("node-pty Windows x64 prebuilt present; Electron ABI is verified by npm run selftest");
