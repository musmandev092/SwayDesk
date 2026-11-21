#!/usr/bin/env node
// Headless Sway test for swaydesk-tile: random sessions (windows, keys, mouse drags into every drop
// zone, floating, fullscreen, scratchpad, workspaces), checked against the tiling rules after each step.
// node run.mjs [--scenarios N] [--jobs J] [--seed S] [--steps K] [--replay SEED,...] [--verbose]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../../../src/swaydesk-tile");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();

const KEYS = {
    "retile": ["BTN_SIDE", 275],
    "monocle": ["BTN_EXTRA", 276],
    "zoom": ["BTN_FORWARD", 277],
    "focus next": ["BTN_BACK", 278],
    "focus prev": ["BTN_TASK", 279],
    "swap next": ["BTN_0", 256],
    "swap prev": ["BTN_1", 257],
};
const BTN_LEFT = 272;
const OUTPUTS = ["1920x1080", "2560x1440", "1366x768", "1080x1920"];
const USER_REARRANGE = new Set(["drag", "layout", "movedir"]);

function parseArgs(argv) {
    const o = { scenarios: 100, jobs: Math.max(1, Math.min(12, os.cpus().length - 4)), seed: 1, steps: 60, seeds: null, verbose: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i], v = () => argv[++i];
        if (a === "--scenarios") o.scenarios = +v();
        else if (a === "--jobs") o.jobs = +v();
        else if (a === "--seed") o.seed = +v();
        else if (a === "--steps") o.steps = +v();
        else if (a === "--replay") o.seeds = v().split(",").map(Number);
        else if (a === "--verbose") o.verbose = true;
        else {
            console.log("node run.mjs [--scenarios N] [--jobs J] [--seed S] [--steps K] [--replay SEED,...] [--verbose]");
            process.exit(a === "--help" ? 0 : 2);
        }
    }
    return o;
}

function rngFrom(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 4294967296;
    };
}

