#!/usr/bin/env node
// Stress test for the Dwindle plugin against real headless Sway instances.
// It runs DwindleLogic.js with the plugin's queue semantics, drives random window actions,
// and checks tree invariants plus an independent dwindle model after the queue drains.
import { execFile, execFileSync, fork, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const LOGIC = path.join(REPO, "home/.config/dms/plugins/Dwindle/DwindleLogic.js");
const QUIET_MS = 50;
const GAP = 4;
const SETTLE_TIMEOUT_MS = 10000;
const APPS = ["dw.term", "dw.web", "dw.edit", "dw.files", "dw.chat"];
const OUTPUTS = [
    { name: "1920x1080", weight: 30, outs: [{ mode: "1920x1080" }] },
    { name: "2560x1440", weight: 15, outs: [{ mode: "2560x1440" }] },
    { name: "1366x768", weight: 15, outs: [{ mode: "1366x768" }] },
    { name: "portrait", weight: 15, outs: [{ mode: "1920x1080", transform: "90" }] },
    { name: "dual", weight: 25, outs: [{ mode: "1920x1080" }, { mode: "2560x1440", x: 1920 }] },
];

// User stories. Each runs on every output layout with dwindle on and off; "?" picks at random.
// Windows are named by opening order among the open ones: first, last, mid or an index.
const open = n => Array.from({ length: n }, () => ({ k: "open" }));
const TEMPLATES = {
    "close first, drag onto another": r => [...open(3 + Math.floor(r() * 2)), { k: "close", w: "first" }, { k: "drag", src: "?", dst: "?", edge: "?" }],
    "close middle, open two": () => [...open(4), { k: "close", w: "mid" }, { k: "open" }, { k: "open" }],
    "drag last to first's left, close it, open": () => [...open(3), { k: "drag", src: "last", dst: "first", edge: "left" }, { k: "close", w: "last" }, { k: "open" }],
    "tabs, close a tab, tabs back, open": () => [...open(4), { k: "tabs" }, { k: "close", w: "?" }, { k: "tabs" }, { k: "open" }],
    "fullscreen, open two, leave fullscreen": () => [...open(3), { k: "fs", w: "?" }, { k: "open" }, { k: "open" }, { k: "fs", w: "same" }],
    "float, drag over another, unfloat": () => [...open(4), { k: "float", w: "?" }, { k: "dragFloat", dst: "?" }, { k: "float", w: "same" }],
    "keyboard to ws 2, mouse to the other output": () => [...open(3), { k: "moveWs", w: "?", ws: 2 }, { k: "drag", src: "?", dst: "other", edge: "?" }],
    "focus first of five, open": () => [...open(5), { k: "focus", w: "first" }, { k: "open" }],
    "scratchpad out, open, scratchpad back": () => [...open(4), { k: "scratch", w: "?" }, { k: "open" }, { k: "show" }, { k: "float", w: "same" }],
    "drag between monitors, close both sides": () => [...open(3), { k: "ws", ws: 3 }, ...open(2), { k: "drag", src: "?", dst: "other", edge: "?" }, { k: "close", w: "first" }, { k: "close", w: "last" }],
    "burst of six, close three, drag, open two": () => [{ k: "burst", n: 6 }, { k: "close", w: "?" }, { k: "close", w: "?" }, { k: "close", w: "?" }, { k: "drag", src: "?", dst: "?", edge: "?" }, ...open(2)],
    "open four, move one left by key, close, open": () => [...open(4), { k: "focus", w: "?" }, { k: "key", cmd: "move left" }, { k: "close", w: "?" }, { k: "open" }],
    "resize by mouse, open, close": () => [...open(3), { k: "resize" }, { k: "open" }, { k: "close", w: "?" }],
};
const TEMPLATE_NAMES = Object.keys(TEMPLATES);

const now = () => performance.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
    const o = { scenarios: 100, jobs: Math.max(1, Math.min(12, os.cpus().length - 4)), seed: 1, out: path.join(os.tmpdir(), "dwindle-test"), seeds: null, verbose: false, worker: false, stopAfter: 0, transport: "socket", bench: 0 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const v = () => argv[++i];
        if (a === "--scenarios") o.scenarios = +v();
        else if (a === "--jobs") o.jobs = +v();
        else if (a === "--seed") o.seed = +v();
        else if (a === "--out") o.out = v();
        else if (a === "--replay") o.seeds = v().split(",").map(Number);
        else if (a === "--stop-after") o.stopAfter = +v();
        else if (a === "--transport") o.transport = v();
        else if (a === "--bench") o.bench = +v();
        else if (a === "--plugin") o.plugin = v();
        else if (a === "--templates") o.templates = true;
        else if (a === "--verbose") o.verbose = true;
        else if (a === "--worker") o.worker = true;
        else if (a === "--help") {
            console.log("node run.mjs [--scenarios N] [--jobs J] [--seed S] [--out DIR] [--replay SEED,...] [--stop-after FAILS] [--verbose]\n" +
                "             [--transport socket|swaymsg] [--plugin qml] [--bench WINDOWS] [--templates]");
            process.exit(0);
        }
    }
    return o;
}

function scenarioSeed(base, i) {
    let h = (Math.imul(base >>> 0, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    return (h ^ (h >>> 15)) >>> 0;
}

function rngFrom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function loadLogic() {
    const src = fs.readFileSync(LOGIC, "utf8").replace(/^\.pragma library\s*$/m, "");
    const ctx = vm.createContext({ console });
    vm.runInContext(src, ctx, { filename: LOGIC });
    return ctx;
}

function buildClient(dir) {
    const src = path.join(HERE, "dwclient.c");
    const bin = path.join(dir, "dwclient");
    if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs)
        return bin;
    fs.mkdirSync(dir, { recursive: true });
    const pd = execFileSync("pkg-config", ["--variable=pkgdatadir", "wayland-protocols"]).toString().trim();
    const wlr = execFileSync("pkg-config", ["--variable=pkgdatadir", "wlr-protocols"]).toString().trim();
    const protos = { "xdg-shell": path.join(pd, "stable/xdg-shell/xdg-shell.xml"), "wlr-virtual-pointer-unstable-v1": path.join(wlr, "unstable/wlr-virtual-pointer-unstable-v1.xml") };
    const sources = [src];
    for (const [name, xml] of Object.entries(protos)) {
        execFileSync("wayland-scanner", ["client-header", xml, path.join(dir, `${name}-client-protocol.h`)]);
        execFileSync("wayland-scanner", ["private-code", xml, path.join(dir, `${name}-protocol.c`)]);
        sources.push(path.join(dir, `${name}-protocol.c`));
    }
    execFileSync("gcc", ["-O2", "-o", bin, ...sources, "-I", dir, "-lwayland-client"]);
    return bin;
}

// i3 IPC over the Sway socket.
class Ipc {
    constructor(sock) {
        this.sock = sock;
        this.buf = Buffer.alloc(0);
        this.waiters = [];
        this.onEvent = null;
        this.closed = false;
        sock.on("data", d => this.data(d));
        sock.on("error", () => {});
        sock.on("close", () => {
            this.closed = true;
            for (const w of this.waiters)
                w.reject(new Error("ipc closed"));
            this.waiters = [];
        });
    }

    static connect(p) {
        return new Promise((res, rej) => {
            const s = net.createConnection(p);
            s.once("connect", () => res(new Ipc(s)));
            s.once("error", rej);
        });
    }

    data(d) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        while (this.buf.length >= 14) {
            const len = this.buf.readUInt32LE(6);
            const type = this.buf.readUInt32LE(10);
            if (this.buf.length < 14 + len)
                break;
            const body = this.buf.subarray(14, 14 + len).toString();
            this.buf = this.buf.subarray(14 + len);
            let msg = null;
            try {
                msg = JSON.parse(body.replace(/:\s*-?(NaN|Infinity)\b/g, ": 0"));
            } catch (e) {}
            if (type & 0x80000000) {
                if (this.onEvent)
                    this.onEvent(type & 0x7fffffff, msg, body);
            } else {
                const w = this.waiters.shift();
                if (w)
                    w.resolve(msg);
            }
        }
    }

    send(type, payload = "") {
        return new Promise((resolve, reject) => {
            if (this.closed)
                return reject(new Error("ipc closed"));
            const b = Buffer.from(payload);
            const h = Buffer.alloc(14);
            h.write("i3-ipc", 0);
            h.writeUInt32LE(b.length, 6);
            h.writeUInt32LE(type, 10);
            this.waiters.push({ resolve, reject });
            this.sock.write(Buffer.concat([h, b]));
        });
    }

    close() {
        this.sock.destroy();
    }
}

function swayConfig(out) {
    const lines = [
        "xwayland disable",
        "default_border normal 1",
        "default_floating_border normal 1",
        "titlebar_padding 8 4",
        "titlebar_border_thickness 1",
        "gaps inner 4",
        "gaps outer 0",
        "smart_gaps on",
        "smart_borders on",
        "focus_follows_mouse no",
        "mouse_warping none",
        'for_window [app_id="^dwdialog$"] floating enable, move position center',
        "bindsym --whole-window BTN_SIDE nop dwindle tabs",
        "bindsym --whole-window BTN_EXTRA nop dwindle toggle",
    ];
    const o = out.outs[0];
    lines.push(`output HEADLESS-1 mode ${o.mode} position 0 0` + (o.transform ? ` transform ${o.transform}` : ""));
    if (out.outs.length > 1)
        lines.push("workspace 1 output HEADLESS-1", "workspace 2 output HEADLESS-1", "workspace 3 output HEADLESS-2", "workspace 4 output HEADLESS-2");
    return lines.join("\n") + "\n";
}

