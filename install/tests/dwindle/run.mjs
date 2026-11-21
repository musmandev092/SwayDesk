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
// Boxes are split by size ratios with the gaps left out, as the plugin does.
const GAP = 0;
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
    // Removals: each position in turn, down to one window, with new windows in between.
    "close positions down to one": r => removals(r, "close"),
    "move away positions down to one": r => removals(r, "moveAway"),
    "move away and follow, down to one": r => removals(r, "moveFollow"),
    "four, second one leaves (reported case)": r => [...open(4), { k: r() < 0.5 ? "close" : "moveFollow", w: 1 }, { k: "open" }, { k: "close", w: "?" }],
    "drag empties a branch": r => [...open(4 + Math.floor(r() * 2)), { k: "drag", src: "csib", dst: "?", edge: "?" }, { k: "close", w: "?" }, { k: "open" }],
    "scratchpad around removals": () => [...open(4), { k: "scratch", w: "focused" }, { k: "close", w: "mid" }, { k: "show" }, { k: "float", w: "same" }, { k: "close", w: "first" }],
    "fullscreen around removals": () => [...open(4), { k: "fs", w: "?" }, { k: "close", w: "first" }, { k: "open" }, { k: "fs", w: "same" }, { k: "close", w: "csib" }, { k: "open" }],
    "tabs after removals": r => [...open(5), { k: "close", w: "?" }, { k: "close", w: "csib" }, { k: "tabs" }, { k: "close", w: "?" }, { k: "tabs" }, { k: "open" }, { k: "close", w: r() < 0.5 ? "first" : "last" }],
    "manual flip, then removals": () => [...open(4), { k: "focus", w: "?" }, { k: "flip" }, { k: "close", w: "csib" }, { k: "close", w: "?" }, { k: "open" }],
    // Tabs on and off 1-20 times, with other changes in between and around every toggle.
    "tabs storm": r => storm(r, {}),
    "tabs storm, removals": r => storm(r, { close: 8, moveAway: 4, moveFollow: 3, down: 3 }),
    "tabs storm, mouse": r => storm(r, { drag: 8 }),
    "tabs storm, focus and swap": r => storm(r, { cycle: 8, swap: 8 }),
    "tabs storm, float fullscreen scratchpad": r => storm(r, { float: 5, fs: 5, scratch: 5 }),
    "tabs storm, outputs": r => storm(r, { moveOut: 8 }),
    "tabs storm, bursts": r => storm(r, { burst: 5, close: 6 }),
    "tabs storm, rapid": r => storm(r, { rapid: 6 }),
    "tabs storm, dwindle off and on": r => storm(r, { dwToggle: 4 }),
    "tabs storm, flips": r => storm(r, { flip: 6, close: 6 }),
    "close down to one, rebuild, tabs between": r => {
        const s = [];
        for (let round = 0; round < 2 + Math.floor(r() * 3); round++) {
            s.push({ k: "burst", n: 3 + Math.floor(r() * 6) });
            while (s.filter(x => x.k === "close").length < s.reduce((n, x) => n + (x.k === "burst" ? x.n : 0), 0) - 1) {
                if (r() < 0.3)
                    s.push({ k: "tabs" });
                s.push({ k: "close", w: POS[Math.floor(r() * POS.length)] });
            }
        }
        return s;
    },
    // Scratchpad cases: a whole container hidden and tiled again; shown windows fit their output.
    "container to scratchpad and back": () => [...open(4), { k: "focus", w: "mid" }, { k: "key", cmd: "focus parent" }, { k: "key", cmd: "move scratchpad" }, { k: "key", cmd: "scratchpad show" }, { k: "key", cmd: "focus parent" }, { k: "key", cmd: "floating toggle" }, { k: "open" }, { k: "close", w: "?" }],
    "big window shown on a smaller output": () => [{ k: "ws", ws: 3 }, ...open(2), { k: "float", w: "last" }, { k: "key", cmd: "resize set width 2400 px height 1400 px" }, { k: "scratch", w: "same" }, { k: "ws", ws: 1 }, { k: "show" }, { k: "float", w: "same" }],
    "two windows to the scratchpad at once": () => [...open(3), { k: "rapid", steps: [{ k: "scratch", w: "first" }, { k: "scratch", w: "last" }] }, { k: "showAll" }, { k: "open" }],
    "fixed-size window tiled, hidden, shown": () => [...open(2), { k: "openFixed" }, { k: "float", w: "fixed" }, { k: "scratch", w: "fixed" }, { k: "show" }, { k: "open" }],
    "sequence and its reverse": r => {
        const fwd = open(2);
        const kinds = ["open", "tabs", "swapn", "swapp", "flip", "open"];
        for (let i = 0; i < 4 + Math.floor(r() * 8); i++)
            fwd.push({ k: kinds[Math.floor(r() * kinds.length)] });
        const inv = s => (s.k === "open" ? { k: "close", w: "last" } : s.k === "swapn" ? { k: "swapp" } : s.k === "swapp" ? { k: "swapn" } : s);
        const conv = s => (s.k === "swapn" ? { k: "cycle", swap: true, step: 1 } : s.k === "swapp" ? { k: "cycle", swap: true, step: -1 } : s);
        return fwd.concat(fwd.slice(2).reverse().map(inv)).map(conv);
    },
};

const POS = ["first", "mid", "last", "focused", "csib"];