function build(dir) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ["main.c", "Makefile"])
        fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
    execFileSync("make", ["-s", "-C", dir, "swaydesk-tile-asan"], { stdio: "inherit" });
    const pd = execFileSync("pkg-config", ["--variable=pkgdatadir", "wayland-protocols"]).toString().trim();
    const wlr = execFileSync("pkg-config", ["--variable=pkgdatadir", "wlr-protocols"]).toString().trim();
    const protos = { "xdg-shell": path.join(pd, "stable/xdg-shell/xdg-shell.xml"), "wlr-virtual-pointer-unstable-v1": path.join(wlr, "unstable/wlr-virtual-pointer-unstable-v1.xml") };
    const sources = [path.join(HERE, "dwclient.c")];
    for (const [name, xml] of Object.entries(protos)) {
        execFileSync("wayland-scanner", ["client-header", xml, path.join(dir, `${name}-client-protocol.h`)]);
        execFileSync("wayland-scanner", ["private-code", xml, path.join(dir, `${name}-protocol.c`)]);
        sources.push(path.join(dir, `${name}-protocol.c`));
    }
    execFileSync("gcc", ["-O2", "-o", path.join(dir, "dwclient"), ...sources, "-I", dir, "-lwayland-client"]);
    return { tile: path.join(dir, "swaydesk-tile-asan"), client: path.join(dir, "dwclient") };
}

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
            const len = this.buf.readUInt32LE(6), type = this.buf.readUInt32LE(10);
            if (this.buf.length < 14 + len)
                break;
            const body = this.buf.subarray(14, 14 + len).toString();
            this.buf = this.buf.subarray(14 + len);
            let msg = null;
            try {
                msg = JSON.parse(body);
            } catch (e) {}
            if (type & 0x80000000) {
                if (this.onEvent)
                    this.onEvent(type & 0x7fffffff, msg);
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
            const b = Buffer.from(payload), h = Buffer.alloc(14);
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

function swayConfig(mode) {
    return [
        "xwayland disable",
        "default_border normal 1",
        "default_floating_border normal 1",
        "titlebar_padding 8 4",
        "gaps inner 4",
        "smart_gaps on",
        "focus_follows_mouse no",
        "mouse_warping none",
        "tiling_drag enable",
        'for_window [app_id="^dwdialog$"] floating enable, move position center',
        "for_window [tiling workspace=__focused__] move container to mark _swaydesk_tail",
        ...Object.entries(KEYS).map(([a, b]) => `bindsym --whole-window ${b[0]} nop tile ${a}`),
        `output HEADLESS-1 mode ${mode} position 0 0`,
    ].join("\n") + "\n";
}

async function startSway(mode) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tilesway-"));
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(path.join(dir, "config"), swayConfig(mode));
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: dir, WLR_BACKENDS: "headless", WLR_LIBINPUT_NO_DEVICES: "1", WLR_RENDERER: "pixman", WLR_HEADLESS_OUTPUTS: "1" };
    // TILE_SWAY_GDB=1 runs Sway under gdb and writes its backtrace to <dir>.gdb when it crashes.
    const cmd = process.env.TILE_SWAY_GDB ? ["gdb", ["-batch", "-ex", "run", "-ex", "bt", "--args", "sway", "-c", path.join(dir, "config")]] : ["sway", ["-c", path.join(dir, "config")]];
    const proc = spawn(cmd[0], cmd[1], { env, stdio: ["ignore", process.env.TILE_SWAY_GDB ? fs.openSync(dir + ".gdb", "w") : "ignore", "pipe"] });
    let stderr = "", exited = false;
    proc.stderr.on("data", d => (stderr = (stderr + d).slice(-4000)));
    proc.on("exit", () => (exited = true));
    const t0 = now();
    let sock = null, wl = null;
    while (!sock || !wl) {
        if (exited || now() - t0 > 8000) {
            try {
                proc.kill("SIGKILL");
            } catch (e) {}
            fs.rmSync(dir, { recursive: true, force: true });
            throw new Error("sway did not start: " + stderr.slice(-300));
        }
        await sleep(10);
        for (const f of fs.readdirSync(dir)) {
            if (/^sway-ipc\..*\.sock$/.test(f))
                sock = path.join(dir, f);
            else if (/^wayland-\d+$/.test(f))
                wl = f;
        }
    }
    const s = { proc, dir, sock, env: Object.assign({}, env, { SWAYSOCK: sock, WAYLAND_DISPLAY: wl }), exited: () => exited, stderr: () => stderr };
    for (let i = 0; i < 100 && !s.ipc; i++) {
        try {
            s.ipc = await Ipc.connect(sock);
        } catch (e) {
            await sleep(10);
        }
    }
    return s;
}

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

// Independent reading of the tree: windows in reading order, shape, parents.
function isView(n) {
    return (n.type === "con" || n.type === "floating_con") && !(n.nodes && n.nodes.length) && n.pid !== undefined;
}

function analyze(tree) {
    const out = { ws: [], focused: null, focusFloating: false, views: 0, ids: new Set(), global: false };
    const visit = (n, parent, ws, floating) => {
        out.ids.add(n.id);
        n._parent = parent;
        if (n.focused) {
            out.focused = n.id;
            out.focusFloating = floating;
            out.focusWs = ws;
        }
        if (isView(n))
            out.views++;
        if (n.fullscreen_mode === 2)
            out.global = true;
        if (n.fullscreen_mode > 0 && ws)
            ws._busy = true;
        for (const c of n.nodes || [])
            visit(c, n, ws || (n.type === "workspace" ? n : null), floating);
        for (const c of n.floating_nodes || [])
            visit(c, n, ws || (n.type === "workspace" ? n : null), true);
    };
    for (const o of tree.nodes)
        for (const w of o.nodes) {
            w._output = o.rect;
            visit(w, o, w, false);
        }
    out.hiddenFs = [];
    const hidden = n => {
        if (n.fullscreen_mode > 0 && n.type !== "workspace")
            out.hiddenFs.push(n.id);
        (n.nodes || []).concat(n.floating_nodes || []).forEach(hidden);
    };
    for (const o of tree.nodes)
        for (const w of o.nodes) {
            if (w.name === "__i3_scratch") {
                hidden(w);
                continue;
            }
            const order = [], parents = {}, rects = {};
            const walk = n => {
                for (const c of n.nodes || []) {
                    if (isView(c)) {
                        order.push(c.id);
                        parents[c.id] = n.id;
                        rects[c.id] = c;
                    } else {
                        walk(c);
                    }
                }
            };
            walk(w);
            out.ws.push({ id: w.id, name: w.name, node: w, order, parents, rects, shape: shapeOf(w, order.length), busy: !!w._busy, output: w._output });
        }
    return out;
}