async function startSway(out) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwsway-"));
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(path.join(dir, "config"), swayConfig(out));
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: dir, WLR_BACKENDS: "headless", WLR_LIBINPUT_NO_DEVICES: "1", WLR_RENDERER: "pixman", WLR_HEADLESS_OUTPUTS: "1" };
    // DW_SWAY_GDB=1 runs Sway under gdb and writes its backtrace to <dir>.gdb when it crashes.
    const cmd = process.env.DW_SWAY_GDB ? ["gdb", ["-batch", "-ex", "run", "-ex", "bt", "--args", "sway", "-c", path.join(dir, "config")]] : ["sway", ["-c", path.join(dir, "config")]];
    const proc = spawn(cmd[0], cmd[1], { env, stdio: ["ignore", process.env.DW_SWAY_GDB ? fs.openSync(dir + ".gdb", "w") : "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", d => (stderr = (stderr + d).slice(-4000)));
    let exited = false;
    proc.on("exit", () => (exited = true));
    const t0 = now();
    let sock = null, wl = null;
    while (!sock || !wl) {
        if (exited || now() - t0 > 8000) {
            try {
                proc.kill("SIGKILL");
            } catch (e) {}
            fs.rmSync(dir, { recursive: true, force: true });
            throw new Error("sway did not start: " + stderr.slice(-500));
        }
        await sleep(10);
        for (const f of fs.readdirSync(dir)) {
            if (/^sway-ipc\..*\.sock$/.test(f))
                sock = path.join(dir, f);
            else if (/^wayland-\d+$/.test(f))
                wl = f;
        }
    }
    const s = { proc, dir, env: Object.assign({}, env, { SWAYSOCK: sock, WAYLAND_DISPLAY: wl }), sock, stderr: () => stderr, exited: () => exited };
    for (let i = 0; i < 100; i++) {
        try {
            s.ipc = await Ipc.connect(sock);
            break;
        } catch (e) {
            await sleep(10);
        }
    }
    if (out.outs.length > 1) {
        await s.ipc.send(0, "create_output");
        const o = out.outs[1];
        await s.ipc.send(0, `output HEADLESS-2 mode ${o.mode} position ${o.x} 0`);
        await s.ipc.send(0, "focus output HEADLESS-1");
    }
    return s;
}

function swayCpu(pid) {
    try {
        const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const parts = f.slice(f.lastIndexOf(")") + 2).split(" ");
        return (+parts[11] + +parts[12]) / 100;
    } catch (e) {
        return 0;
    }
}

// Virtual pointer in the test session: real button presses and motion through Sway's seat.
class Pointer {
    constructor(client, env) {
        this.proc = spawn(client, ["--pointer"], { env, stdio: ["pipe", "pipe", "ignore"] });
        this.waiters = [];
        this.buf = "";
        this.proc.stdout.on("data", d => {
            this.buf += d;
            let k;
            while ((k = this.buf.indexOf("\n")) >= 0) {
                this.buf = this.buf.slice(k + 1);
                const w = this.waiters.shift();
                if (w)
                    w();
            }
        });
        this.proc.on("exit", () => {
            for (const w of this.waiters)
                w();
            this.waiters = [];
        });
        this.proc.stdin.on("error", () => {});
        this.ready = new Promise(r => this.waiters.push(r));
    }

    send(line) {
        return new Promise(r => {
            this.waiters.push(r);
            this.proc.stdin.write(line + "\n");
        });
    }

    close() {
        try {
            this.proc.kill("SIGKILL");
        } catch (e) {}
    }
}

async function stopSway(s) {
    try {
        s.ipc.send(0, "exit").catch(() => {});
    } catch (e) {}
    const t0 = now();
    while (!s.exited() && now() - t0 < 2000)
        await sleep(10);
    if (!s.exited()) {
        try {
            s.proc.kill("SIGKILL");
        } catch (e) {}
    }
    try {
        s.ipc.close();
    } catch (e) {}
    fs.rmSync(s.dir, { recursive: true, force: true });
}

// Plain tree walk, independent of DwindleLogic.js.
function analyze(tree) {
    const nodes = new Map();
    const wins = [];
    const walk = (n, parent, ws, floating, output) => {
        const info = { n, parent, ws, floating, output };
        nodes.set(n.id, info);
        const w = n.type === "workspace" ? n : ws;
        const o = n.type === "output" ? n : output;
        const leaf = !(n.nodes && n.nodes.length) && !(n.floating_nodes && n.floating_nodes.length);
        if ((n.type === "con" || n.type === "floating_con") && leaf && n.pid > 0)
            wins.push(info);
        for (const c of n.nodes || [])
            walk(c, n, w, floating, o);
        for (const c of n.floating_nodes || [])
            walk(c, n, w, true, o);
    };
    walk(tree, null, null, false, null);
    let focused = null;
    for (const [, i] of nodes)
        if (i.n.focused)
            focused = i;
    return { tree, nodes, wins, focused };
}

function tiledOn(a, wsName) {
    return a.wins.filter(i => !i.floating && i.ws && i.ws.name === wsName);
}

function wsNodes(a) {
    return [...a.nodes.values()].filter(i => i.n.type === "workspace").map(i => i.n);
}

const LCODE = { splith: "h", splitv: "v", tabbed: "t", stacked: "s" };

function normNode(n) {
    if (!(n.nodes && n.nodes.length))
        return { w: n.id };
    const kids = n.nodes.map(normNode);
    if (kids.length === 1 && (n.layout === "splith" || n.layout === "splitv"))
        return kids[0];
    return { l: LCODE[n.layout] || n.layout, c: kids };
}

function normWs(ws) {
    const kids = (ws.nodes || []).map(normNode);
    if (!kids.length)
        return null;
    if (kids.length === 1 && ws.layout !== "tabbed" && ws.layout !== "stacked")
        return kids[0];
    return { l: LCODE[ws.layout] || ws.layout, c: kids };
}

// Independent model of Hyprland dwindle (force_split = 2, preserve_split).
function mContains(n, id) {
    return !!n && (n.id === id || (!!n.a && (mContains(n.a, id) || mContains(n.b, id))));
}

function mRemove(n, id) {
    if (!n)
        return null;
    if (!n.a)
        return n.id === id ? null : n;
    const a = mRemove(n.a, id), b = mRemove(n.b, id);
    if (!a)
        return b;
    if (!b)
        return a;
    return { d: n.d, a, b };
}

function mLeaves(n, out = []) {
    if (!n)
        return out;
    if (!n.a)
        out.push(n.id);
    else {
        mLeaves(n.a, out);
        mLeaves(n.b, out);
    }
    return out;
}

function mBox(n, id, r) {
    if (!n.a)
        return n.id === id ? r : null;
    const h = n.d === "h";
    const ra = h ? { w: (r.w - GAP) / 2, h: r.h } : { w: r.w, h: (r.h - GAP) / 2 };
    return mBox(n.a, id, ra) || mBox(n.b, id, ra);
}

function mSplit(n, id, newId, d) {
    if (!n.a)
        return n.id === id ? { d, a: n, b: { id: newId } } : n;
    return { d: n.d, a: mSplit(n.a, id, newId, d), b: mSplit(n.b, id, newId, d) };
}

function mNorm(w) {
    if (w.kind === "empty")
        return null;
    if (w.kind === "tabbed")
        return { l: "t", c: w.list.map(id => ({ w: id })) };
    const conv = n => (n.a ? { l: n.d, c: [conv(n.a), conv(n.b)] } : { w: n.id });
    return conv(w.root);
}

function normEq(e, a) {
    if (!e || !a)
        return !e && !a;
    if (e.w !== undefined)
        return a.w === e.w || (a.l === "t" && a.c.length === 1 && a.c[0].w === e.w);
    if (e.l === "t" && e.c.length === 1 && a.w === e.c[0].w)
        return true;
    if (a.w !== undefined || a.l !== e.l || a.c.length !== e.c.length)
        return false;
    return e.c.every((c, i) => normEq(c, a.c[i]));
}

class Replica {
    constructor(L, sc) {
        this.L = L;
        this.sc = sc;
        this.st = L.newState();
        this.queue = [];
        this.busy = false;
        this.pending = null;
        this.timer = null;
        this.dead = false;
    }

    idle() {
        return !this.busy && !this.queue.length && !this.timer;
    }

    enqueue(job) {
        if (job.kind === "tidy" && this.queue.some(j => j.kind === "tidy"))
            return;
        job.tq = now();
        this.queue = this.queue.concat([job]);
        this.pump();
    }

    // Mirrors DwindleDaemon.qml: "socket" is the persistent text socket with Logic.ipcMessage /
    // Logic.ipcReply framing, "swaymsg" the old two-processes-per-job plumbing (and the fallback).
    connect() {
        if (this.sc.opts.transport !== "socket")
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const s = net.createConnection(this.sc.sway.sock);
            s.setEncoding("utf8");
            s.once("connect", () => resolve());
            s.once("error", reject);
            s.on("data", d => this.onReply(d));
            this.sock = s;
        });
    }

    pump() {
        if (this.dead || this.busy || !this.queue.length)
            return;
        this.busy = true;
        const next = this.L.nextJob(this.queue);
        this.pending = next.job;
        this.queue = next.rest;
        clearTimeout(this.timer);
        this.timer = null;
        this.pending.t0 = now();
        this.sc.lastJobStart = this.pending.t0;
        this.request("tree", 4, "");
    }

    request(kind, type, payload) {
        this.expect = kind;
        if (this.sock) {
            this.buf = "";
            this.sock.write(this.L.ipcMessage(type, payload), "utf8");
        } else if (kind === "tree") {
            execFile("swaymsg", ["-t", "get_tree", "-r"], { env: this.sc.sway.env, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
                if (err && !this.dead)
                    this.sc.note(`tree fetch failed: ${String(stderr || err).slice(0, 200)}`);
                let tree = null;
                try {
                    tree = this.L.parseTree(stdout);
                } catch (e) {
                    this.sc.fail("exception", `tree parse: ${e}`);
                }
                this.runJob(tree);
            });
        } else {
            execFile("swaymsg", ["-r", "--", payload], { env: this.sc.sway.env }, (err, stdout) => {
                let results = null;
                try {
                    results = JSON.parse(stdout);
                } catch (e) {}
                this.commandDone(results, err);
            });
        }
    }

    onReply(data) {
        if (!this.expect || this.dead)
            return;
        this.buf += data;
        const reply = this.L.ipcReply(this.buf);
        if (reply === undefined)
            return;
        this.buf = "";
        if (this.expect === "tree")
            this.runJob(reply);
        else
            this.commandDone(reply, null);
    }

    finish() {
        const job = this.pending;
        if (job) {
            job.t2 = now();
            this.sc.jobDone(job);
        }
        this.expect = "";
        this.busy = false;
        this.pending = null;
        this.pump();
    }

    runJob(tree) {
        if (!this.pending || this.dead)
            return;
        const job = this.pending;
        job.t1 = now();
        if (!tree)
            return this.finish();
        let res, t;
        try {
            const c0 = performance.now();
            t = this.L.index(tree);
            res = this.L.runJob(this.st, job, t);
            job.logicMs = performance.now() - c0;
        } catch (e) {
            this.sc.fail("exception", `${job.kind}: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
            return this.finish();
        }
        job.cmds = res.cmds.slice();
        this.sc.jobDecided(job, t, res);
        if (res.tidy)
            this.restartTidy();
        if (!res.cmds.length)
            return this.finish();
        this.request("cmd", 0, res.cmds.join("; "));
    }

    commandDone(results, err) {
        const job = this.pending;
        if (!Array.isArray(results))
            this.sc.fail("cmd-error", `no reply for ${job.kind}: ${String(err).slice(0, 200)}`);
        else
            results.forEach((r, i) => {
                if (!r.success)
                    this.sc.cmdError(job, i, r.error);
            });
        if (!Array.isArray(results) || !results.every(r => r.success))
            this.restartTidy();
        this.finish();
    }

    restartTidy() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.enqueue({ kind: "tidy" });
        }, 25);
    }

    swayEvent(type, e) {
        if (type === "binding") {
            const a = this.L.bindingAction(e.binding && e.binding.command);
            if (a)
                this.enqueue({ kind: a });
            return;
        }
        const own = e.change === "move" && this.st.ownMoves[e.container.id];
        const out = this.L.onWindowEvent(this.st, e.change, e.container);
        if (this.sc.opts.verbose && e.change === "move")
            this.sc.note(`  move ${this.sc.title(e.container.id)} type=${e.container.type} own=${!!own} jobs=${out.jobs.map(j => j.kind)}`);
        for (const j of out.jobs)
            this.enqueue(j);
        if (out.tidy)
            this.restartTidy();
    }
}

// The real DwindleDaemon.qml running in Quickshell, for end-to-end runs (--plugin qml). Its queue
// is not visible, so the harness waits for a quiet period, and the off list comes from its state file.
class QmlPlugin {
    constructor(sc) {
        this.sc = sc;
        this.queue = [];
        this.busy = false;
        this.timer = null;
    }

    get st() {
        let off = {};
        try {
            for (const n of JSON.parse(fs.readFileSync(path.join(this.state, "swaydesk/dwindle-off.json"), "utf8")))
                off[n] = true;
        } catch (e) {}
        return { off };
    }

    async start() {
        const dir = path.join(this.sc.sway.dir, "shell");
        fs.mkdirSync(path.join(dir, "Modules/Plugins"), { recursive: true });
        fs.mkdirSync(path.join(dir, "Dwindle"));
        fs.writeFileSync(path.join(dir, "Modules/Plugins/PluginComponent.qml"), "import QtQuick\nItem {}\n");
        fs.writeFileSync(path.join(dir, "shell.qml"), 'import Quickshell\nimport "Dwindle"\nShellRoot {\n    DwindleDaemon {}\n}\n');
        for (const f of ["DwindleDaemon.qml", "DwindleLogic.js"])
            fs.copyFileSync(path.join(path.dirname(LOGIC), f), path.join(dir, "Dwindle", f));
        this.state = path.join(this.sc.sway.dir, "state");
        this.log = "";
        this.proc = spawn("qs", ["-p", path.join(dir, "shell.qml")], { env: Object.assign({}, this.sc.sway.env, { XDG_STATE_HOME: this.state, QT_QPA_PLATFORM: "wayland" }), stdio: ["ignore", "pipe", "pipe"] });
        const onData = d => (this.log = (this.log + d).slice(-20000));
        this.proc.stdout.on("data", onData);
        this.proc.stderr.on("data", onData);
        const t0 = now();
        while (!/Configuration Loaded/.test(this.log)) {
            if (now() - t0 > 10000 || this.proc.exitCode !== null)
                throw new Error("quickshell did not start: " + this.log.slice(-400));
            await sleep(20);
        }
        await sleep(100);
    }

    idle() {
        return now() - this.sc.lastEvent > 150;
    }

    // Bindings reach the plugin as real Sway binding events from the virtual pointer's side buttons.
    swayEvent(type, e) {
        if (type !== "binding")
            return;
        const button = /tabs/.test(e.binding.command) ? 275 : 276;
        this.sc.inflight++;
        this.sc.pointer.send(`b ${button} 1`).then(() => this.sc.pointer.send(`b ${button} 0`)).then(() => {
            this.sc.inflight--;
            this.sc.lastAction = now();
        });
    }

    close() {
        try {
            this.proc.kill("SIGKILL");
        } catch (e) {}
        const m = /(dwindle: |TypeError|ReferenceError|SyntaxError|RangeError)[^\n]*/.exec(this.log);
        if (m)
            this.sc.fail("qml-error", m[0]);
    }
}

class Scenario {
    constructor(L, client, index, seed, opts) {
        this.L = L;
        this.client = client;
        this.index = index;
        this.seed = seed;
        this.opts = opts;
        this.rng = rngFrom(seed);
        this.failures = [];
        this.benign = 0;
        this.log = [];
        this.clients = new Map();
        this.byCon = new Map();
        this.seq = 0;
        this.lastEvent = now();
        this.lastAction = now();
        this.extAt = 0;
        this.inflight = 0;
        this.latency = [];
        this.logicMs = 0;
        this.jobs = 0;
        this.mru = [];
        this.ops = [];
        this.model = new Map();
        this.everOff = new Set();
        this.actionAt = 0;
        this.lastJobStart = 0;
        this.silentChecks = 0;
        this.drags = 0;
        this.cmdErrors = [];
        this.fsAt = new Set();
        this.fsWs = new Map();
        this.prev = null;
        this.t0 = now();
    }

    note(s) {
        this.log.push(`${(now() - this.t0).toFixed(0)} ${s}`);
        if (this.opts.verbose)
            console.log(`  ${(now() - this.t0).toFixed(0)} ${s}`);
    }

    fail(type, msg) {
        if (this.failures.length < 20)
            this.failures.push({ type, msg });
        this.note(`FAIL ${type}: ${msg}`);
    }

    title(id) {
        const c = this.byCon.get(id);
        return c ? c.title : `#${id}`;
    }

    fmt(n) {
        if (!n)
            return "-";
        if (n.w !== undefined)
            return this.title(n.w);
        return `${n.l}(${n.c.map(c => this.fmt(c)).join(",")})`;
    }

    raw(n) {
        if (!(n.nodes && n.nodes.length))
            return this.title(n.id);
        return `${n.type === "workspace" ? "ws" : ""}${LCODE[n.layout] || n.layout}${n.id}(${n.nodes.map(c => this.raw(c)).join(",")})`;
    }

    rawRect(n) {
        const s = `${this.title(n.id)}[${n.rect.width}x${n.rect.height}]`;
        if (!(n.nodes && n.nodes.length))
            return s;
        return `${LCODE[n.layout] || n.layout}${s}(${n.nodes.map(c => this.rawRect(c)).join(",")})`;
    }

    pick(arr) {
        return arr[Math.floor(this.rng() * arr.length)];
    }

    async cmd(c) {
        this.inflight++;
        this.extAt = now();
        try {
            const r = await this.sway.ipc.send(0, c);
            const ok = Array.isArray(r) ? r.every(x => x.success) : false;
            this.note(`> ${c}${ok ? "" : "  (err: " + (Array.isArray(r) ? r.filter(x => !x.success).map(x => x.error).join("; ") : "?") + ")"}`);
            return r;
        } catch (e) {
            this.note(`> ${c} (ipc: ${e.message})`);
            return null;
        } finally {
            this.inflight--;
            this.lastAction = now();
        }
    }

    async tree() {
        return analyze(await this.sway.ipc.send(4));
    }

    open(kind) {
        const n = ++this.seq;
        const appId = kind === "dialog" ? "dwdialog" : this.pick(APPS);
        const title = `w${n}`;
        const args = [appId, title];
        if (kind === "fixed")
            args.push("fixed");
        this.extAt = now();
        const p = spawn(this.client, args, { env: this.sway.env, stdio: ["ignore", "ignore", "pipe"] });
        const c = { pid: p.pid, proc: p, title, appId, kind, conId: null, exited: false, closing: false, floatingKind: kind !== "normal", err: "" };
        p.stderr.on("data", d => (c.err = (c.err + d).slice(-300)));
        this.clients.set(p.pid, c);
        p.on("exit", (code, signal) => {
            c.exited = true;
            this.lastEvent = now();
            setTimeout(() => {
                if (!c.closing && !this.stopping)
                    this.fail("client-died", `${title} exited unexpectedly (${code === null ? signal : "code " + code}) ${c.err.trim()}`);
            }, 500);
        });
        this.note(`open ${title} ${appId}${kind !== "normal" ? " " + kind : ""}`);
    }

    alive() {
        return [...this.clients.values()].filter(c => !c.exited && c.conId != null);
    }

    onSway(type, msg) {
        this.lastEvent = now();
        if (type === 6)
            return;
        if (type !== 3 || !msg)
            return;
        const c = msg.container || {};
        if (msg.change === "new" || msg.change === "close")
            this.extAt = now();
        if (msg.change === "new")
            this.lastNewAt = now();
        if (msg.change === "close")
            this.lastCloseAt = now();
        if (msg.change === "new" && c.pid) {
            const cl = this.clients.get(c.pid);
            if (cl) {
                cl.conId = c.id;
                this.byCon.set(c.id, cl);
            }
        }
        if (msg.change === "focus")
            this.mru = [c.id].concat(this.mru.filter(i => i !== c.id));
        if (msg.change === "close") {
            this.mru = this.mru.filter(i => i !== c.id);
            const cl = this.byCon.get(c.id);
            if (cl)
                cl.closing = true;
        }
        if (this.modelMode) {
            if (msg.change === "new")
                this.ops.push({ op: "new", id: c.id, snap: this.mru.slice() });
            else if (msg.change === "close")
                this.ops.push({ op: "close", id: c.id });
            else if (msg.change === "floating")
                this.ops.push({ op: "floating", id: c.id, tiled: c.type === "con", snap: this.mru.filter(i => i !== c.id) });
        }
        if (this.replica instanceof QmlPlugin && /^(new|close|move|floating)$/.test(msg.change))
            this.lastJobStart = now();
        this.note(`ev ${msg.change} ${this.title(c.id)}${msg.change === "floating" ? " " + c.type : ""}${msg.change === "fullscreen_mode" ? " " + c.fullscreen_mode : ""}`);
        this.replica.swayEvent("window", JSON.parse(JSON.stringify(msg)));
    }

    jobDecided(job, t, res) {
        this.jobs++;
        this.logicMs += job.logicMs || 0;
        if (this.opts.verbose && job.id && t.ids[job.id]) {
            const n = t.ids[job.id], x = n._parent;
            const r = k => `${this.title(k.id)}:${k.layout}:${k.rect.width}x${k.rect.height}`;
            this.note(`  tree n=${r(n)} x=${x ? r(x) : "-"} kids=[${x ? (x.nodes || []).map(r).join(" ") : ""}]`);
            if (x && x._ws)
                this.note(`  ws ${this.rawRect(x._ws)} layout=${x._ws.layout}`);
            const pm = res.cmds.length && /^\[con_id=(\d+)[^\]]*\] mark --add _dw_p/.exec(res.cmds.find(c => c.includes("_dw_p")) || "");
            if (pm && t.ids[pm[1]]) {
                const s = this.L.slotOf(this.replica.st, t.ids[pm[1]], job.id);
                this.note(`  slot of ${this.title(+pm[1])}: ${s.width.toFixed(0)}x${s.height.toFixed(0)}`);
            }
        }
        if (this.opts.verbose && job.kind === "tidy" && res.cmds.length)
            for (const id in t.ids)
                if (t.ids[id].type === "workspace" && t.ids[id].nodes.length)
                    this.note(`  ws ${t.ids[id].name}: ${this.rawRect(t.ids[id])}`);
        if (res.cmds.length)
            this.note(`job ${job.kind}${job.id ? " " + this.title(job.id) : ""}: ${res.cmds.join("; ").replace(/con_id=(\d+)/g, (m, id) => "con_id=" + this.title(+id))}`);
        else if (job.kind !== "tidy")
            this.note(`job ${job.kind}${job.id ? " " + this.title(job.id) : ""}: -`);
        for (const c of res.cmds) {
            const m = /^\[con_id=(\d+).*?\] (\w+)( container| tabbed| split\w)?/.exec(c);
            if (!m)
                continue;
            const n = t.ids[m[1]];
            if (!n)
                continue;
            const wsName = n._ws ? n._ws.name : "";
            if (job.kind !== "tabs" && this.replica.st.off[wsName])
                this.fail("off-touched", `${job.kind} touched ${this.title(n.id)} on disabled workspace ${wsName}: ${c}`);
            if (m[2] === "split" && /split [hv]$/.test(c) && n.fullscreen_mode > 0)
                this.fail("split-fullscreen", `${c} on fullscreen ${this.title(n.id)}`);
            if ((m[2] === "split" || m[2] === "move") && (n._floating || n.type === "floating_con") && !/ tiling[\] ]/.test(c))
                this.fail("floating-touched", `${c} on floating ${this.title(n.id)}`);
        }
    }

    // An error is a race when something outside the plugin changed the tree while the job ran.
    cmdError(job, i, error) {
        const c = job.cmds[i] || "";
        const race = this.extAt >= job.t0 - 5;
        this.cmdErrors.push({ job: job.kind, cmd: c, error, race });
        this.note(`cmd error in ${job.kind}${race ? " (race)" : ""}: ${c} -> ${error}`);
    }

    jobDone(job) {
        this.latency.push(+(job.t2 - job.t0).toFixed(2));
        this.lastJobEnd = job.t2;
        if (job.t1) {
            (this.fetchMs = this.fetchMs || []).push(job.t1 - job.t0);
            if (job.cmds && job.cmds.length)
                (this.cmdMs = this.cmdMs || []).push(job.t2 - job.t1 - (job.logicMs || 0));
        }
    }

    async settle(why) {
        const t0 = now();
        for (;;) {
            const cl = [...this.clients.values()];
            const unmapped = cl.filter(c => !c.exited && c.conId == null);
            const closing = cl.filter(c => c.closing && !c.exited);
            if (!unmapped.length && !closing.length && this.replica.idle() && this.inflight === 0 && now() - Math.max(this.lastEvent, this.lastAction) >= QUIET_MS)
                return true;
            if (now() - t0 > SETTLE_TIMEOUT_MS) {
                this.fail("stall", `${why}: unmapped=${unmapped.map(c => c.title)} closing=${closing.map(c => c.title)} busy=${this.replica.busy} queue=${this.replica.queue.map(j => j.kind)} timer=${!!this.replica.timer}`);
                return false;
            }
            if (this.sway.exited()) {
                this.fail("sway-crash", this.sway.stderr().slice(-600));
                return false;
            }
            await sleep(4);
        }
    }

    // Checks that hold after every quiescent point.
    check(a, stage) {
        for (const o of Object.keys(this.replica.st.off))
            this.everOff.add(o);
        // Some changes reach Sway's tree with no IPC event (a mouse drop back onto its own spot, a
        // move to the workspace the window is already on). The plugin sees them at its next tree
        // read, so tidiness is only required once a job ran after the last action.
        const unseen = this.actionAt > this.lastJobStart;
        if (unseen)
            this.silentChecks++;
        const count = new Map();
        for (const w of a.wins)
            count.set(w.n.pid, (count.get(w.n.pid) || 0) + 1);
        for (const c of this.clients.values()) {
            if (c.exited)
                continue;
            const k = count.get(c.pid) || 0;
            if (k !== 1)
                this.fail("window-lost", `${stage}: ${c.title} found ${k} times`);
        }
        for (const [pid] of count)
            if (!this.clients.has(pid) || this.clients.get(pid).exited)
                this.fail("window-ghost", `${stage}: unknown window pid ${pid}`);
        for (const [, i] of a.nodes) {
            const n = i.n;
            const wsName = i.ws ? i.ws.name : "";
            if ((n.marks || []).some(m => m.startsWith("_dw")))
                this.fail("mark-left", `${stage}: ${this.title(n.id)} keeps marks ${n.marks}`);
            // Sway itself wraps floating and fullscreen windows on some drops and output moves, so
            // the plugin's part is checked on its own commands in jobDecided() instead.
            if (wsName === "__i3_scratch" && n.type === "con" && !i.floating)
                this.fail("scratch-tiled", `${stage}: tiled node ${this.title(n.id)} in scratchpad`);
            if (!unseen && n.type === "con" && !i.floating && (n.layout === "splith" || n.layout === "splitv") && i.parent && i.parent.type !== "workspace" && (n.nodes || []).length === 1 && wsName && wsName !== "__i3_scratch" && !this.everOff.has(wsName))
                this.fail("single-child", `${stage}: ${n.layout} ${n.id} on ${wsName} wraps only ${this.title(n.nodes[0].id)}`);
        }
        for (const e of this.cmdErrors) {
            if (e.race)
                this.benign++;
            else
                this.fail("cmd-error", `${e.job}: ${e.cmd.replace(/con_id=(\d+)/g, (m, id) => "con_id=" + this.title(+id))} -> ${e.error}`);
        }
        this.cmdErrors = [];
    }

    // Model bookkeeping, applied once per settled step.
    mws(name) {
        if (!this.model.has(name))
            this.model.set(name, { kind: "empty", root: null, list: [], impure: "", held: [] });
        return this.model.get(name);
    }

    mFind(id) {
        for (const [name, w] of this.model) {
            if (w.kind === "dwindle" && mContains(w.root, id))
                return name;
            if (w.kind === "tabbed" && w.list.includes(id))
                return name;
        }
        return null;
    }

    mDrop(id) {
        for (const [, w] of this.model) {
            w.held = w.held.filter(h => h.id !== id);
            if (w.kind === "dwindle" && mContains(w.root, id)) {
                w.root = mRemove(w.root, id);
                if (!w.root)
                    w.kind = "empty";
            } else if (w.kind === "tabbed" && w.list.includes(id)) {
                w.list = w.list.filter(x => x !== id);
                if (!w.list.length)
                    w.kind = "empty";
            }
        }
    }

    mInsert(a, wsName, id, snap, held, dir) {
        if (!wsName || wsName === "__i3_scratch")
            return;
        const w = this.mws(wsName);
        if (this.replica.st.off[wsName]) {
            w.impure = w.impure || "off";
            return;
        }
        if (w.impure)
            return;
        // Sway puts a window opened into tabs next to the focused tab; nothing waits for fullscreen there.
        if (!held && (this.fsWs.get(wsName) || []).some(fid => fid !== id && (w.kind !== "tabbed" || !this.fsAt.has(fid)))) {
            w.held.push({ id, snap });
            return;
        }
        const ws = [...a.nodes.values()].find(i => i.n.type === "workspace" && i.n.name === wsName);
        const rect = ws ? { w: ws.n.rect.width, h: ws.n.rect.height } : null;
        // A tab group moved onto an empty workspace becomes its layout; windows join those tabs.
        if (ws && w.kind !== "tabbed" && (ws.n.layout === "tabbed" || ws.n.layout === "stacked")) {
            w.impure = "workspace layout is tabbed";
            return;
        }
        if (w.kind === "empty") {
            w.kind = "dwindle";
            w.root = { id };
            return;
        }
        if (w.kind === "tabbed") {
            const p = snap.find(s => s !== id && w.list.includes(s));
            if (p === undefined) {
                w.impure = `no partner for ${this.title(id)} in tabs`;
                return;
            }
            w.list.splice(w.list.indexOf(p) + 1, 0, id);
            return;
        }
        const leaves = mLeaves(w.root);
        const p = snap.find(s => s !== id && leaves.includes(s));
        if (p === undefined) {
            w.impure = `no partner for ${this.title(id)}`;
            return;
        }
        if (this.fsAt.has(p)) {
            w.impure = "partner fullscreen";
            return;
        }
        if (dir === "h" || dir === "v") {
            w.root = mSplit(w.root, p, id, dir);
            return;
        }
        const box = mBox(w.root, p, rect);
        if (Math.abs(box.w - box.h) < 24) {
            w.impure = `ambiguous split of ${this.title(p)} ${box.w}x${box.h}`;
            return;
        }
        w.root = mSplit(w.root, p, id, box.w > box.h ? "h" : "v");
    }

    applyModel(a, action) {
        const ops = this.ops;
        this.ops = [];
        const winInfo = id => a.wins.find(i => i.n.id === id);
        for (const o of ops) {
            if (o.op === "new") {
                const i = winInfo(o.id);
                if (i && !i.floating)
                    this.mInsert(a, i.ws && i.ws.name, o.id, o.snap, false);
            } else if (o.op === "close") {
                this.mDrop(o.id);
            } else if (o.op === "floating") {
                const i = winInfo(o.id);
                if (o.tiled && i && !i.floating) {
                    this.mDrop(o.id);
                    this.mInsert(a, i.ws && i.ws.name, o.id, o.snap, false);
                } else if (!o.tiled) {
                    this.mDrop(o.id);
                }
            }
        }
        // Moves between workspaces and to the scratchpad. A focused container carries several
        // windows at once; the model does not follow that.
        const movers = a.wins.filter(i => {
            const at = this.mFind(i.n.id);
            return at !== null && !i.floating && at !== (i.ws ? i.ws.name : "");
        });
        if (movers.length > 1)
            for (const i of movers) {
                this.mws(this.mFind(i.n.id)).impure = "container moved";
                this.mws(i.ws.name).impure = "container moved";
            }
        for (const i of a.wins) {
            const id = i.n.id;
            const at = this.mFind(id);
            const wsName = i.ws ? i.ws.name : "";
            if (at === null && !i.floating && wsName !== "__i3_scratch" && !this.mws(wsName).held.some(h => h.id === id)) {
                if (!this.mws(wsName).impure)
                    this.mws(wsName).impure = `untracked ${this.title(id)}`;
                continue;
            }
            if (at !== null && (i.floating || at !== wsName)) {
                this.mDrop(id);
                // Sway inserts a window moved by command after its last focused tile there.
                const sib = i.floating ? [] : i.parent.nodes;
                const prev = sib[sib.indexOf(i.n) - 1];
                if (i.floating || wsName === "__i3_scratch")
                    continue;
                // A window moved while fullscreen reorders the held queue there; the model stops.
                if (i.n.fullscreen_mode > 0) {
                    this.mws(wsName).impure = this.mws(wsName).impure || "fullscreen window moved in";
                    continue;
                }
                // A pair Sway already formed keeps its direction.
                if (prev && !(prev.nodes && prev.nodes.length))
                    this.mInsert(a, wsName, id, [prev.id], false, sib.length === 2 ? LCODE[i.parent.layout] : "");
                else if (this.mws(wsName).kind !== "empty" && !this.mws(wsName).impure)
                    this.mws(wsName).impure = `moved ${this.title(id)} not after a tile`;
                else
                    this.mInsert(a, wsName, id, [], false);
            }
        }
        this.fsAt = new Set(a.wins.filter(i => !i.floating && i.n.fullscreen_mode > 0).map(i => i.n.id));
        // Workspaces covered by a fullscreen tile or container (the plugin holds new windows there).
        this.fsWs = new Map();
        for (const [, i] of a.nodes)
            if (i.n.type === "con" && !i.floating && i.n.fullscreen_mode > 0 && i.ws)
                this.fsWs.set(i.ws.name, (this.fsWs.get(i.ws.name) || []).concat([i.n.id]));
        // Held windows are placed once their workspace has no fullscreen window.
        for (const [name, w] of this.model) {
            if (!w.held.length || (this.fsWs.get(name) || []).length)
                continue;
            const h = w.held;
            w.held = [];
            for (const x of h)
                if (winInfo(x.id) && !winInfo(x.id).floating)
                    this.mInsert(a, name, x.id, x.snap, true);
        }
        for (const ws of wsNodes(a)) {
            if (ws.name === "__i3_scratch")
                continue;
            const w = this.mws(ws.name);
            if (!tiledOn(a, ws.name).length && !w.held.length && !this.replica.st.off[ws.name])
                Object.assign(w, { kind: "empty", root: null, list: [], impure: "" });
        }
    }

    compareModel(a, stage) {
        for (const ws of wsNodes(a)) {
            if (ws.name === "__i3_scratch")
                continue;
            const w = this.mws(ws.name);
            if (w.impure || w.held.length || this.replica.st.off[ws.name])
                continue;
            const act = normWs(ws);
            // Sway orders tabs by its own focus stack; only the membership is the plugin's business.
            if (w.kind === "tabbed" && act && act.l === "t" && act.c.every(c => c.w !== undefined) && act.c.length === w.list.length && act.c.every(c => w.list.includes(c.w)))
                w.list = act.c.map(c => c.w);
            const exp = mNorm(w);
            if (!normEq(exp, act)) {
                this.fail("model-mismatch", `${stage}: ws ${ws.name} ${ws.rect.width}x${ws.rect.height} expected ${this.fmt(exp)} got ${this.fmt(act)}`);
                w.impure = "mismatch reported";
            }
        }
    }

    markImpure(a, why) {
        const f = a && a.focused;
        const wsName = f ? (f.n.type === "workspace" ? f.n.name : f.ws && f.ws.name) : null;
        if (wsName)
            this.mws(wsName).impure = this.mws(wsName).impure || why;
    }

    // Tabs on/off result check, given the trees around one settled tabs press.
    checkTabs(before, after) {
        const f = before.focused;
        if (!f)
            return;
        const wsName = f.n.type === "workspace" ? f.n.name : f.ws && f.ws.name;
        if (!wsName || wsName === "__i3_scratch")
            return;
        const v = tiledOn(before, wsName);
        if (v.length < 2 || [...before.nodes.values()].some(i => i.ws && i.ws.name === wsName && !i.floating && i.n.type === "con" && i.n.fullscreen_mode > 0))
            return;
        const p0 = v[0].parent;
        const wasTabbed = p0.layout === "tabbed" && v.every(i => i.parent === p0);
        const v2 = tiledOn(after, wsName);
        const order = l => l.map(i => this.title(i.n.id)).join(",");
        if (!wasTabbed) {
            const p = v2[0] && v2[0].parent;
            const ok = p && p.layout === "tabbed" && v2.every(i => i.parent === p) && v2.length === v.length;
            const tabbedCount = [...after.nodes.values()].filter(i => i.ws && i.ws.name === wsName && i.n.layout === "tabbed" && i.n.type !== "workspace" && !i.floating).length + (after.nodes.get(p ? p.id : -1) && p.type === "workspace" ? 1 : 0);
            if (!ok || tabbedCount !== 1)
                this.fail("tabs-on", `ws ${wsName}: expected one tabbed container with ${order(v)}, got ${this.fmt(normWs(after.nodes.get(v2[0] ? v2[0].ws.id : 0).n))}`);
            else if (order(v) !== order(v2))
                this.fail("tabs-on", `ws ${wsName}: tab order ${order(v2)} differs from tree order ${order(v)}`);
        } else {
            const ws = after.nodes.get(v2[0].ws.id).n;
            const bin = n => !(n.nodes && n.nodes.length) || (n.nodes.length === 2 && (n.layout === "splith" || n.layout === "splitv") && n.nodes.every(bin));
            let top = ws;
            while (top.nodes.length === 1 && top.nodes[0].nodes && top.nodes[0].nodes.length)
                top = top.nodes[0];
            if (!(top.nodes.length === 2 && top.nodes.every(bin)) || order(v) !== order(v2))
                this.fail("tabs-off", `ws ${wsName}: expected binary dwindle of ${order(v)}, got ${this.raw(ws)}`);
        }
        if (f.n.pid > 0 && (!after.focused || after.focused.n.id !== f.n.id))
            this.fail("tabs-focus", `ws ${wsName}: focus moved from ${this.title(f.n.id)} to ${after.focused ? this.title(after.focused.n.id) : "-"}`);
    }

    async step(a) {
        const ok = await this.settle(a);
        if (!ok)
            return null;
        const t = await this.tree();
        if (this.modelMode) {
            this.applyModel(t, a);
            if (this.pendingTabs) {
                this.pendingTabs = false;
                this.resyncTabs(t);
            }
        }
        this.check(t, a);
        if (this.modelMode)
            this.compareModel(t, a);
        this.prev = t;
        return t;
    }

    // Mouse helpers. Coordinates are layout pixels; the pointer maps them onto the output layout box.
    visibleWs(a) {
        const out = new Set();
        for (const [, i] of a.nodes)
            if (i.n.type === "output" && i.n.name !== "__i3" && i.n.focus && i.n.focus.length)
                out.add(i.n.focus[0]);
        return out;
    }

    shown(a, i) {
        let child = i.n, p = i.parent;
        while (p && p.type !== "workspace") {
            if ((p.layout === "tabbed" || p.layout === "stacked") && p !== i.parent && p.focus[0] !== child.id)
                return false;
            child = p;
            p = a.nodes.get(p.id).parent;
        }
        return !!p && this.visibleWs(a).has(p.id) && !tiledOn(a, p.name).some(w => w.n.fullscreen_mode > 0);
    }

    titlePoint(i) {
        const n = i.n, p = i.parent;
        const cx = r => Math.round(r.x + r.width / 2);
        if (n.type === "floating_con") {
            const wy = n.window_rect ? n.window_rect.y : 0;
            return { x: cx(n.rect), y: Math.round(wy >= 15 ? n.rect.y + wy / 2 : n.rect.y - 10) };
        }
        if (i.floating || !n.deco_rect || n.deco_rect.height <= 0)
            return null;
        const k = p.nodes.indexOf(n);
        if (p.layout === "tabbed")
            return { x: Math.round(p.rect.x + (k + 0.5) * p.rect.width / p.nodes.length), y: Math.round(p.rect.y + n.deco_rect.height / 2) };
        if (p.layout === "stacked")
            return { x: cx(p.rect), y: Math.round(p.rect.y + (k + 0.5) * n.deco_rect.height) };
        return { x: cx(n.rect), y: Math.round(n.rect.y - n.deco_rect.height / 2) };
    }

    async pointerTo(a, x, y) {
        const o = [...a.nodes.values()].filter(i => i.n.type === "output" && i.n.name !== "__i3").map(i => i.n.rect);
        const x0 = Math.min(...o.map(r => r.x)), y0 = Math.min(...o.map(r => r.y));
        const w = Math.max(...o.map(r => r.x + r.width)) - x0, h = Math.max(...o.map(r => r.y + r.height)) - y0;
        const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
        await this.pointer.send(`a ${cl(x - x0, 0, w - 1)} ${cl(y - y0, 0, h - 1)} ${w} ${h}`);
    }

    async drag(a, from, to, button = 272) {
        this.inflight++;
        this.extAt = now();
        try {
            this.note(`drag ${button === 272 ? "left" : "right"} ${from.x},${from.y} -> ${to.x},${to.y}`);
            this.actionAt = now();
            await this.pointerTo(a, from.x, from.y);
            await this.pointer.send(`b ${button} 1`);
            const steps = 2 + Math.floor(this.rng() * 4);
            for (let s = 1; s <= steps; s++)
                await this.pointerTo(a, from.x + (to.x - from.x) * s / steps, from.y + (to.y - from.y) * s / steps);
            await this.pointer.send(`b ${button} 0`);
            this.drags++;
        } finally {
            this.inflight--;
            this.extAt = now();
            this.lastAction = now();
        }
    }

    async mouse(kind) {
        // Sway 1.12 segfaults when another window of the split goes to the scratchpad during a
        // title bar drag, with or without the plugin; let pending transactions land before pressing.
        if (!(await this.settle("before drag")))
            return [];
        const a = await this.tree();
        const wsOfInfo = i => i.ws && i.ws.name;
        if (kind === "dragResize") {
            const cands = a.wins.filter(i => !i.floating && this.shown(a, i) && (i.parent.layout === "splith" || i.parent.layout === "splitv") && i.parent.nodes.indexOf(i.n) < i.parent.nodes.length - 1);
            if (!cands.length)
                return [];
            const i = this.pick(cands), r = i.n.rect, d = (this.rng() < 0.5 ? -1 : 1) * (40 + Math.floor(this.rng() * 160));
            const from = i.parent.layout === "splith" ? { x: r.x + r.width - 1, y: r.y + r.height / 2 } : { x: r.x + r.width / 2, y: r.y + r.height - 1 };
            const to = i.parent.layout === "splith" ? { x: from.x + d, y: from.y } : { x: from.x, y: from.y + d };
            await this.drag(a, from, to);
            return [wsOfInfo(i)];
        }
        if (kind === "dragFloat") {
            const cands = a.wins.filter(i => i.n.type === "floating_con" && this.shown(a, i));
            if (!cands.length)
                return [];
            const i = this.pick(cands), from = this.titlePoint(i);
            await this.drag(a, from, { x: from.x + Math.floor((this.rng() - 0.5) * 1200), y: from.y + Math.floor((this.rng() - 0.3) * 600) });
            return [wsOfInfo(i)];
        }
        // Drag a tiled window or tab by its title onto a drop zone of another visible window.
        const src = a.wins.filter(i => !i.floating && this.shown(a, i) && this.titlePoint(i));
        if (!src.length)
            return [];
        const i = this.pick(src);
        const targets = a.wins.filter(t => !t.floating && t !== i && this.shown(a, t) && (!(t.parent.layout === "tabbed" || t.parent.layout === "stacked") || t.parent.focus[0] === t.n.id));
        const from = this.titlePoint(i);
        let to, target = null;
        if (!targets.length || this.rng() < 0.1) {
            const outs = [...a.nodes.values()].filter(o => o.n.type === "output" && o.n.name !== "__i3");
            const r = this.pick(outs).n.rect;
            to = { x: r.x + r.width * (0.1 + 0.8 * this.rng()), y: r.y + r.height * (0.1 + 0.8 * this.rng()) };
        } else {
            target = this.pick(targets);
            const r = target.n.rect;
            const z = this.pick([[0.5, 0.5], [0.06, 0.5], [0.94, 0.5], [0.5, 0.06], [0.5, 0.94]]);
            to = { x: r.x + r.width * z[0], y: r.y + r.height * z[1] };
        }
        await this.drag(a, from, to);
        const vis = this.visibleWs(a);
        return wsNodes(a).filter(w => vis.has(w.id)).map(w => w.name);
    }

    // One user-story step with explicit targets.
    async tstep(s) {
        const list = () => this.alive().filter(c => c.kind === "normal");
        const win = sel => {
            const l = list();
            if (sel === "same")
                return this.picked && !this.picked.exited ? this.picked : null;
            if (!l.length)
                return null;
            const c = sel === "first" ? l[0] : sel === "last" ? l[l.length - 1] : sel === "mid" ? l[Math.floor(l.length / 2)] : typeof sel === "number" ? l[Math.min(sel, l.length - 1)] : this.pick(l);
            this.picked = c;
            return c;
        };
        const on = (c, cmd) => (c ? this.cmd(`[con_id=${c.conId}] ${cmd}`) : null);
        switch (s.k) {
        case "open":
            this.open("normal");
            break;
        case "burst":
            for (let i = 0; i < s.n; i++)
                this.open("normal");
            break;
        case "close":
            await on(win(s.w), "kill");
            break;
        case "focus":
            await on(win(s.w), "focus");
            break;
        case "fs":
            await on(win(s.w), "fullscreen toggle");
            break;
        case "float":
            await on(win(s.w), "floating toggle");
            break;
        case "scratch":
            await on(win(s.w), "move scratchpad");
            break;
        case "show":
            await on(this.picked, "scratchpad show");
            break;
        case "moveWs":
            await on(win(s.w), `move container to workspace number ${s.ws}`);
            break;
        case "ws":
            await this.cmd(`workspace number ${s.ws}`);
            break;
        case "key":
            await this.cmd(s.cmd);
            break;
        case "tabs":
            this.note("binding nop dwindle tabs");
            this.replica.swayEvent("binding", { change: "run", binding: { command: "nop dwindle tabs" } });
            break;
        case "resize":
            await this.mouse("dragResize");
            break;
        case "drag":
        case "dragFloat":
            await this.dragSpec(s, win);
            break;
        }
    }

    async dragSpec(s, win) {
        if (!(await this.settle("before drag")))
            return;
        const a = await this.tree();
        const info = c => c && a.wins.find(i => i.n.id === c.conId);
        const src = s.k === "dragFloat" ? info(this.picked) : info(win(s.src));
        const from = src && this.shown(a, src) && this.titlePoint(src);
        if (!from)
            return;
        const srcOut = src.output;
        const vis = a.wins.filter(t => t !== src && !t.floating && this.shown(a, t) && (!(t.parent.layout === "tabbed" || t.parent.layout === "stacked") || t.parent.focus[0] === t.n.id));
        const others = vis.filter(t => t.output !== srcOut);
        let to;
        if (s.dst === "other" && !others.length) {
            const outs = [...a.nodes.values()].filter(o => o.n.type === "output" && o.n.name !== "__i3" && o.n !== srcOut);
            if (!outs.length && !vis.length)
                return;
            const r = outs.length ? outs[0].n.rect : this.pick(vis).n.rect;
            to = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        } else {
            const pool = s.dst === "other" ? others : s.dst === "first" || s.dst === "last" ? vis.filter(t => t.n.id === (win(s.dst) || {}).conId) : vis;
            if (!pool.length)
                return;
            const r = this.pick(pool).n.rect;
            const zones = { center: [0.5, 0.5], left: [0.06, 0.5], right: [0.94, 0.5], top: [0.5, 0.06], bottom: [0.5, 0.94] };
            const z = zones[s.edge] || (s.k === "dragFloat" ? zones.center : this.pick(Object.values(zones)));
            to = { x: r.x + r.width * z[0], y: r.y + r.height * z[1] };
        }
        if (this.modelMode)
            for (const w of wsNodes(a))
                if (this.visibleWs(a).has(w.id))
                    this.mws(w.name).impure = this.mws(w.name).impure || "drag";
        await this.drag(a, from, to);
    }

    async runTemplate() {
        const nT = TEMPLATE_NAMES.length;
        const name = TEMPLATE_NAMES[this.index % nT];
        this.out = OUTPUTS[Math.floor(this.index / nT) % OUTPUTS.length];
        const off = Math.floor(this.index / (nT * OUTPUTS.length)) % 2 === 1;
        this.template = `${name} | ${this.out.name} | dwindle ${off ? "off" : "on"}`;
        this.modelMode = true;
        const steps = TEMPLATES[name](this.rng);
        this.note(`template ${this.template} seed ${this.seed}`);
        await this.begin();
        if (off) {
            this.note("binding nop dwindle toggle");
            this.replica.swayEvent("binding", { change: "run", binding: { command: "nop dwindle toggle" } });
            this.prev = await this.step("dwindle off");
        }
        for (let i = 0; i < steps.length && this.prev !== null; i++) {
            const s = steps[i];
            this.note(`-- step ${i + 1}: ${JSON.stringify(s)}`);
            const before = this.prev;
            this.actionAt = now();
            if (s.k === "tabs")
                this.pendingTabs = true;
            if ((s.k === "resize" || s.k === "key") && this.prev) {
                const vis = this.visibleWs(this.prev);
                for (const w of wsNodes(this.prev))
                    if (vis.has(w.id))
                        this.mws(w.name).impure = this.mws(w.name).impure || s.k;
            }
            await this.tstep(s);
            this.prev = await this.step(`after ${s.k} #${i + 1}`);
            if (this.prev && s.k === "tabs")
                this.checkTabs(before, this.prev);
        }
        await this.finishRun();
    }

    actionTable(dual) {
        const M = this.modelMode;
        const T = [
            ["open", M ? 24 : 18],
            ["dialog", 4],
            ["burst", M ? 5 : 6],
            ["close", 9],
            ["focus", 6],
            ["focusDir", 4],
            ["ws", 5],
            ["moveWs", 5],
            ["float", 4],
            ["fs", 4],
            ["scratch", 3],
            ["tabs", 4],
            ["dwToggle", M ? 1 : 2],
            ["moveDir", M ? 1 : 5],
            ["resize", M ? 1 : 3],
            ["layoutSplit", M ? 1 : 3],
            ["focusParentOpen", 1],
            ["drag", M ? 2 : 7],
            ["dragFloat", M ? 1 : 2],
            ["dragResize", M ? 1 : 3],
        ];
        if (dual)
            T.push(["moveOut", 4], ["focusOut", 2]);
        return T;
    }

    choose(table) {
        const sum = table.reduce((s, x) => s + x[1], 0);
        let r = this.rng() * sum;
        for (const [k, w] of table) {
            r -= w;
            if (r < 0)
                return k;
        }
        return table[0][0];
    }

    async act(kind, dual) {
        const r = this.rng;
        const dirs = ["left", "right", "up", "down"];
        const alive = this.alive();
        switch (kind) {
        case "open":
            this.open("normal");
            break;
        case "dialog":
            this.open(r() < 0.5 ? "dialog" : "fixed");
            break;
        case "burst": {
            const k = 2 + (r() < 0.5 ? 1 : 0);
            for (let i = 0; i < k; i++)
                this.open(r() < 0.1 ? "dialog" : "normal");
            break;
        }
        case "close":
            if (!alive.length || r() < 0.4) {
                await this.cmd("kill");
            } else {
                const c = this.pick(alive);
                if (r() < 0.5) {
                    c.closing = true;
                    this.extAt = now();
                    this.note(`sigterm ${c.title}`);
                    c.proc.kill("SIGTERM");
                } else {
                    await this.cmd(`[con_id=${c.conId}] kill`);
                }
            }
            break;
        case "focus":
            if (alive.length)
                await this.cmd(`[con_id=${this.pick(alive).conId}] focus`);
            break;
        case "focusDir":
            await this.cmd(`focus ${this.pick(dirs)}`);
            break;
        case "ws": {
            const x = r();
            await this.cmd(x < 0.7 ? `workspace number ${1 + Math.floor(r() * 4)}` : x < 0.85 ? "workspace back_and_forth" : "workspace next_on_output");
            break;
        }
        case "moveWs": {
            const x = r();
            const k = 1 + Math.floor(r() * 4);
            if (x < 0.5)
                await this.cmd(`move container to workspace number ${k}`);
            else if (x < 0.75)
                await this.cmd(`move container to workspace number ${k}; workspace number ${k}`);
            else
                await this.cmd(`move container to workspace ${r() < 0.5 ? "next" : "prev"}`);
            break;
        }
        case "moveOut":
            await this.cmd(r() < 0.5 ? `move container to output ${r() < 0.5 ? "left" : "right"}` : `move container to output ${r() < 0.5 ? "HEADLESS-1" : "HEADLESS-2"}`);
            break;
        case "focusOut":
            await this.cmd(`focus output ${r() < 0.5 ? "left" : "right"}`);
            break;
        case "float":
            await this.cmd("floating toggle");
            break;
        case "fs":
            await this.cmd(!this.modelMode && r() < 0.15 ? "fullscreen toggle global" : "fullscreen toggle");
            break;
        case "scratch":
            await this.cmd(r() < 0.5 ? "move scratchpad" : "scratchpad show");
            break;
        case "tabs":
            this.note("binding nop dwindle tabs");
            this.replica.swayEvent("binding", { change: "run", binding: { command: "nop dwindle tabs" } });
            break;
        case "dwToggle":
            this.note("binding nop dwindle toggle");
            this.replica.swayEvent("binding", { change: "run", binding: { command: "nop dwindle toggle" } });
            break;
        case "moveDir":
            await this.cmd(`move ${this.pick(dirs)}`);
            break;
        case "resize":
            await this.cmd(`resize ${r() < 0.5 ? "grow" : "shrink"} ${r() < 0.5 ? "width" : "height"} 40 px`);
            break;
        case "layoutSplit":
            await this.cmd("layout toggle split");
            break;
        case "focusParentOpen":
            await this.cmd("focus parent");
            this.open("normal");
            break;
        case "drag":
        case "dragFloat":
        case "dragResize":
            for (const ws of await this.mouse(kind))
                if (ws && this.modelMode)
                    this.mws(ws).impure = this.mws(ws).impure || kind;
            break;
        }
    }

    async run() {
        const r = this.rng;
        this.modelMode = r() < 0.45;
        let x = r() * OUTPUTS.reduce((s, o) => s + o.weight, 0);
        this.out = OUTPUTS.find(o => (x -= o.weight) < 0) || OUTPUTS[0];
        const steps = 5 + Math.floor(r() * 36);
        this.note(`scenario ${this.index} seed ${this.seed} mode ${this.modelMode ? "model" : "chaos"} output ${this.out.name} steps ${steps}`);
        await this.begin();
        const dual = this.out.outs.length > 1;
        const table = this.actionTable(dual);
        for (let i = 0; i < steps && this.prev !== null; i++) {
            const kind = this.choose(table);
            this.note(`-- action ${i + 1}: ${kind}`);
            const checkTabs = kind === "tabs" && (this.modelMode || r() < 0.5);
            let before = null;
            if (checkTabs && !this.modelMode) {
                before = await this.step("before tabs");
                if (!before)
                    break;
            } else if (checkTabs) {
                before = this.prev;
            }
            if (this.modelMode && ["dwToggle", "moveDir", "resize", "layoutSplit", "focusParentOpen"].includes(kind))
                this.markImpure(this.prev, kind);
            // A directional move can cross onto the other output.
            if (this.modelMode && kind === "moveDir" && this.prev) {
                const vis = this.visibleWs(this.prev);
                for (const w of wsNodes(this.prev))
                    if (vis.has(w.id))
                        this.mws(w.name).impure = this.mws(w.name).impure || kind;
            }
            this.actionAt = now();
            if (this.modelMode && kind === "tabs")
                this.pendingTabs = true;
            await this.act(kind, dual);
            if (this.modelMode || checkTabs || r() < 0.15) {
                const t = await this.step(`after ${kind} #${i + 1}`);
                if (!t)
                    break;
                if (checkTabs)
                    this.checkTabs(before, t);
                if (this.modelMode && kind === "dwToggle")
                    this.markImpure(t, "dwToggle");
            } else {
                const d = r();
                await sleep(d < 0.3 ? 0 : d < 0.8 ? d * 60 : d * 160);
            }
        }
        await this.finishRun();
    }

    async begin() {
        this.sway = await startSway(this.out);
        this.cpu0 = swayCpu(this.sway.proc.pid);
        this.events = await Ipc.connect(this.sway.sock);
        this.events.onEvent = (type, msg) => this.onSway(type, msg);
        await this.events.send(2, JSON.stringify(["window", "shutdown"]));
        this.pointer = new Pointer(this.client, this.sway.env);
        await this.pointer.ready;
        if (this.opts.plugin === "qml") {
            this.replica = new QmlPlugin(this);
            await this.replica.start();
        } else if (this.opts.plugin === "none") {
            // Plain Sway, to tell Sway's own failures from the plugin's.
            this.replica = { st: { off: {} }, queue: [], busy: false, timer: null, idle: () => true, swayEvent: () => {} };
        } else {
            this.replica = new Replica(this.L, this);
            await this.replica.connect();
            this.replica.enqueue({ kind: "tidy" });
        }
        this.prev = await this.step("start");
    }

    async finishRun() {
        if (this.prev !== null && this.actionAt > this.lastJobStart) {
            this.actionAt = 0;
            this.open("normal");
            this.prev = await this.step("open after a silent change");
        }
        if (this.prev !== null)
            await this.step("final");
        this.swayCpu = swayCpu(this.sway.proc.pid) - this.cpu0;
    }

    // After tabs on, the workspace holds one known tab list, so the model can follow it again.
    resyncTabs(t) {
        const f = t.focused;
        const wsName = f ? (f.n.type === "workspace" ? f.n.name : f.ws && f.ws.name) : null;
        if (!wsName || this.replica.st.off[wsName])
            return;
        const v = tiledOn(t, wsName);
        const p = v[0] && v[0].parent;
        const w = this.mws(wsName);
        if (w.held.length || v.some(i => i.n.fullscreen_mode > 0))
            return;
        if (v.length && p.layout === "tabbed" && v.every(i => i.parent === p)) {
            Object.assign(w, { kind: "tabbed", list: v.map(i => i.n.id), root: null, impure: "" });
        } else if (w.kind === "tabbed" && !w.impure && w.list.length >= 2) {
            const ws = f.n.type === "workspace" ? f.n : f.ws;
            const rect = { w: ws.rect.width, h: ws.rect.height };
            let root = { id: w.list[0] };
            for (let i = 1; i < w.list.length; i++) {
                const box = mBox(root, w.list[i - 1], rect);
                if (Math.abs(box.w - box.h) < 24) {
                    w.impure = "ambiguous tabs off";
                    return;
                }
                root = mSplit(root, w.list[i - 1], w.list[i], box.w > box.h ? "h" : "v");
            }
            Object.assign(w, { kind: "dwindle", root, list: [] });
        }
    }

    async close() {
        this.stopping = true;
        if (this.pointer)
            this.pointer.close();
        if (this.replica instanceof QmlPlugin) {
            this.replica.close();
        } else if (this.replica) {
            this.replica.dead = true;
            clearTimeout(this.replica.timer);
            if (this.replica.sock)
                this.replica.sock.destroy();
        }
        try {
            this.events.close();
        } catch (e) {}
        await stopSway(this.sway);
        for (const c of this.clients.values())
            if (!c.exited)
                try {
                    c.proc.kill("SIGKILL");
                } catch (e) {}
    }
}

