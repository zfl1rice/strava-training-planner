import assert from "node:assert/strict";
import { config } from "dotenv";
import pg from "pg";
import { randomBytes, createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
config({ path: ".env", quiet: true });
// Run from the repository root after building the web app. Uses an isolated
// database, local port and installed Edge; no real athlete data or paid AI calls.
await mkdir("logs", { recursive: true });
const databaseName = "ui_probe_" + randomBytes(8).toString("hex");
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const dbUrl = new URL(process.env.DATABASE_URL); dbUrl.pathname = "/" + databaseName;
process.env.DATABASE_URL = dbUrl.href;
process.env.PLANNER_PROVIDER = "deterministic"; process.env.OPENAI_API_KEY = "";
const portServer = createServer(); await new Promise(r => portServer.listen(0, "127.0.0.1", r));
const port = portServer.address().port; await new Promise(r => portServer.close(r));
const base = "http://localhost:" + port;
Object.assign(process.env, { STRAVA_CLIENT_ID: "12345", STRAVA_CLIENT_SECRET: "synthetic-only", STRAVA_REDIRECT_URI: base + "/api/strava/callback", BULLMQ_PREFIX: databaseName });
let created = false, server, browser, socket, prisma;
try {
  await admin.connect(); await admin.query('CREATE DATABASE "' + databaseName + '"'); created = true;
  const migration = spawnSync(process.execPath, ["../../node_modules/prisma/build/index.js", "migrate", "deploy"], { cwd: "packages/db", env: process.env, stdio: "pipe", windowsHide: true });
  assert.equal(migration.status, 0, "Migrations must succeed");
  const db = await import("@pkg/db"); prisma = db.prisma;
  const shared = await import("@pkg/shared");
  const now = new Date(); const today = shared.localDateAt(now, "UTC"); const monday = shared.calendarMonday(today);
  const previousMonday = shared.addCalendarDays(monday, -7);
  const token = randomBytes(32).toString("base64url");
  const user = await prisma.user.create({ data: { name: "Demo athlete", sessions: { create: { tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600000) } },
    stravaConnection: { create: { athleteId: 123456n, accessToken: "synthetic", refreshToken: "synthetic", expiresAt: new Date(Date.now()+3600000), scopes: ["activity:read_all"], lastSuccessfulSyncAt: now } } } });
  await db.saveWeeklyGoals(user.id, { RUN: 120, BIKE: 240, SWIM: 60 });
  await db.saveTrainingFocus(user.id, { RUN: 30, BIKE: 50, SWIM: 20 }, null);
  const block = await db.createInitialTrainingBlock(user.id, false, new Date(previousMonday + "T12:00:00Z"));
  await db.generateAndSaveFlexiblePlan(user.id, new Date(previousMonday + "T12:00:00Z"), "REMAINING_WEEK");
  const plan = await db.generateAndSaveFlexiblePlan(user.id, now, "REMAINING_WEEK");
  const workouts = shared.calendarWorkouts(plan.content); assert.ok(workouts.length > 1);
  const protectedWorkout = workouts[0];
  await db.saveWorkoutStates(user.id, plan.id, plan.updatedAt, [{ workoutId: protectedWorkout.id, templateId: protectedWorkout.templateId ?? "custom", date: protectedWorkout.date, locked: false, completion: "COMPLETED", feedback: { comment: "Felt comfortable", rpe: 3 } }]);
  await prisma.activity.create({ data: { userId: user.id, type: "BIKE", name: "Recorded easy ride", durationSeconds: 1800, startedAt: now } });
  const planBefore = await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: plan.id } });
  server = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "-p", String(port)], { cwd: "apps/web", env: process.env, stdio: "pipe", windowsHide: true });
  let serverLog = ""; server.stdout.on("data", d => { serverLog += d; }); server.stderr.on("data", d => { serverLog += d; });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/demo")).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  const profile = await mkdtemp(join(tmpdir(), "training-ui-"));
  browser = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + profile, "--remote-debugging-port=0", "about:blank"], { windowsHide: true, stdio: "ignore" });
  let browserPort;
  for (let i=0;i<100 && !browserPort;i++) { try { browserPort = (await readFile(join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]; } catch { await new Promise(r=>setTimeout(r,100)); } }
  assert.ok(browserPort);
  const pages = await (await fetch("http://127.0.0.1:" + browserPort + "/json/list")).json();
  socket = new WebSocket(pages.find(p=>p.type==="page").webSocketDebuggerUrl);
  await new Promise(r=>socket.addEventListener("open",r,{once:true}));
  let seq=0; const pending = new Map(); const errors=[]; const requests=[];
  socket.addEventListener("message", event => {
    const m=JSON.parse(event.data);
    if (m.method==="Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.text);
    if (m.method==="Network.requestWillBeSent" && m.params.request.url.includes("/api/")) requests.push(m.params.request);
    if (m.method==="Page.javascriptDialogOpening") void send("Page.handleJavaScriptDialog",{accept:false});
    const handler=pending.get(m.id); if (!handler)return; pending.delete(m.id); clearTimeout(handler.timer);
    if(m.error)handler.reject(new Error(m.error.message)); else handler.resolve(m.result);
  });
  function send(method,params={}) { return new Promise((resolve,reject)=>{ const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+" timeout"));},15000); pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params})); }); }
  async function evaluate(expression) { const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true}); if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);return result.result.value; }
  async function until(expression) { for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error("Timed out: "+expression); }
  const button = text => "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==="+JSON.stringify(text)+")";
  const section = "document.querySelector('[aria-labelledby=block-heading]')";
  await send("Runtime.enable"); await send("Network.enable"); await send("Page.enable");
  await send("Network.setCookie",{name:"planner_session",value:token,url:base,httpOnly:true,sameSite:"Lax"});
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url:base});
  await until("document.querySelectorAll('input[type=range]').length===3");
  assert.equal(await evaluate(section+".querySelectorAll('details[open]').length"),0);
  assert.equal(await evaluate(button("Review progress so far")+".className"),"calendar-nav");
  await evaluate(button("Review progress so far")+".click()");
  await new Promise(r=>setTimeout(r,250));
  assert.ok(!requests.some(r=>r.postData?.includes('"action":"REVIEW"')), "Cancel review must avoid paid calls");
  await evaluate("document.querySelector('[aria-label=\"Bike emphasis\"]').focus()");
  for (let i=0; i<5; i++) await send("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
  await send("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
  await until(button("Save focus")+" && !"+button("Save focus")+".disabled");
  await evaluate(button("Save focus")+".click()");
  await until(section+".textContent.includes('Focus saved for future strategies')");
  const storedFocus=(await db.getTrainingBlockState(user.id)).trainingFocus;
  assert.equal(Object.values(storedFocus).reduce((a,b)=>a+b),100); assert.notDeepEqual(storedFocus,{RUN:30,BIKE:50,SWIM:20});
  await send("Page.reload"); await until("document.querySelectorAll('input[type=range]').length===3");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('output')].map(e=>e.textContent)"),["RUN","BIKE","SWIM"].map(s=>storedFocus[s]+"%"));
  await evaluate(section+".scrollIntoView({block:'start'})");
  const output = new URL("../docs/screenshots/", import.meta.url); await mkdir(output,{recursive:true});
  const shot=async name=>{const result=await send("Page.captureScreenshot",{format:"png"});await writeFile(new URL(name,output),Buffer.from(result.data,"base64"));};
  await shot("training-plan-collapsed.png");
  await evaluate(section+".querySelectorAll('summary').forEach(s=>s.click())");
  assert.equal(await evaluate(section+".querySelectorAll('details[open]').length"),2);
  assert.ok(!/LONG_ENDURANCE|LONG_SESSION|PRIMARY/.test(await evaluate(section+".innerText")));
  await shot("training-plan-emphasis.png");
  await evaluate("document.querySelector('[aria-label=\"Selected week\"]').value="+JSON.stringify(previousMonday)+"; document.querySelector('[aria-label=\"Selected week\"]').dispatchEvent(new Event('change',{bubbles:true}))");
  await until(button("Review Week")+" && !"+button("Review Week")+".disabled");
  assert.equal(await evaluate(button("Review Week")+".className"),"settings-primary");
  await evaluate("document.querySelector('[aria-label=\"Selected week\"]').value="+JSON.stringify(monday)+"; document.querySelector('[aria-label=\"Selected week\"]').dispatchEvent(new Event('change',{bubbles:true}))");
  await until(button("Clear This Week")+" && !"+button("Clear This Week")+".disabled");
  await evaluate(button("Clear This Week")+".click()");
  await until("Boolean(document.querySelector('dialog[open]'))");
  await shot("training-plan-clear.png");
  await evaluate("document.querySelector('dialog[open]').querySelector('button').click()");
  assert.deepEqual((await prisma.weeklyPlan.findUniqueOrThrow({where:{id:plan.id}})).content,planBefore.content);
  await evaluate(button("Clear This Week")+".click()");
  await evaluate(button("Clear Week")+".click()");
  await until("!document.querySelector('dialog[open]')");
  await until(button("Clear This Week")+".disabled && document.querySelectorAll('button.calendar-entry').length > 0");
  const after=await prisma.weeklyPlan.findUniqueOrThrow({where:{id:plan.id}});
  assert.equal(shared.calendarWorkouts(after.content).length,1); assert.deepEqual(after.workoutStates,planBefore.workoutStates);
  assert.equal(await prisma.activity.count(),1); assert.deepEqual((await db.getDevelopmentBlock(user.id,block.id)).proposal,block.proposal);
  await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate(section+".scrollIntoView({block:'start'})");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),true);
  await shot("training-plan-mobile.png");
  assert.deepEqual(errors,[]);
  assert.ok(!requests.some(r=>r.postData?.includes('"action":"REVIEW"')));
  console.log("PASS: sliders save/reload; emphasis and week structure expand; current vs completed review; cancelled review makes no API call; clear cancel/confirm preserves history; mobile layout; 4 synthetic screenshots.");
  await writeFile("logs/training-ui-server.log",serverLog);
} finally {
  socket?.close();
  for(const child of [browser,server])if(child?.pid)spawnSync("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
  await prisma?.$disconnect();
  if(created && /^ui_probe_[a-f0-9]{16}$/.test(databaseName))await admin.query('DROP DATABASE "'+databaseName+'" WITH (FORCE)');
  await admin.end();
}