function down(n) {
    while (!isView(n) && n.nodes && n.nodes.length === 1)
        n = n.nodes[0];
    return n;
}

function shapeOf(ws, n) {
    if (n === 0)
        return "empty";
    if (n === 1)
        return "single";
    let r = ws;
    while (r.nodes.length === 1 && !isView(r.nodes[0]))
        r = r.nodes[0];
    const kids = r.nodes.map(down);
    if (r.layout === "tabbed" || r.layout === "stacked")
        return kids.every(isView) ? "monocle" : "manual";
    if (r.layout !== "splith" || kids.length !== 2 || !isView(kids[0]))
        return "manual";
    if (isView(kids[1]))
        return "master";
    return kids[1].layout === "splitv" && kids[1].nodes.map(down).every(isView) ? "master" : "manual";
}

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

class Scenario {
    constructor(seed, opts, bins) {
        this.seed = seed;
        this.opts = opts;
        this.bins = bins;
        this.rng = rngFrom(seed);
        this.log = [];
        this.fail = null;
        this.clients = [];
        this.lastEvent = now();
        this.n = 0;
        this.commandErrors = [];
        this.mode = OUTPUTS[Math.floor(this.rng() * OUTPUTS.length)];
        this.model = new Map();
    }

    pick(list) {
        return list[Math.floor(this.rng() * list.length)];
    }

    note(s) {
        this.log.push(s);
        if (this.opts.verbose)
            console.log("  " + s);
    }

    async tree() {
        return analyze(await this.sway.ipc.send(4));
    }

    async cmd(c) {
        this.note("> " + c);
        return this.sway.ipc.send(0, c);
    }

    async settle(min) {
        const t0 = now();
        await sleep(min);
        while (now() - this.lastEvent < 45 && now() - t0 < 2000)
            await sleep(10);
    }

    alive() {
        return this.clients.filter(p => p.exitCode === null && p.signalCode === null);
    }

    async open(kind) {
        const appId = kind === "dialog" ? "dwdialog" : this.pick(["term", "files", "web", "edit"]);
        const args = [appId, `w${++this.n}`];
        if (kind === "fixed")
            args.push("fixed");
        this.note(`open ${args.join(" ")}`);
        const p = spawn(this.bins.client, args, { env: this.sway.env, stdio: ["ignore", "ignore", "ignore"] });
        this.clients.push(p);
        const t0 = now();
        while (now() - t0 < 1500) {
            const a = await this.tree();
            if (a.views >= this.alive().length)
                break;
            await sleep(10);
        }
    }

    async key(action) {
        this.note(`key ${action}`);
        const b = KEYS[action][1];
        await this.pointer.send(`b ${b} 1`);
        await this.pointer.send(`b ${b} 0`);
    }

    async pointerTo(x, y) {
        const [w, h] = this.mode.split("x").map(Number);
        const cl = (v, hi) => Math.max(0, Math.min(hi - 1, Math.round(v)));
        await this.pointer.send(`a ${cl(x, w)} ${cl(y, h)} ${w} ${h}`);
    }

