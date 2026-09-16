const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const sourceFile = path.resolve(appRoot, "..", "tools", "brand", "Nexo-Favicon.svg");
const outputFile = path.join(appRoot, "build", "icon.png");

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  if (!fs.existsSync(sourceFile)) throw new Error(`Missing brand master: ${sourceFile}`);
  const svg = fs.readFileSync(sourceFile, "utf8").replace(/^<\?xml[^>]*>\s*/i, "");
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
    body{display:grid;place-items:center}
    svg{display:block;width:100%;height:100%}
  </style>${svg}`;
  const win = new BrowserWindow({
    // 512 is twice the ICO's largest 256px layer and fits GitHub's 720px
    // hosted Windows desktop without Chromium constraining the hidden window.
    width: 512,
    height: 512,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  // Hosted Windows runners may apply a display scale factor even to hidden
  // windows. ICO generation only requires a sufficiently large square source.
  if (image.isEmpty() || size.width !== size.height || size.width < 512) {
    throw new Error(`Chromium produced an invalid icon raster: ${size.width}x${size.height}`);
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, image.toPNG());
  win.destroy();
  console.log(`rendered ${path.basename(sourceFile)} to a transparent ${size.width}x${size.height} build/icon.png`);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
