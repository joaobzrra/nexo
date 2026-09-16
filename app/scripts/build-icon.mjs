import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const buildDir = path.join(appRoot, "build");
const renderedPng = path.join(buildDir, "icon.png");

if (!fs.existsSync(renderedPng)) throw new Error(`Missing rendered icon: ${renderedPng}`);
fs.writeFileSync(path.join(buildDir, "icon.ico"), await pngToIco(renderedPng));
console.log("built multi-size build/icon.ico from the Chromium-rendered SVG");