    // Drag a tiled window by its title bar into one of the drop zones of another window or the workspace.
    async drag(a) {
        const ws = a.ws.find(w => w.id === a.focusWsId);
        if (!ws || ws.order.length < 2)
            return false;
        const src = ws.rects[this.pick(ws.order)];
        const parent = src._parent, pr = parent.rect, d = src.deco_rect;
        if (!d || d.height <= 0)
            return false;
        const from = { x: pr.x + d.x + d.width / 2, y: pr.y + d.y + d.height / 2 };
        const others = ws.order.filter(id => id !== src.id).map(id => ws.rects[id]);
        const t = this.pick(others), r = t.rect, z = this.rng();
        let to;
        if (z < 0.25)
            to = { x: r.x + r.width / 2, y: r.y + r.height / 2, zone: "centre" };
        else if (z < 0.55) {
            const e = this.pick(["top", "bottom", "left", "right"]), f = 0.05 + this.rng() * 0.2;
            to = { x: e === "left" ? r.x + r.width * f : e === "right" ? r.x + r.width * (1 - f) : r.x + r.width / 2, y: e === "top" ? r.y + r.height * f : e === "bottom" ? r.y + r.height * (1 - f) : r.y + r.height / 2, zone: e };
        } else if (z < 0.7) {
            const tp = t._parent.rect, td = t.deco_rect;
            to = { x: tp.x + td.x + td.width * (0.1 + this.rng() * 0.8), y: tp.y + td.y + Math.max(1, td.height / 2), zone: "titlebar" };
        } else if (z < 0.85) {
            const e = this.pick(["top", "bottom", "left", "right"]), o = ws.node.rect;
            to = { x: e === "left" ? o.x + 6 : e === "right" ? o.x + o.width - 6 : o.x + o.width / 2, y: e === "top" ? o.y + 6 : e === "bottom" ? o.y + o.height - 6 : o.y + o.height / 2, zone: "edge-" + e };
        } else {
            const o = ws.node.rect;
            to = { x: o.x + this.rng() * o.width, y: o.y + this.rng() * o.height, zone: "random" };
        }
        this.note(`drag ${src.id} (${Math.round(from.x)},${Math.round(from.y)}) -> ${to.zone} of ${t.id} (${Math.round(to.x)},${Math.round(to.y)})`);
        await this.pointerTo(from.x, from.y);
        await this.pointer.send(`b ${BTN_LEFT} 1`);
        const steps = 3 + Math.floor(this.rng() * 3);
        for (let s = 1; s <= steps; s++)
            await this.pointerTo(from.x + (to.x - from.x) * s / steps, from.y + (to.y - from.y) * s / steps);
        await this.pointer.send(`b ${BTN_LEFT} 0`);
        return true;
    }

    async step(a) {
        const n = this.alive().length, ws = a.ws.find(w => w.id === a.focusWsId);
        // Windows behind a fullscreen one cannot be seen, dragged or split (SwayDesk has no split keys).
        const tiled = ws && !ws.busy && !a.global ? ws.order.length : 0;
        const w = {
            open: n < 8 ? 22 : 0, dialog: n < 8 ? 3 : 0, fixed: n < 8 ? 2 : 0, close: n ? 14 : 0, key: 22, tick: 3,
            drag: tiled >= 2 ? 14 : 0, workspace: 4, movews: tiled ? 4 : 0, floating: n ? 4 : 0, fullscreen: n ? 3 : 0,
            scratch: n ? 4 : 0, layout: tiled >= 2 ? 4 : 0, movedir: tiled >= 2 ? 3 : 0, resize: tiled >= 2 ? 3 : 0,
        };
        let total = 0;
        for (const k in w)
            total += w[k];
        let x = this.rng() * total, kind = "key";
        for (const k in w) {
            x -= w[k];
            if (x < 0) {
                kind = k;
                break;
            }
        }
        const act = { kind, ws: a.focusWsId };
        switch (kind) {
        case "open":
        case "dialog":
        case "fixed":
            await this.open(kind);
            break;
        case "close": {
            const all = [];
            const t = await this.sway.ipc.send(4);
            const walk = c => {
                if (isView(c))
                    all.push(c.id);
                (c.nodes || []).concat(c.floating_nodes || []).forEach(walk);
            };
            walk(t);
            if (all.length)
                await this.cmd(`[con_id=${this.pick(all)}] kill`);
            break;
        }
        case "key":
        case "tick": {
            act.action = this.pick(Object.keys(KEYS));
            act.before = a;
            if (kind === "key")
                await this.key(act.action);
            else {
                this.note(`tick ${act.action}`);
                await this.sway.ipc.send(10, "tile " + act.action);
            }
            break;
        }
        case "drag":
            if (!(await this.drag(a)))
                act.kind = "none";
            break;
        case "workspace":
            await this.cmd(`workspace number ${1 + Math.floor(this.rng() * 3)}`);
            break;
        case "movews":
            await this.cmd(`move container to workspace number ${1 + Math.floor(this.rng() * 3)}`);
            break;
        case "floating":
            await this.cmd("floating toggle");
            break;
        case "fullscreen":
            await this.cmd("fullscreen toggle");
            break;
        case "scratch":
            await this.cmd(this.rng() < 0.5 ? "move scratchpad" : "scratchpad show");
            break;
        case "layout":
            await this.cmd(this.pick(["layout tabbed", "layout stacking", "layout toggle split", "split v", "split h"]));
            break;
        case "movedir":
            await this.cmd(`move ${this.pick(["left", "right", "up", "down"])}`);
            break;
        case "resize":
            await this.cmd(`resize ${this.pick(["grow", "shrink"])} width 60 px`);
            break;
        }
        return act;
    }