async function runWorker() {
    const L = loadLogic();
    const client = process.env.DW_CLIENT;
    const opts = JSON.parse(process.env.DW_OPTS);
    process.on("message", async m => {
        if (m.cmd === "stop")
            process.exit(0);
        if (m.cmd !== "run")
            return;
        const sc = new Scenario(L, client, m.index, m.seed, opts);
        try {
            let timer;
            await Promise.race([opts.templates ? sc.runTemplate() : sc.run(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("scenario timed out after 180 s")), 180000)))]);
            clearTimeout(timer);
        } catch (e) {
            sc.fail("harness", String(e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e));
        }
        try {
            await sc.close();
        } catch (e) {}
        const res = { index: m.index, seed: m.seed, mode: sc.modelMode ? "model" : "chaos", output: sc.out ? sc.out.name : "?", template: sc.template || "", failures: sc.failures, benign: sc.benign, drags: sc.drags, silentChecks: sc.silentChecks, latency: sc.latency, logicMs: sc.logicMs, jobs: sc.jobs, swayCpu: sc.swayCpu || 0 };
        if (sc.failures.length)
            res.log = sc.log;
        process.send(res);
    });
    process.send({ ready: true });
}

function childCpu() {
    const f = fs.readFileSync("/proc/self/stat", "utf8");
    const parts = f.slice(f.lastIndexOf(")") + 2).split(" ");
    return (+parts[13] + +parts[14]) / 100;
}