function storm(r, weights) {
    const W = Object.assign({ open: 4, burst: 1, close: 4, moveAway: 2, moveFollow: 1, moveOut: 2, float: 2, fs: 2, scratch: 2, drag: 2, cycle: 3, swap: 3, flip: 1, dwToggle: 0, rapid: 1, down: 0 }, weights);
    const pos = () => POS[Math.floor(r() * POS.length)];
    const total = Object.values(W).reduce((a, b) => a + b, 0);
    const pick = () => {
        let x = r() * total;
        for (const [k, w] of Object.entries(W))
            if ((x -= w) < 0)
                return k;
        return "open";
    };
    const op = k => {
        switch (k) {
        case "open": return [{ k: "open" }];
        case "burst": return [{ k: "burst", n: 3 + Math.floor(r() * 6) }];
        case "close": case "moveAway": case "moveFollow": return [{ k, w: pos() }];
        case "moveOut": return [{ k: "moveOut", w: pos(), follow: r() < 0.5 }];
        case "float": return r() < 0.5 ? [{ k: "float", w: pos() }, { k: "float", w: "same" }] : [{ k: "float", w: pos() }, { k: "tabs" }, { k: "float", w: "same" }];
        case "fs": return [{ k: "fs", w: pos() }, ...(r() < 0.5 ? [{ k: "open" }] : [{ k: "tabs" }]), { k: "fs", w: "same" }];
        case "scratch": return [{ k: "scratch", w: pos() }, ...(r() < 0.5 ? [{ k: "tabs" }] : []), { k: "show" }, { k: "float", w: "same" }];
        case "drag": return [{ k: "drag", src: "?", dst: r() < 0.3 ? "other" : "?", edge: "?" }];
        case "cycle": return [{ k: "cycle", swap: false, step: r() < 0.5 ? 1 : -1 }];
        case "swap": return [{ k: "cycle", swap: true, step: r() < 0.5 ? 1 : -1 }];
        case "flip": return [{ k: "focus", w: pos() }, { k: "flip" }];
        case "dwToggle": return [{ k: "dwToggle" }, ...op(pick() === "dwToggle" ? "open" : "close"), { k: "dwToggle" }];
        case "rapid": return [{ k: "rapid", steps: [{ k: "tabs" }, ...op(["open", "close", "cycle", "swap", "moveAway"][Math.floor(r() * 5)]), { k: "tabs" }] }];
        case "down": return [...Array.from({ length: 6 }, () => ({ k: "close", w: pos() })), { k: "burst", n: 3 + Math.floor(r() * 4) }];
        }
        return [];
    };
    const steps = open(2 + Math.floor(r() * 5));
    const toggles = 1 + Math.floor(r() * 20);
    for (let t = 0; t < toggles; t++) {
        steps.push({ k: "tabs" });
        for (let i = Math.floor(r() * 3); i > 0; i--)
            steps.push(...op(pick()));
    }
    return steps;
}

function removals(r, how) {
    const steps = open(3 + Math.floor(r() * 4));
    let n = steps.length;
    for (let guard = 0; n > 1 && guard < 12; guard++) {
        if (r() < 0.2) {
            steps.push({ k: "open" });
            n++;
        } else {
            steps.push({ k: how, w: ["first", "mid", "last", "focused", "csib"][Math.floor(r() * 5)] });
            n--;
        }
    }
    return steps;
}
const TEMPLATE_NAMES = Object.keys(TEMPLATES);