    bad(msg) {
        if (!this.fail)
            this.fail = msg;
        this.note("FAIL " + msg);
    }

    check(act, a) {
        for (const ws of a.ws) {
            let m = this.model.get(ws.id);
            if (!m) {
                this.model.set(ws.id, { auto: ws.shape !== "manual", order: ws.order, parents: ws.parents, shape: ws.shape });
                continue;
            }
            if (m.tainted || a.hiddenFs.some(id => m.order.includes(id))) {
                m.tainted = true;
                continue;
            }
            if (ws.busy || a.global)
                continue;
            const changed = !sameSet(m.order, ws.order);
            const keyed = act.action && act.ws === ws.id && !act.busy;
            if (keyed) {
                const b = m.order, n = b.length, f0 = act.before.focusFloating ? -1 : b.indexOf(act.before.focused);
                if (act.action === "retile") {
                    if (n >= 2 && !(ws.shape === "master" && eq(ws.order, b)))
                        this.bad(`retile gave ${ws.shape} [${ws.order}] from [${b}]`);
                    m.auto = true;
                } else if (act.action === "monocle") {
                    const want = m.shape === "monocle" ? "master" : "monocle";
                    if (n >= 2 && ws.shape !== want)
                        this.bad(`monocle toggle gave ${ws.shape}, wanted ${want}`);
                    m.auto = true;
                } else if (f0 >= 0 && n >= 2 && !changed) {
                    const next = act.action.endsWith("next") ? (f0 + 1) % n : (f0 + n - 1) % n;
                    if (act.action.startsWith("focus") && a.focused !== b[next])
                        this.bad(`${act.action}: focus ${a.focused}, wanted ${b[next]}`);
                    if (act.action.startsWith("swap") || act.action === "zoom") {
                        const o = b.slice(), i = act.action === "zoom" ? (f0 === 0 ? 1 : f0) : next, j = act.action === "zoom" ? 0 : f0;
                        [o[i], o[j]] = [o[j], o[i]];
                        if (!eq(ws.order, o))
                            this.bad(`${act.action}: order [${ws.order}], wanted [${o}]`);
                    }
                }
            } else if (m.auto) {
                if (changed) {
                    const want = m.order.filter(id => ws.order.includes(id)).concat(ws.order.filter(id => !m.order.includes(id)));
                    if (ws.shape === "manual")
                        this.bad(`automatic workspace ${ws.name} left ${ws.shape} after windows changed`);
                    else if (ws.shape === "master" && m.shape !== "monocle" && !eq(ws.order, want))
                        this.bad(`order [${ws.order}], wanted [${want}]`);
                } else if (ws.shape === "manual") {
                    if (!USER_REARRANGE.has(act.kind))
                        this.bad(`${ws.name} turned manual after ${act.kind}`);
                    m.auto = false;
                }
            } else if (ws.shape !== "manual") {
                m.auto = true;
            } else if (changed) {
                for (const id of ws.order)
                    if (m.parents[id] !== undefined && m.parents[id] !== ws.parents[id] && a.ids.has(m.parents[id]) && act.kind !== "drag" && act.kind !== "movedir" && act.kind !== "layout")
                        this.bad(`manual layout of ${ws.name} changed: ${id} moved from ${m.parents[id]} to ${ws.parents[id]}`);
            }
            m.order = ws.order;
            m.parents = ws.parents;
            m.shape = ws.shape;
        }
    }