// Opens and closes windows one at a time with each transport and reports what one window costs.
async function runBench(opts, client) {
    const L = loadLogic();
    const out = {};
    for (const transport of ["swaymsg", "socket"]) {
        const sc = new Scenario(L, client, 0, 1, Object.assign({}, opts, { transport }));
        sc.modelMode = false;
        sc.out = OUTPUTS[0];
        sc.sway = await startSway(sc.out);
        sc.events = await Ipc.connect(sc.sway.sock);
        sc.events.onEvent = (type, msg) => sc.onSway(type, msg);
        await sc.events.send(2, JSON.stringify(["window", "shutdown"]));
        sc.replica = new Replica(L, sc);
        await sc.replica.connect();
        await sc.settle("bench start");
        const res = {};
        for (const phase of ["open", "close"]) {
            const jobs0 = sc.latency.length;
            const s0 = swayCpu(sc.sway.proc.pid), c0 = process.cpuUsage(), k0 = childCpu(), t0 = now();
            const lat = [];
            for (let i = 0; i < opts.bench; i++) {
                if (phase === "open") {
                    sc.open("normal");
                } else {
                    const c = sc.alive()[0];
                    c.closing = true;
                    c.proc.kill("SIGTERM");
                }
                await sc.settle("bench");
                lat.push(sc.lastJobEnd - (phase === "open" ? sc.lastNewAt : sc.lastCloseAt));
            }
            const c1 = process.cpuUsage(c0);
            res[phase] = {
                eventToDoneMs: { p50: +pct(lat, 0.5).toFixed(2), p95: +pct(lat, 0.95).toFixed(2) },
                jobMs: { p50: pct(sc.latency.slice(jobs0), 0.5), p95: pct(sc.latency.slice(jobs0), 0.95) },
                jobsPerWindow: +((sc.latency.length - jobs0) / opts.bench).toFixed(2),
                swayCpuMsPerWindow: +((swayCpu(sc.sway.proc.pid) - s0) * 1000 / opts.bench).toFixed(2),
                pluginCpuMsPerWindow: +(((c1.user + c1.system) / 1000 + (childCpu() - k0) * 1000) / opts.bench).toFixed(2),
                wallMs: +(now() - t0).toFixed(0),
            };
        }
        res.treeReadMsP50 = +pct(sc.fetchMs || [], 0.5).toFixed(2);
        res.commandMsP50 = +pct(sc.cmdMs || [], 0.5).toFixed(2);
        res.logicMsPerJob = +(sc.logicMs / Math.max(1, sc.jobs)).toFixed(3);
        out[transport] = res;
        sc.failures.length && (out[transport].failures = sc.failures);
        await sc.close();
    }
    console.log(JSON.stringify(out, null, 1));
}

