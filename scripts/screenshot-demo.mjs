import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Optional local-only visual smoke. Uses installed Chromium/Edge, no npm downloads.
const base = new URL(process.argv[2] ?? "http://localhost:3000");
assert.ok(["localhost", "127.0.0.1"].includes(base.hostname), "Use a localhost demo server");
const profile = await mkdtemp(join(tmpdir(), "tri-coach-demo-"));
const browserPath = process.env.CHROME_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { windowsHide: true, stdio: "ignore" });
let launchError;
browser.on("error", error => { launchError = error; });
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port, "Browser debugging endpoint did not start");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  const apiRequests = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent" && new URL(message.params.request.url).pathname.startsWith("/api/")) apiRequests.push(message.params.request.url);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (!pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id); pending.delete(message.id); clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: new URL("/demo", base).href });
  let opened = false;
  for (let attempt = 0; attempt < 100 && !opened; attempt++) {
    await evaluate("[...document.querySelectorAll('button.calendar-entry')].find(button => button.textContent.includes('threshold intervals'))?.click()");
    opened = await evaluate("Boolean(document.querySelector('dialog[open]'))");
    if (!opened) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(opened, "Workout detail must open after clicking a calendar card");
  const detail = await evaluate("document.querySelector('dialog[open]').textContent");
  assert.match(detail, /Repeat 3 times/); assert.match(detail, /% FTP/); assert.match(detail, /237.5/);
  assert.equal(await evaluate("Boolean(document.querySelector('dialog form'))"), false, "Demo must not expose feedback mutations");
  const output = new URL("../docs/screenshots/", import.meta.url); await mkdir(output, { recursive: true });
  const screenshot = async name => { const result = await send("Page.captureScreenshot", { format: "png" }); await writeFile(new URL(name, output), Buffer.from(result.data, "base64")); };
  await screenshot("demo-workout.png");
  await evaluate("document.querySelector('[aria-label=\"Close workout details\"]').click(); window.scrollTo(0,0)");
  await screenshot("demo-calendar.png");
  // Capture only the table header and first two populated weeks for a compact
  // README hero. This is a browser capture of the synthetic UI, not a mockup.
  await send("Emulation.setDeviceMetricsOverride", { width: 1660, height: 1100, deviceScaleFactor: 1, mobile: false });
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const heroClip = await evaluate(`(() => {
    const table = document.querySelector('.training-calendar');
    const header = table.querySelector('thead').getBoundingClientRect();
    const rows = table.querySelectorAll('tbody tr');
    const last = rows[1].getBoundingClientRect();
    return { x: header.x + window.scrollX, y: header.y + window.scrollY,
      width: header.width, height: last.bottom - header.top, scale: 1 };
  })()`);
  const hero = await send("Page.captureScreenshot", { format: "png", clip: heroClip, captureBeyondViewport: false });
  await writeFile(new URL("readme-calendar.png", output), Buffer.from(hero.data, "base64"));
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.querySelector('[aria-label=\"Latest block review\"]').scrollIntoView({block:'center'})");
  await screenshot("demo-review.png");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("window.scrollTo(0,0)");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), true, "Mobile page should contain its calendar overflow");
  await screenshot("demo-mobile.png");
  assert.deepEqual(errors, [], "Demo must not throw browser runtime exceptions");
  assert.deepEqual(apiRequests, [], "Synthetic demo must not request authenticated application data");
  console.log("Demo browser smoke passed: interactive detail, grouped repeats, resolved targets, read-only controls, mobile overflow. Saved five synthetic screenshots including the README hero.");
} finally { socket?.close(); browser.kill(); }