    async run() {
        const t0 = now();
        try {
            this.sway = await startSway(this.mode);
            this.events = await Ipc.connect(this.sway.sock);
            this.events.onEvent = () => (this.lastEvent = now());
            await this.events.send(2, JSON.stringify(["window", "workspace", "binding"]));
            this.pointer = new Pointer(this.bins.client, this.sway.env);
            await this.pointer.ready;
            let tileErr = "";
            // TILE_OFF=1 runs the same actions without the tiler (checks are skipped).
            const tileBin = process.env.TILE_OFF ? "sleep" : this.bins.tile, tileArgs = process.env.TILE_OFF ? ["600"] : [];
            const debugEnv = process.env.TILE_DEBUG ? { SWAYDESK_TILE_DEBUG: "1" } : {};
            this.tile = spawn(tileBin, tileArgs, { env: Object.assign({}, this.sway.env, debugEnv, { ASAN_OPTIONS: "exitcode=99:detect_leaks=1", UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1" }), stdio: ["ignore", "ignore", "pipe"] });
            this.tile.stderr.on("data", d => {
                tileErr = (tileErr + d).slice(-6000);
                for (const line of String(d).split("\n")) {
                    if (line.includes("command failed"))
                        this.commandErrors.push(line.trim());
                    if (line.includes(": run: "))
                        this.note("  tile " + line.slice(line.indexOf(": run: ") + 7));
                }
            });
            this.tileErr = () => tileErr;
            await sleep(80);
            let a = await this.tree();
            this.check({ kind: "start" }, a);
            for (let i = 0; i < this.opts.steps && !this.fail; i++) {
                a.focusWsId = a.focusWs ? a.focusWs.id : (a.ws[0] || {}).id;
                const ws = a.ws.find(w => w.id === a.focusWsId);
                const act = await this.step(a);
                act.busy = !!(ws && ws.busy) || a.global;
                await this.settle(act.kind === "floating" || act.kind === "scratch" || act.kind === "fullscreen" ? 120 : 25);
                if (this.sway.exited()) {
                    this.note("sway: " + this.sway.stderr().split("\n").filter(l => /ERROR|assert|Expected/i.test(l)).slice(-4).join(" | "));
                    this.bad("sway-crash");
                    break;
                }
                if (this.tile.exitCode !== null) {
                    this.bad("tiler exited " + this.tile.exitCode + ": " + tileErr.slice(-1500));
                    break;
                }
                a = await this.tree();
                if (a.views !== this.alive().length) {
                    await sleep(300);
                    a = await this.tree();
                    if (a.views !== this.alive().length)
                        this.bad(`windows: ${a.views} in tree, ${this.alive().length} clients`);
                }
                if (!process.env.TILE_OFF)
                    this.check(act, a);
                // TILE_DUMP=k: compact tree (scratchpad included) after every step from k on.
                if (process.env.TILE_DUMP && i + 1 >= +process.env.TILE_DUMP) {
                    const t = await this.sway.ipc.send(4);
                    const c = n => `${n.type === "workspace" ? "ws" + n.name : n.id}${n.pid ? "w" : ""}${n.layout && n.layout !== "none" ? ":" + n.layout : ""}${n.fullscreen_mode && n.type !== "workspace" ? "!FS" + n.fullscreen_mode : ""}${n.focused ? "*" : ""}` +
                        ((n.nodes || []).length ? "(" + n.nodes.map(c).join(" ") + ")" : "") + ((n.floating_nodes || []).length ? "{" + n.floating_nodes.map(c).join(" ") + "}" : "");
                    this.note(`  tree@${i + 1}: ` + t.nodes.map(o => o.nodes.map(c).join(" ")).join(" | "));
                }
                // TILE_PROBE=k (with TILE_OFF): after step k, focus every tiled window to see whether Sway is already broken.
                if (process.env.TILE_PROBE && i + 1 === +process.env.TILE_PROBE) {
                    for (const w of a.ws)
                        for (const id of w.order) {
                            await this.sway.ipc.send(0, `[con_id=${id}] focus`).catch(() => {});
                            await sleep(20);
                            if (this.sway.exited()) {
                                console.log(`PROBE step ${i + 1}: focus ${id} crashed Sway`);
                                break;
                            }
                        }
                    if (!this.sway.exited())
                        console.log(`PROBE step ${i + 1}: ok`);
                    break;
                }
                this.note("  = " + a.ws.map(w => `${w.name}:${w.shape}${this.model.get(w.id) && !this.model.get(w.id).auto ? "(manual)" : ""}[${w.order}]`).join("  "));
                if (this.commandErrors.length)
                    this.bad("command failed: " + this.commandErrors[0]);
            }
        } catch (e) {
            this.bad("harness: " + e.message);
        }
        await this.close();
        return { seed: this.seed, ok: !this.fail, fail: this.fail, ms: now() - t0, log: this.log };
    }

    async close() {
        if (this.pointer)
            this.pointer.close();
        for (const p of this.clients)
            try {
                p.kill("SIGKILL");
            } catch (e) {}
        if (this.sway) {
            this.sway.ipc.send(0, "exit").catch(() => {});
            const t0 = now();
            while (!this.sway.exited() && now() - t0 < 2000)
                await sleep(10);
            if (!this.sway.exited())
                try {
                    this.sway.proc.kill("SIGKILL");
                } catch (e) {}
            this.sway.ipc.close();
            if (this.events)
                this.events.close();
        }
        if (this.tile) {
            const t0 = now();
            while (this.tile.exitCode === null && now() - t0 < 3000)
                await sleep(10);
            if (this.tile.exitCode === null) {
                this.tile.kill("SIGKILL");
                this.bad("tiler did not exit with Sway");
            } else if (this.tile.exitCode !== 0 && !this.fail) {
                this.bad("tiler exit " + this.tile.exitCode + " (sanitizer): " + this.tileErr().slice(-1500));
            }
        }
        if (this.sway)
            fs.rmSync(this.sway.dir, { recursive: true, force: true });
    }
}

async function main() {
    const opts = parseArgs(process.argv);
    const bins = build(process.env.TILE_BIN_DIR || path.join(os.tmpdir(), "tile-test-bin"));
    const seeds = opts.seeds || Array.from({ length: opts.scenarios }, (_, i) => (opts.seed * 1000003 + i * 7919) >>> 0);
    const results = [];
    let next = 0, done = 0;
    const t0 = now();
    const worker = async () => {
        while (next < seeds.length) {
            const seed = seeds[next++];
            const r = await new Scenario(seed, opts, bins).run();
            results.push(r);
            done++;
            if (!r.ok) {
                console.log(`FAIL seed ${seed}: ${r.fail}`);
                if (opts.seeds || opts.verbose)
                    console.log(r.log.slice(-25).map(l => "  " + l).join("\n"));
            }
            if (done % 50 === 0)
                console.log(`${done}/${seeds.length} done, ${results.filter(x => !x.ok).length} failed, ${((now() - t0) / 1000).toFixed(0)} s`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(opts.jobs, seeds.length) }, worker));
    const failed = results.filter(r => !r.ok);
    const types = {};
    for (const r of failed) {
        const k = r.fail.replace(/[\d,]+/g, "#").slice(0, 70);
        types[k] = (types[k] || 0) + 1;
    }
    console.log(JSON.stringify({ scenarios: results.length, passed: results.length - failed.length, failed: failed.length, failedSeeds: failed.map(r => r.seed).slice(0, 40), types, wallSec: Math.round((now() - t0) / 1000) }, null, 1));
    process.exit(failed.length ? 1 : 0);
}

main();