const now = () => performance.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
    const o = { scenarios: 100, jobs: Math.max(1, Math.min(12, os.cpus().length - 4)), seed: 1, out: path.join(os.tmpdir(), "dwindle-test"), seeds: null, verbose: false, worker: false, stopAfter: 0, transport: "socket", bench: 0, index: 0 };
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
        else if (a === "--logic") o.logic = v();
        else if (a === "--rounds") o.rounds = +v();
        else if (a === "--templates") o.templates = true;
        else if (a === "--index") o.index = +v();
        else if (a === "--verbose") o.verbose = true;
        else if (a === "--worker") o.worker = true;
        else if (a === "--help") {
            console.log("node run.mjs [--scenarios N] [--jobs J] [--seed S] [--out DIR] [--replay SEED,...] [--stop-after FAILS] [--verbose]\n" +
                "             [--transport socket|swaymsg] [--plugin qml] [--templates] [--logic PLUGIN_DIR]\n" +
                "             [--bench WINDOWS [--rounds N]]");
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

// --logic DIR runs another copy of the plugin (DwindleLogic.js and DwindleDaemon.qml), e.g. an older one.
function pluginDir(opts) {
    return opts.logic ? path.resolve(opts.logic) : path.dirname(LOGIC);
}

function loadLogic(opts) {
    const file = path.join(pluginDir(opts), "DwindleLogic.js");
    const src = fs.readFileSync(file, "utf8").replace(/^\.pragma library\s*$/m, "");
    const ctx = vm.createContext({ console });
    vm.runInContext(src, ctx, { filename: file });
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

// Pointer buttons bound to the plugin's commands, so --plugin qml gets real binding events.
const BUTTONS = {
    "nop dwindle tabs": ["BTN_SIDE", 275],
    "nop dwindle toggle": ["BTN_EXTRA", 276],
    "nop dwindle focus next": ["BTN_FORWARD", 277],
    "nop dwindle focus prev": ["BTN_BACK", 278],
    "nop dwindle swap next": ["BTN_TASK", 279],
    "nop dwindle swap prev": ["BTN_0", 256],
};

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
        ...Object.entries(BUTTONS).map(([cmd, b]) => `bindsym --whole-window ${b[0]} ${cmd}`),
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
            if (this.proc.exitCode !== null || this.proc.signalCode !== null)
                return r();
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

// Independent model of Hyprland dwindle (force_split = 2, preserve_split = false). Inner nodes
// are { d, f, a, b }: direction, share of a, children. Leaves are { id }.
function mContains(n, id) {
    return !!n && (n.id === id || (!!n.a && (mContains(n.a, id) || mContains(n.b, id))));
}

// The sibling of a removed window takes over the parent's box and is flagged for re-flow.
function mRemove(n, id) {
    if (!n)
        return null;
    if (!n.a)
        return n.id === id ? null : n;
    const a = mRemove(n.a, id), b = mRemove(n.b, id);
    if (!a)
        return Object.assign({}, b, { flow: true });
    if (!b)
        return Object.assign({}, a, { flow: true });
    return Object.assign({}, n, { a, b });
}

function mChildRects(r, d, f) {
    const s = f === undefined ? 0.5 : f;
    return d === "h" ? [{ w: (r.w - GAP) * s, h: r.h }, { w: (r.w - GAP) * (1 - s), h: r.h }] : [{ w: r.w, h: (r.h - GAP) * s }, { w: r.w, h: (r.h - GAP) * (1 - s) }];
}

// Hyprland with preserve_split = false, after a window left the workspace: every split takes the
// shape of its box (strict >), turned splits from even halves. out.amb is set when a box is too
// square to call and its split does not already fit.
function mReflow(n, r, out) {
    if (!n.a)
        return { id: n.id };
    const s = r.w > r.h ? "h" : "v";
    let d = n.d, f = n.f;
    // Gaps and title bars put the plugin's boxes a few pixels off the model's.
    if (Math.abs(r.w - r.h) < 24)
        out.amb = true;
    if (d !== s) {
        d = s;
        f = 0.5;
    }
    const [ra, rb] = mChildRects(r, d, f);
    return { d, f, a: mReflow(n.a, ra, out), b: mReflow(n.b, rb, out) };
}

function mParentOf(n, id) {
    if (!n || !n.a)
        return null;
    if ((!n.a.a && n.a.id === id) || (!n.b.a && n.b.id === id))
        return n;
    return mParentOf(n.a, id) || mParentOf(n.b, id);
}

function mSwapIds(n, x, y) {
    if (!n.a)
        return { id: n.id === x ? y : n.id === y ? x : n.id };
    return Object.assign({}, n, { a: mSwapIds(n.a, x, y), b: mSwapIds(n.b, x, y) });
}

// Sway's tree as a model, when it is a clean binary split tree (or one tab group).
function mAdopt(ws) {
    const isWin = n => !(n.nodes && n.nodes.length);
    const size = (k, key) => k.rect[key] + (key === "height" && isWin(k) && k.deco_rect ? k.deco_rect.height : 0);
    const node = (kids, layout) => {
        if (kids.length !== 2 || (layout !== "splith" && layout !== "splitv"))
            return undefined;
        const a = conv(kids[0]), b = conv(kids[1]);
        if (!a || !b)
            return undefined;
        const key = layout === "splith" ? "width" : "height";
        const s0 = size(kids[0], key), s1 = size(kids[1], key);
        return { d: layout === "splith" ? "h" : "v", f: s0 > 0 && s1 > 0 ? s0 / (s0 + s1) : 0.5, a, b };
    };
    const conv = n => {
        if (isWin(n))
            return n.pid > 0 ? { id: n.id } : undefined;
        if (n.layout === "tabbed" || n.layout === "stacked")
            return undefined;
        return n.nodes.length === 1 ? conv(n.nodes[0]) : node(n.nodes, n.layout);
    };
    const kids = ws.nodes || [];
    if (!kids.length)
        return { kind: "empty", root: null, list: [] };
    const tabs = kids.length === 1 && kids[0].layout === "tabbed" ? kids[0].nodes : ws.layout === "tabbed" ? kids : null;
    if (tabs && tabs.every(isWin))
        return { kind: "tabbed", root: null, list: tabs.map(k => k.id) };
    const root = kids.length === 1 ? conv(kids[0]) : node(kids, ws.layout);
    return root ? { kind: "dwindle", root, list: [] } : null;
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
    const [ra, rb] = mChildRects(r, n.d, n.f);
    return mBox(n.a, id, ra) || mBox(n.b, id, rb);
}

function mSplit(n, id, newId, d) {
    if (!n.a)
        return n.id === id ? { d, f: 0.5, a: n, b: { id: newId } } : n;
    return Object.assign({}, n, { a: mSplit(n.a, id, newId, d), b: mSplit(n.b, id, newId, d) });
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
        return !this.busy && !this.queue.length && !this.timer && !this.fitTimer;
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
        for (const j of res.jobs || [])
            this.queue = this.queue.concat([j]);
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

    swayEvent(type, e, body) {
        if (type === "binding") {
            const a = this.L.bindingAction(e.binding && e.binding.command);
            if (a)
                this.enqueue({ kind: a });
            return;
        }
        const own = e.change === "move" && this.st.ownMoves[e.container.id];
        const out = this.L.onWindowData ? this.L.onWindowData(this.st, body || JSON.stringify(e)) : this.L.onWindowEvent(this.st, e.change, e.container);
        if (out.tidy)
            this.restartTidy();
        if (this.sc.opts.verbose && e.change === "move")
            this.sc.note(`  move ${this.sc.title(e.container.id)} type=${e.container.type} own=${!!own} jobs=${out.jobs.map(j => j.kind)}`);
        for (const j of out.jobs)
            this.enqueue(j);
        // Like the daemon's fitTimer.
        if (out.fit && out.fit.length) {
            this.fitIds = (this.fitIds || []).concat(out.fit);
            clearTimeout(this.fitTimer);
            this.fitTimer = setTimeout(() => {
                this.fitTimer = null;
                this.enqueue({ kind: "fit", ids: this.fitIds });
                this.fitIds = [];
            }, 150);
        }
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
            fs.copyFileSync(path.join(pluginDir(this.sc.opts), f), path.join(dir, "Dwindle", f));
        this.state = path.join(this.sc.sway.dir, "state");
        this.log = "";
        this.env = Object.assign({}, this.sc.sway.env, { XDG_STATE_HOME: this.state, QT_QPA_PLATFORM: "wayland" });
        this.proc = spawn("qs", ["-p", path.join(dir, "shell.qml")], { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
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
        const r = await new Promise(res => execFile("qs", ["ipc", "--pid", String(this.proc.pid), "call", "dwindle", "action", "nothing"], { env: this.env }, (err, out) => res(String(out || err).trim())));
        if (r !== "unknown")
            this.sc.fail("qml-ipc", `unknown action answered ${r.slice(0, 200)}`);
    }

    idle() {
        return now() - this.sc.lastEvent > 150 && now() - this.sc.lastFitEvent > 400;
    }

    // Bindings reach the plugin as real Sway binding events from the virtual pointer's side buttons.
    swayEvent(type, e) {
        if (type !== "binding")
            return;
        // Half of the actions go through the plugin's IPC entry (the shortcut list's way in) instead.
        if (this.sc.rng() < 0.5) {
            const kind = this.sc.L.bindingAction(e.binding.command);
            this.sc.inflight++;
            execFile("qs", ["ipc", "--pid", String(this.proc.pid), "call", "dwindle", "action", kind], { env: this.env }, (err, stdout) => {
                if (String(stdout).trim() !== "ok")
                    this.sc.fail("qml-ipc", `action ${kind}: ${String(stdout || err).trim().slice(0, 200)}`);
                this.sc.inflight--;
                this.sc.lastAction = now();
            });
            return;
        }
        const button = BUTTONS[e.binding.command][1];
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
        if (process.env.DW_QS_LOG)
            fs.writeFileSync(process.env.DW_QS_LOG, this.log);
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
        this.adopted = 0;
        this.compared = 0;
        this.cmdErrors = [];
        this.fsAt = new Set();
        this.fsWs = new Map();
        this.fitDue = new Map();
        this.lastFitEvent = 0;
        this.handledAt = 0;
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

    swayCrashed() {
        if (this.crashed)
            return;
        this.crashed = true;
        const last = this.replica && this.replica.pending ? this.replica.pending.kind : "-";
        this.fail("sway-crash", `job in flight: ${last}; ${this.sway.stderr().slice(-500)}`);
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
            // The close event can trail a clean exit by seconds when 20+ sessions share the CPU.
            setTimeout(() => {
                if (c.closing || this.stopping)
                    return;
                if (this.sway.exited())
                    this.swayCrashed();
                else
                    this.fail("client-died", `${title} exited unexpectedly (${code === null ? signal : "code " + code}) ${c.err.trim()}`);
            }, this.sway.exited() ? 0 : 10000);
        });
        this.note(`open ${title} ${appId}${kind !== "normal" ? " " + kind : ""}`);
    }

    alive() {
        return [...this.clients.values()].filter(c => !c.exited && c.conId != null);
    }

    onSway(type, msg, body) {
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
        if (msg.change === "move" || msg.change === "floating" || (msg.change === "fullscreen_mode" && c.fullscreen_mode === 0)) {
            // Chaos runs pile up actions between checks (a window can come back with no event).
            if (!this.racy)
                this.fitDue.set(c.id, now());
            this.lastFitEvent = now();
        }
        this.note(`ev ${msg.change} ${this.title(c.id)}${msg.change === "floating" ? " " + c.type : ""}${msg.change === "fullscreen_mode" ? " " + c.fullscreen_mode : ""}`);
        this.replica.swayEvent("window", msg, body);
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
            if (!/^(tabs|focus|swap|fit)/.test(job.kind) && this.replica.st.off[wsName] && !/\] focus$/.test(c))
                this.fail("off-touched", `${job.kind} touched ${this.title(n.id)} on disabled workspace ${wsName}: ${c}`);
            if (m[2] === "split" && /split [hv]$/.test(c) && n.fullscreen_mode > 0)
                this.fail("split-fullscreen", `${c} on fullscreen ${this.title(n.id)}`);
            if ((m[2] === "split" || (m[2] === "move" && m[3] === " container")) && (n._floating || n.type === "floating_con") && !/ tiling[\] ]/.test(c))
                this.fail("floating-touched", `${c} on floating ${this.title(n.id)}`);
        }
    }

    // An error is a race when something outside the plugin changed the tree while the job ran.
    cmdError(job, i, error) {
        // Sway answers every comma-separated part of a command on its own.
        const parts = job.cmds.flatMap(x => {
            const m = /^(\[[^\]]*\] )?(.*)$/.exec(x);
            return m[2].split(/,\s*/).map(p => (m[1] || "") + p);
        });
        const c = parts[i] || "";
        const race = this.extAt >= job.t0 - 5;
        this.cmdErrors.push({ job: job.kind, cmd: c, error, race });
        this.note(`cmd error in ${job.kind}${race ? " (race)" : ""}: ${c} -> ${error}`);
    }

    jobDone(job) {
        if (this.jobLog)
            this.jobLog.push(job);
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
                this.swayCrashed();
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
            const wn = n.type === "workspace" ? n.name : wsName;
            const plain = !unseen && wn && wn !== "__i3_scratch" && !this.everOff.has(wn) && !i.floating && (n.type === "con" || n.type === "workspace");
            // Behind a fullscreen window the plugin leaves the tree alone until it is gone.
            const fsHere = plain && [...a.nodes.values()].some(x => x.ws && x.ws.name === wn && x.n.type !== "workspace" && x.n.fullscreen_mode > 0);
            if (plain && !fsHere && n.type === "con" && (n.layout === "splith" || n.layout === "splitv") && i.parent && i.parent.type !== "workspace" && (n.nodes || []).length === 1)
                this.fail("single-child", `${stage}: ${n.layout} ${n.id} on ${wsName} wraps only ${this.title(n.nodes[0].id)}`);
            if (plain && !fsHere && (n.layout === "splith" || n.layout === "splitv") && (n.nodes || []).length > 2)
                this.fail("not-binary", `${stage}: ${this.raw(n)} on ${wn} waiting=${Object.keys(this.replica.st.unplaced || {}).map(id => this.title(+id))} held=${(this.replica.st.held || []).map(h => this.title(h.id))}`);
            if (plain && (n.layout === "tabbed" || n.layout === "stacked") && (n.nodes || []).length) {
                for (let p = i.parent; p && p.type !== "output"; p = a.nodes.get(p.id).parent)
                    if (p.layout === "tabbed" || p.layout === "stacked") {
                        this.fail("nested-tabs", `${stage}: ${this.raw(i.ws || n)}`);
                        break;
                    }
                if (n.nodes.length === 1 && n.nodes[0].nodes && n.nodes[0].nodes.length)
                    this.fail("nested-tabs", `${stage}: tab group around a container ${this.raw(i.ws || n)}`);
            }
        }
        // Floating windows shown, floated or moved since the last check fit their output (unless a
        // drag or resize by hand came after).
        for (const [id, at] of this.fitDue) {
            this.fitDue.delete(id);
            const i = a.wins.find(x => x.n.id === id);
            // Tiles inside a floating container follow the container.
            if (!i || !i.floating || i.parent.type !== "workspace" || !i.ws || i.ws.name === "__i3_scratch" || i.n.fullscreen_mode > 0 || this.handledAt > at || !i.output)
                continue;
            const o = i.output.rect, r = i.n.rect, g = i.n.geometry, c = i.n.window_rect;
            const inside = r.x >= o.x - 2 && r.y >= o.y - 2 && r.x + r.width <= o.x + o.width + 2 && r.y + r.height <= o.y + o.height + 2;
            const big = r.width > o.width * 0.9 + 3 || r.height > o.height * 0.9 + 3;
            const cl = this.byCon.get(id);
            const stretched = cl && cl.kind === "fixed" && i.parent.type === "workspace" && g && c && (c.width > g.width + 34 || c.height > g.height + 34);
            if (!inside || big || stretched)
                this.fail("fit", `${stage}: ${this.title(id)} ${r.width}x${r.height}+${r.x}+${r.y} on ${o.width}x${o.height}+${o.x}+${o.y}${stretched ? ` content ${c.width}x${c.height} > own ${g.width}x${g.height}` : ""}`);
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
            this.model.set(name, { kind: "empty", root: null, list: [], impure: "", held: [], deferred: false });
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

    // Drops id from the model; returns the workspace whose tiling lost it, or null.
    mDrop(id) {
        let from = null;
        for (const [name, w] of this.model) {
            w.held = w.held.filter(h => h.id !== id);
            if (w.kind === "dwindle" && mContains(w.root, id)) {
                w.root = mRemove(w.root, id);
                if (!w.root)
                    w.kind = "empty";
                from = name;
            } else if (w.kind === "tabbed" && w.list.includes(id)) {
                w.list = w.list.filter(x => x !== id);
                if (!w.list.length)
                    w.kind = "empty";
                from = name;
            }
        }
        return from;
    }

    // A window left the workspace's tiling: re-flow it, or once nothing there is fullscreen.
    mRemoved(name) {
        if (!name)
            return;
        const w = this.mws(name);
        if ((this.fsWs.get(name) || []).length)
            w.deferred = true;
        else
            this.mFlowWs(w, name);
    }

    mInsert(a, wsName, id, snap, held) {
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
        if (!held && (this.fsWs.get(wsName) || []).some(fid => w.kind !== "tabbed" || !this.fsAt.has(fid))) {
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
        let p = snap.find(s => s !== id && leaves.includes(s));
        // With no focused tile there, the plugin falls back on another; it ends up right before the window.
        if (p === undefined) {
            const i = a.wins.find(x => x.n.id === id);
            const sib = i && !i.floating ? i.parent.nodes : [];
            const prev = sib[sib.indexOf(i && i.n) - 1];
            if (prev && !(prev.nodes && prev.nodes.length) && leaves.includes(prev.id))
                p = prev.id;
        }
        if (p === undefined) {
            w.impure = `no partner for ${this.title(id)}`;
            return;
        }
        if (this.fsAt.has(p)) {
            w.impure = "partner fullscreen";
            return;
        }
        const box = mBox(w.root, p, rect);
        if (Math.abs(box.w - box.h) < 24) {
            w.impure = `ambiguous split of ${this.title(p)} ${box.w}x${box.h}`;
            return;
        }
        w.root = mSplit(w.root, p, id, box.w > box.h ? "h" : "v");
    }

    applyModel(a) {
        const ops = this.ops;
        this.ops = [];
        for (const ws of wsNodes(a))
            this.mws(ws.name).rect = { w: ws.rect.width, h: ws.rect.height };
        const winInfo = id => a.wins.find(i => i.n.id === id);
        for (const o of ops) {
            if (o.op === "new") {
                const i = winInfo(o.id);
                if (i && !i.floating)
                    this.mInsert(a, i.ws && i.ws.name, o.id, o.snap, false);
            } else if (o.op === "close") {
                this.mRemoved(this.mDrop(o.id));
            } else if (o.op === "floating") {
                const i = winInfo(o.id);
                this.mRemoved(this.mDrop(o.id));
                if (o.tiled && i && !i.floating)
                    this.mInsert(a, i.ws && i.ws.name, o.id, o.snap, false);
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
                this.mRemoved(this.mDrop(id));
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
                if (prev && !(prev.nodes && prev.nodes.length))
                    this.mInsert(a, wsName, id, [prev.id], false);
                else if (this.mws(wsName).kind !== "empty" && !this.mws(wsName).impure)
                    this.mws(wsName).impure = `moved ${this.title(id)} not after a tile`;
                else
                    this.mInsert(a, wsName, id, [], false);
            }
        }
        this.fsAt = new Set(a.wins.filter(i => i.n.fullscreen_mode > 0).map(i => i.n.id));
        // Workspaces with anything fullscreen (the plugin holds new windows and re-flows there).
        this.fsWs = new Map();
        for (const [, i] of a.nodes)
            if ((i.n.type === "con" || i.n.type === "floating_con") && i.n.fullscreen_mode > 0 && i.ws)
                this.fsWs.set(i.ws.name, (this.fsWs.get(i.ws.name) || []).concat([i.n.id]));
        // Once nothing is fullscreen: the re-flow that waited, then the held windows in order.
        for (const [name, w] of this.model) {
            if ((this.fsWs.get(name) || []).length)
                continue;
            if (w.deferred) {
                w.deferred = false;
                this.mFlowWs(w, name);
            }
            if (!w.held.length)
                continue;
            const h = w.held;
            w.held = [];
            for (const x of h) {
                const i = winInfo(x.id);
                if (i && !i.floating && i.ws && i.ws.name === name)
                    this.mInsert(a, name, x.id, x.snap, true);
            }
        }
        for (const ws of wsNodes(a)) {
            if (ws.name === "__i3_scratch")
                continue;
            const w = this.mws(ws.name);
            if (!tiledOn(a, ws.name).length && !w.held.length && !this.replica.st.off[ws.name])
                Object.assign(w, { kind: "empty", root: null, list: [], impure: "", deferred: false });
        }
    }

    mFlowWs(w, name) {
        if (w.kind !== "dwindle" || !w.root || !w.rect || w.impure)
            return;
        const out = {};
        w.root = mReflow(w.root, w.rect, out);
        if (out.amb)
            w.impure = "ambiguous re-flow";
        if (this.opts.verbose) {
            const dump = n => (n.a ? `${n.d}(${dump(n.a)},${dump(n.b)})` : this.title(n.id));
            this.note(`  model ${name}: ${dump(w.root)}`);
        }
    }

    // After a step the model cannot predict (a mouse drop where the user aimed, a manual move or
    // resize), it takes over Sway's tree once that is a clean binary dwindle again and the plugin
    // has looked at it, and checks every later step strictly from there.
    adoptImpure(a) {
        if (this.actionAt > this.lastJobStart)
            return;
        for (const ws of wsNodes(a)) {
            const w = this.mws(ws.name);
            if (ws.name === "__i3_scratch" || !w.impure || w.held.length || this.replica.st.off[ws.name] || (this.fsWs.get(ws.name) || []).length)
                continue;
            const m = mAdopt(ws);
            if (m) {
                Object.assign(w, m, { impure: "", deferred: false });
                this.adopted++;
            }
        }
    }

    compareModel(a, stage) {
        // A change Sway made without an event (a drop back onto its own spot) waits for the next job.
        if (this.actionAt > this.lastJobStart)
            return;
        for (const ws of wsNodes(a)) {
            if (ws.name === "__i3_scratch")
                continue;
            const w = this.mws(ws.name);
            if (w.impure || w.held.length || this.replica.st.off[ws.name])
                continue;
            this.compared++;
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
        if (!v.length || [...before.nodes.values()].some(i => i.ws && i.ws.name === wsName && i.n.fullscreen_mode > 0 && i.n.type !== "workspace"))
            return;
        const grp = n => n.layout === "tabbed" || n.layout === "stacked";
        const p0 = v[0].parent;
        const wasTabbed = grp(p0) && v.every(i => i.parent === p0);
        const v2 = tiledOn(after, wsName);
        const order = l => l.map(i => this.title(i.n.id)).join(",");
        const wsAfter = v2[0] ? after.nodes.get(v2[0].ws.id).n : null;
        const groups = [...after.nodes.values()].filter(i => (i.n === wsAfter || (i.ws && i.ws === wsAfter && i.n.type === "con" && !i.floating)) && grp(i.n) && i.n.nodes.length).length;
        if (!wasTabbed) {
            const p = v2[0] && v2[0].parent;
            const ok = p && p.layout === "tabbed" && v2.every(i => i.parent === p) && v2.length === v.length;
            if (!ok || groups !== 1)
                this.fail("tabs-on", `ws ${wsName}: expected one tabbed container with ${order(v)}, got ${wsAfter ? this.raw(wsAfter) : "-"}`);
            else if (order(v) !== order(v2))
                this.fail("tabs-on", `ws ${wsName}: tab order ${order(v2)} differs from tree order ${order(v)}`);
        } else if (v.length === 1) {
            if (groups || v2.length !== 1)
                this.fail("tabs-off", `ws ${wsName}: expected a plain window, got ${wsAfter ? this.raw(wsAfter) : "-"}`);
        } else {
            const ws = wsAfter;
            const bin = n => !(n.nodes && n.nodes.length) || (n.nodes.length === 2 && (n.layout === "splith" || n.layout === "splitv") && n.nodes.every(bin));
            let top = ws;
            while (top.nodes.length === 1 && top.nodes[0].nodes && top.nodes[0].nodes.length)
                top = top.nodes[0];
            if (!(top.nodes.length === 2 && top.nodes.every(bin)) || order(v) !== order(v2) || groups)
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
        this.jobSinceStep = this.lastJobStart > (this.lastStepAt || 0);
        this.lastStepAt = now();
        this.pureBefore = this.pureAtEnd || new Set();
        if (this.modelMode) {
            this.applyModel(t, a);
            if (this.pendingTabs) {
                this.pendingTabs = false;
                this.resyncTabs(t);
            }
        }
        this.check(t, a);
        if (this.expectFocus != null) {
            if (!t.focused || t.focused.n.id !== this.expectFocus)
                this.fail("cycle-focus", `${a}: expected focus on ${this.title(this.expectFocus)}, got ${t.focused ? this.title(t.focused.n.id) : "-"}`);
            this.expectFocus = null;
        }
        if (this.modelMode) {
            this.compareModel(t, a);
            this.adoptImpure(t);
            this.pureAtEnd = new Set([...this.model].filter(([, w]) => !w.impure).map(([n]) => n));
        }
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
            this.handledAt = now();
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

    // A key binding the plugin reacts to, with what the model expects of it.
    press(cmd) {
        this.note(`binding ${cmd}`);
        const m = /^nop dwindle (focus|swap) (next|prev)$/.exec(cmd);
        if (m)
            this.modelCycle(m[1] === "swap", m[2] === "next" ? 1 : -1);
        this.replica.swayEvent("binding", { change: "run", binding: { command: cmd } });
    }

    focusedWsName(a) {
        const f = a && a.focused;
        return f ? (f.n.type === "workspace" ? f.n.name : f.ws && f.ws.name) : null;
    }

    // A/D and Shift+A/D: the next or previous tile in reading order gets focus, or swaps places.
    modelCycle(swap, step) {
        const a = this.prev;
        if (this.racy)
            return;
        const wsName = this.focusedWsName(a);
        if (!wsName || wsName === "__i3_scratch")
            return;
        const v = tiledOn(a, wsName);
        if (v.length < 2)
            return;
        const f = v.find(i => i.n.focused) || this.mru.map(id => v.find(i => i.n.id === id)).find(Boolean) || v[0];
        const t = v[(v.indexOf(f) + step + v.length) % v.length];
        const fs = [...a.nodes.values()].some(x => x.ws && x.ws.name === wsName && x.n.type !== "workspace" && x.n.fullscreen_mode > 0);
        if (fs)
            return;
        this.expectFocus = swap ? f.n.id : t.n.id;
        if (!swap || !this.modelMode)
            return;
        const w = this.mws(wsName);
        if (w.kind === "dwindle" && w.root)
            w.root = mSwapIds(w.root, f.n.id, t.n.id);
        else if (w.kind === "tabbed")
            w.list = w.list.map(id => (id === f.n.id ? t.n.id : id === t.n.id ? f.n.id : id));
    }

    // "layout toggle split" run by hand: the focused window's split turns until the next re-flow.
    modelFlip() {
        const a = this.prev;
        const wsName = this.focusedWsName(a);
        if (!this.modelMode || !wsName)
            return;
        const f = a.focused, w = this.mws(wsName);
        if (f.floating || f.n.type !== "con" || !(f.n.pid > 0) || w.kind !== "dwindle" || !mContains(w.root, f.n.id)) {
            w.impure = w.impure || "flip";
            return;
        }
        const p = mParentOf(w.root, f.n.id);
        if (p)
            p.d = p.d === "h" ? "v" : "h";
    }

    // One user-story step with explicit targets.
    async tstep(s) {
        const list = () => this.alive().filter(c => c.kind === "normal");
        const win = sel => {
            const l = list();
            if (sel === "same")
                return this.picked && !this.picked.exited ? this.picked : null;
            if (sel === "fixed") {
                this.picked = this.alive().filter(c => c.kind === "fixed").pop() || null;
                return this.picked;
            }
            if (!l.length)
                return null;
            const a = this.prev;
            if ((sel === "focused" || sel === "csib") && a) {
                const ids = new Set(l.map(c => c.conId));
                const hit = sel === "focused" ? (a.focused && ids.has(a.focused.n.id) ? [a.focused] : []) : a.wins.filter(i => ids.has(i.n.id) && !i.floating && i.parent.nodes.length === 2 && i.parent.nodes.some(k => k !== i.n && k.nodes && k.nodes.length));
                if (hit.length) {
                    this.picked = this.byCon.get(this.pick(hit).n.id);
                    return this.picked;
                }
            }
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
        case "moveWs": {
            const c = win(s.w);
            this.sameWsMove(c, String(s.ws));
            await on(c, `move container to workspace number ${s.ws}`);
            break;
        }
        case "moveAway":
        case "moveFollow": {
            const c = win(s.w);
            this.sameWsMove(c, "2");
            await on(c, s.k === "moveAway" ? "move container to workspace number 2" : "move container to workspace number 2; workspace number 2; workspace number 1");
            break;
        }
        case "ws":
            await this.cmd(`workspace number ${s.ws}`);
            break;
        case "key":
            this.handledAt = now();
            await this.cmd(s.cmd);
            break;
        case "tabs":
            this.press("nop dwindle tabs");
            break;
        case "cycle":
            this.press(`nop dwindle ${s.swap ? "swap" : "focus"} ${s.step > 0 ? "next" : "prev"}`);
            break;
        case "flip":
            this.modelFlip();
            await this.cmd("layout toggle split");
            break;
        case "dwToggle":
            this.markImpure(this.prev, "dwToggle");
            this.press("nop dwindle toggle");
            break;
        case "moveOut": {
            const c = win(s.w);
            if (this.out.outs.length > 1) {
                const i = c && this.prev && this.prev.wins.find(x => x.n.id === c.conId);
                const other = i && i.output && i.output.name === "HEADLESS-1" ? "HEADLESS-2" : "HEADLESS-1";
                await on(c, `move container to output ${other}${s.follow ? `; focus output ${other}` : ""}`);
            } else {
                this.sameWsMove(c, "2");
                await on(c, "move container to workspace number 2");
            }
            break;
        }
        case "openFixed":
            this.open("fixed");
            break;
        case "showAll": {
            const a = await this.tree();
            for (const i of a.wins.filter(x => x.ws && x.ws.name === "__i3_scratch"))
                await this.cmd(`[con_id=${i.n.id}] scratchpad show`);
            break;
        }
        case "rapid":
            // Nothing settles in between, so cycle targets cannot be predicted from the last tree.
            this.racy = true;
            for (const x of s.steps)
                await this.tstep(x);
            this.racy = false;
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

    // Moving a window to the workspace it is on still makes Sway re-insert it (after the last
    // focused tile); the model does not predict that.
    sameWsMove(c, target) {
        const i = c && this.prev && this.prev.wins.find(x => x.n.id === c.conId);
        const at = i && i.ws ? i.ws.name : this.prev && this.prev.focused && (this.prev.focused.n.type === "workspace" ? this.prev.focused.n.name : this.prev.focused.ws && this.prev.focused.ws.name);
        if (at && at === target)
            this.mws(at).impure = this.mws(at).impure || "moved onto its own workspace";
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
        for (let i = 0; i < steps.length && this.prev !== null && !this.sway.exited(); i++) {
            const s = steps[i];
            this.note(`-- step ${i + 1}: ${JSON.stringify(s)}`);
            const before = this.prev;
            this.actionAt = now();
            if (s.k === "tabs")
                this.pendingTabs = true;
            if ((s.k === "resize" || s.k === "key" || s.k === "rapid") && this.prev) {
                const vis = this.visibleWs(this.prev);
                for (const w of wsNodes(this.prev))
                    if (vis.has(w.id))
                        this.mws(w.name).impure = this.mws(w.name).impure || s.k;
            }
            await this.tstep(s);
            this.prev = await this.step(`after ${s.k} #${i + 1}`);
            if (this.prev && s.k === "tabs")
                this.checkTabs(before, this.prev);
            if (this.prev && s.k === "dwToggle")
                this.markImpure(this.prev, "dwToggle");
        }
        await this.finishRun();
    }

    actionTable(dual) {
        const M = !this.racy;
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
            ["tabs", 6],
            ["cycle", 6],
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
            if (x < 0.75)
                this.sameWsMove(null, String(k));
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
            await this.cmd(this.racy && r() < 0.15 ? "fullscreen toggle global" : "fullscreen toggle");
            break;
        case "scratch":
            await this.cmd(r() < 0.5 ? "move scratchpad" : "scratchpad show");
            break;
        case "tabs":
            this.press("nop dwindle tabs");
            break;
        case "cycle":
            this.press(`nop dwindle ${r() < 0.5 ? "focus" : "swap"} ${r() < 0.5 ? "next" : "prev"}`);
            break;
        case "dwToggle":
            this.press("nop dwindle toggle");
            break;
        case "moveDir":
            this.handledAt = now();
            await this.cmd(`move ${this.pick(dirs)}`);
            break;
        case "resize":
            this.handledAt = now();
            await this.cmd(`resize ${r() < 0.5 ? "grow" : "shrink"} ${r() < 0.5 ? "width" : "height"} 40 px`);
            break;
        case "layoutSplit":
            this.modelFlip();
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
        // "chaos" scenarios do not wait between actions, so they get the structural checks only.
        this.racy = r() >= 0.45;
        this.modelMode = !this.racy;
        let x = r() * OUTPUTS.reduce((s, o) => s + o.weight, 0);
        this.out = OUTPUTS.find(o => (x -= o.weight) < 0) || OUTPUTS[0];
        const steps = 5 + Math.floor(r() * 36);
        this.note(`scenario ${this.index} seed ${this.seed} mode ${this.racy ? "chaos" : "model"} output ${this.out.name} steps ${steps}`);
        await this.begin();
        const dual = this.out.outs.length > 1;
        const table = this.actionTable(dual);
        for (let i = 0; i < steps && this.prev !== null && !this.sway.exited(); i++) {
            const kind = this.choose(table);
            this.note(`-- action ${i + 1}: ${kind}`);
            const checkTabs = kind === "tabs" && (!this.racy || r() < 0.5);
            let before = null;
            if (checkTabs && this.racy) {
                before = await this.step("before tabs");
                if (!before)
                    break;
            } else if (checkTabs) {
                before = this.prev;
            }
            this.expectFocus = null;
            if (this.modelMode && ["dwToggle", "moveDir", "resize", "focusParentOpen"].includes(kind))
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
            if (!this.racy || checkTabs || r() < 0.15) {
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
        this.events.onEvent = (type, msg, body) => this.onSway(type, msg, body);
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
        if (this.sway.exited()) {
            this.swayCrashed();
            return;
        }
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
        } else if (w.kind === "tabbed" && !w.impure && w.list.length >= 1) {
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
            clearTimeout(this.replica.fitTimer);
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
    const client = process.env.DW_CLIENT;
    const opts = JSON.parse(process.env.DW_OPTS);
    const L = loadLogic(opts);
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
        const res = { index: m.index, seed: m.seed, mode: sc.racy ? "chaos" : "model", compared: sc.compared, adopted: sc.adopted, output: sc.out ? sc.out.name : "?", template: sc.template || "", failures: sc.failures, benign: sc.benign, drags: sc.drags, silentChecks: sc.silentChecks, latency: sc.latency, logicMs: sc.logicMs, jobs: sc.jobs, swayCpu: sc.swayCpu || 0 };
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

function procCpu(pid) {
    try {
        const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const parts = f.slice(f.lastIndexOf(")") + 2).split(" ");
        return (+parts[11] + +parts[12]) / 100;
    } catch (e) {
        return 0;
    }
}

// Quiet per-event cost: a workspace with --bench N windows (default 4); each round opens a window,
// moves focus and closes the window again, waiting for the plugin after every step.
async function runBench(opts, client) {
    const L = loadLogic(opts);
    const sc = new Scenario(L, client, 0, 1, opts);
    sc.modelMode = false;
    sc.out = OUTPUTS[0];
    sc.sway = await startSway(sc.out);
    sc.events = await Ipc.connect(sc.sway.sock);
    sc.events.onEvent = (type, msg, body) => {
        if (type === 3 && msg && sc.benchEvent)
            sc.benchEvent(msg);
        sc.onSway(type, msg, body);
    };
    await sc.events.send(2, JSON.stringify(["window", "shutdown"]));
    const qml = opts.plugin === "qml";
    if (qml) {
        sc.pointer = new Pointer(client, sc.sway.env);
        await sc.pointer.ready;
        sc.replica = new QmlPlugin(sc);
        await sc.replica.start();
    } else {
        sc.replica = new Replica(L, sc);
        await sc.replica.connect();
        sc.replica.enqueue({ kind: "tidy" });
    }
    const base = opts.bench > 1 ? opts.bench : 4;
    for (let i = 0; i < base; i++) {
        sc.open("normal");
        await sc.settle("bench base");
    }
    const rounds = opts.rounds || 200;
    sc.jobLog = [];
    let events = 0, placed = [];
    const newAt = new Map();
    sc.benchEvent = m => {
        events++;
        const id = m.container && m.container.id;
        if (m.change === "new")
            newAt.set(id, now());
        else if (m.change === "move" && newAt.has(id)) {
            placed.push(now() - newAt.get(id));
            newAt.delete(id);
        }
    };
    const qsPid = qml ? sc.replica.proc.pid : 0;
    const s0 = swayCpu(sc.sway.proc.pid), q0 = qml ? procCpu(qsPid) : 0, t0 = now();
    const openDone = [], closeDone = [];
    for (let i = 0; i < rounds; i++) {
        sc.open("normal");
        await sc.settle("bench open");
        if (!qml)
            openDone.push(sc.lastJobEnd - sc.lastNewAt);
        const others = sc.alive().filter(c => c.kind === "normal");
        await sc.cmd(`[con_id=${others[i % base].conId}] focus`);
        await sc.settle("bench focus");
        const c = others[others.length - 1];
        c.closing = true;
        c.proc.kill("SIGTERM");
        await sc.settle("bench close");
        if (!qml)
            closeDone.push(sc.lastJobEnd - sc.lastCloseAt);
    }
    const wall = now() - t0;
    const r2 = v => +v.toFixed(3);
    const stats = (jobs, f) => {
        const a = jobs.map(f);
        return { p50: r2(pct(a, 0.5)), p95: r2(pct(a, 0.95)) };
    };
    const byKind = {};
    for (const kind of ["place", "tidy"]) {
        const j = sc.jobLog.filter(x => x.kind === kind);
        byKind[kind] = {
            jobs: j.length,
            totalMs: stats(j, x => x.t2 - x.t0),
            treeReadMs: stats(j, x => x.t1 - x.t0),
            logicMs: stats(j, x => x.logicMs || 0),
            commandMs: stats(j.filter(x => x.cmds && x.cmds.length), x => x.t2 - x.t1 - (x.logicMs || 0)),
            withCommands: j.filter(x => x.cmds && x.cmds.length).length,
        };
    }
    const res = {
        plugin: qml ? "qml" : "logic over socket",
        logic: pluginDir(opts),
        windows: base + 1,
        rounds,
        perEventMs: stats(sc.jobLog, x => x.t2 - x.t0),
        logicMs: stats(sc.jobLog, x => x.logicMs || 0),
        jobsPerRound: r2(sc.jobLog.length / rounds),
        windowEventsPerRound: r2(events / rounds),
        byKind,
        newToPlacedMs: { p50: r2(pct(placed, 0.5)), p95: r2(pct(placed, 0.95)) },
        openEventToDoneMs: { p50: r2(pct(openDone, 0.5)), p95: r2(pct(openDone, 0.95)) },
        closeEventToDoneMs: { p50: r2(pct(closeDone, 0.5)), p95: r2(pct(closeDone, 0.95)) },
        swayCpuMsPerRound: r2((swayCpu(sc.sway.proc.pid) - s0) * 1000 / rounds),
        wallMs: Math.round(wall),
    };
    if (qml)
        res.quickshellCpuMsPerRound = r2((procCpu(qsPid) - q0) * 1000 / rounds);
    if (sc.failures.length)
        res.failures = sc.failures;
    await sc.close();
    console.log(JSON.stringify(res, null, 1));
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
    let next = 0, done = 0, failed = 0, benign = 0, drags = 0, silent = 0, compared = 0, adopted = 0;
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
            w.send({ cmd: "run", index: opts.seeds ? opts.index + i : i, seed: seeds[i] });
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
                compared += m.compared || 0;
                adopted += m.adopted || 0;
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
        modelComparisons: compared,
        modelAdoptions: adopted,
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
