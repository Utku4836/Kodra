import fs from "node:fs/promises";
import path from "node:path";

function option(name, fallback = "") {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const theme = option("theme", "kodra");
const menu = option("menu", "");
const port = Number(option("port", "9223"));
const output = path.resolve(option("out", path.join(process.cwd(), `theme-smoke-${theme}.png`)));

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === "page" && candidate.title === "Kodra") || targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error(`No Kodra WebView target found on port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  if (message.error) handler.reject(new Error(message.error.message));
  else handler.resolve(message.result);
});

function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await call("Page.bringToFront");
const evaluated = await call("Runtime.evaluate", {
  expression: `(async () => {
    const selected = globalThis.KodraThemes.apply(${JSON.stringify(theme)});
    const requestedMenu = ${JSON.stringify(menu)};
    if (requestedMenu) {
      const input = document.querySelector('#cmd-input');
      input.focus();
      input.value = '/' + requestedMenu.replace(/^\\//, '');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 280));
    const app = document.querySelector('.app');
    const modal = document.querySelector('.modal-window');
    const appStyle = getComputedStyle(app);
    const modalStyle = getComputedStyle(modal);
    return {
      selected: selected.id,
      dataset: document.documentElement.dataset.theme,
      canvas: appStyle.backgroundColor,
      backdropFilter: appStyle.backdropFilter || appStyle.webkitBackdropFilter,
      modal: modalStyle.backgroundColor,
      text: getComputedStyle(document.body).color,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || "Theme evaluation failed");

const capture = await call("Page.captureScreenshot", {
  format: "png",
  fromSurface: true,
  captureBeyondViewport: false,
});
await fs.writeFile(output, Buffer.from(capture.data, "base64"));
socket.close();

console.log(JSON.stringify({ output, ...evaluated.result.value }, null, 2));