function pct(a, p) {
    if (!a.length)
        return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

async function runMain(opts) {
    const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "swaydesk-dwindle-test");
    const client = buildClient(cache);
    if (opts.bench) {
        await runBench(opts, client);
        process.exit(0);
    }
    fs.mkdirSync(path.join(opts.out, "failures"), { recursive: true });
    const seeds = opts.seeds || Array.from({ length: opts.scenarios }, (_, i) => scenarioSeed(opts.seed, i));
    const total = seeds.length;
    const jobs = Math.min(opts.jobs, total);
    let next = 0, done = 0, failed = 0, benign = 0, drags = 0, silent = 0;
    const lat = [], byType = new Map(), byTemplate = new Map(), byOutput = new Map(), byMode = new Map(), failedSeeds = [];
    let logicMs = 0, jobCount = 0, swayCpu = 0;
    const t0 = Date.now();
    const cpu0 = process.cpuUsage();
    let stopping = false;
    console.log(`dwindle stress: ${total} scenarios, ${jobs} sway instances, base seed ${opts.seed}, logs in ${opts.out}`);
    const workers = [], stalled = [];
    await new Promise(resolve => {
        let live = 0;
        const give = w => {
            if (stopping || next >= total) {
                w.send({ cmd: "stop" });
                return;
            }
            const i = next++;
            w.current = i;
            w.send({ cmd: "run", index: i, seed: seeds[i] });
        };
        for (let k = 0; k < jobs; k++) {
            const w = fork(fileURLToPath(import.meta.url), ["--worker"], { env: Object.assign({}, process.env, { DW_CLIENT: client, DW_OPTS: JSON.stringify(opts) }) });
            live++;
            w.on("message", m => {
                w.seen = Date.now();
                if (m.ready)
                    return give(w);
                done++;
                benign += m.benign;
                drags += m.drags;
                silent += m.silentChecks;
                for (const l of m.latency)
                    lat.push(l);
                logicMs += m.logicMs;
                jobCount += m.jobs;
                swayCpu += m.swayCpu;
                byOutput.set(m.output, (byOutput.get(m.output) || 0) + 1);
                byMode.set(m.mode, (byMode.get(m.mode) || 0) + 1);
                if (m.failures.length) {
                    failed++;
                    failedSeeds.push(m.seed);
                    if (m.template)
                        byTemplate.set(m.template.split(" | ")[0], (byTemplate.get(m.template.split(" | ")[0]) || 0) + 1);
                    const types = [...new Set(m.failures.map(f => f.type))];
                    for (const t of types)
                        byType.set(t, (byType.get(t) || 0) + 1);
                    fs.writeFileSync(path.join(opts.out, "failures", `${m.seed}.json`), JSON.stringify(m, null, 1));
                    console.log(`FAIL seed ${m.seed} (${m.template || m.mode + ", " + m.output}): ${m.failures[0].type}: ${m.failures[0].msg.slice(0, 300)}`);
                    if (opts.stopAfter && failed >= opts.stopAfter)
                        stopping = true;
                }
                if (done % 250 === 0)
                    console.log(`.. ${done}/${total} done, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
                give(w);
            });
            w.on("exit", (code, signal) => {
                if (code || signal)
                    console.log(`worker ${w.pid} exited (${code || signal}) during scenario ${w.current}`);
                if (--live === 0)
                    resolve();
            });
            workers.push(w);
        }
        // Never wait on a worker that is gone, nor on one that has said nothing for a long time.
        setInterval(() => {
            for (const w of workers)
                if (w.exitCode === null && w.signalCode === null && Date.now() - (w.seen || t0) > 240000) {
                    console.log(`worker ${w.pid} stalled on seed ${seeds[w.current]}; stopping it`);
                    stalled.push(seeds[w.current]);
                    w.kill("SIGKILL");
                }
            if (workers.every(w => w.exitCode !== null || w.signalCode !== null))
                resolve();
        }, 2000).unref();
    });
    const lost = total - done;
    const cpu = process.cpuUsage(cpu0);
    const secs = (Date.now() - t0) / 1000;
    const summary = {
        scenarios: done,
        passed: done - failed,
        failed,
        lost,
        stalledSeeds: stalled,
        failedSeeds: failedSeeds.slice(0, 50),
        failureTypes: Object.fromEntries(byType),
        kind: opts.templates ? `user stories (${TEMPLATE_NAMES.length} templates x ${OUTPUTS.length} outputs x dwindle on/off)` : "random",
        failedTemplates: Object.fromEntries(byTemplate),
        outputs: Object.fromEntries(byOutput),
        modes: Object.fromEntries(byMode),
        raceErrorsRecovered: benign,
        mouseDrags: drags,
        checksAfterSilentChanges: silent,
        transport: opts.plugin === "qml" ? "qml" : opts.transport,
        jobs: jobCount,
        jobLatencyMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), max: pct(lat, 1) },
        logicMsPerJob: +(logicMs / Math.max(1, jobCount)).toFixed(3),
        swayCpuSecPerScenario: +(swayCpu / Math.max(1, done)).toFixed(3),
        orchestratorCpuSec: +((cpu.user + cpu.system) / 1e6).toFixed(1),
        wallSec: +secs.toFixed(0),
    };
    fs.writeFileSync(path.join(opts.out, "summary.json"), JSON.stringify(summary, null, 1));
    console.log(JSON.stringify(summary, null, 1));
    process.exit(failed || lost ? 1 : 0);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.worker)
    runWorker();
else
    runMain(opts);
