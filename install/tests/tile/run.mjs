#!/usr/bin/env node
// Headless Sway test for swaydesk-tile: random sessions (windows, keys, mouse drags into every drop
// zone, floating, fullscreen, scratchpad, workspaces, two outputs), checked against the tiling rules
// after each step.
// node run.mjs [--scenarios N] [--jobs J] [--seed S] [--steps K] [--replay SEED,...] [--verbose] [--stats]
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

// Pointer buttons stand in for keys: the tiler keys and the commands a user has on keys.
const KEYS = { "retile": 275, "monocle": 276, "zoom": 277, "focus next": 278, "focus prev": 279, "swap next": 256, "swap prev": 257 };
const USER_COMMANDS = [
    "layout tabbed", "layout stacking", "layout toggle split", "split v", "split h",
    "move left", "move right", "move up", "move down",
    "resize grow width 60 px", "resize shrink width 60 px",
    "floating toggle", "fullscreen toggle", "move scratchpad", "scratchpad show",
    "workspace number 1", "workspace number 2", "workspace number 3",
    "move container to workspace number 1", "move container to workspace number 2", "move container to workspace number 3",
    "focus output right", "focus output left", "move container to output right", "move container to output left",
    "move workspace to output right", "focus parent",
];
const SPARE = [258, 259, 260, 261, 262, 263, 264, 265, 273, 274];
for (let c = 288; c <= 318; c++)
    if (c < 300 || c > 302)
        SPARE.push(c);
const USER = Object.fromEntries(USER_COMMANDS.map((c, i) => [c, SPARE[i]]));
const BTN_LEFT = 272;
const OUTPUTS = ["1920x1080", "2560x1440", "1366x768", "1080x1920"];
const TAIL = "_swaydesk_tail";
// Steps after which a layout may be the user's own.
// (Sway also re-inserts a window that is "moved" to the workspace it is on.)
// A press near the master/stack border can land on a title bar or the gap; Sway then moves windows.
const USER_REARRANGE = new Set(["drag", "mresize", "layout", "movedir", "movews", "moveout", "combo"]);
// Steps made of several actions at once; the tiler may meet a tree that is already out of date.
const LOOSE = new Set(["burst", "rapid", "combo"]);
// Steps that must leave the master width alone.
const KEEPS_WIDTH = new Set(["open", "openfocus", "dialog", "fixed", "close", "key", "tick", "workspace", "burst"]);

function parseArgs(argv) {
    const o = { scenarios: 100, jobs: Math.max(1, Math.min(12, os.cpus().length - 4)), seed: 1, steps: 60, seeds: null, verbose: false, stats: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i], v = () => argv[++i];
        if (a === "--scenarios") o.scenarios = +v();
        else if (a === "--jobs") o.jobs = +v();
        else if (a === "--seed") o.seed = +v();
        else if (a === "--steps") o.steps = +v();
        else if (a === "--replay") o.seeds = v().split(",").map(Number);
        else if (a === "--verbose") o.verbose = true;
        else if (a === "--stats") o.stats = true;
        else {
            console.log("node run.mjs [--scenarios N] [--jobs J] [--seed S] [--steps K] [--replay SEED,...] [--verbose] [--stats]");
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
    // TILE_BIN=<program> tests that tiler instead (a build without sanitizers, for timings).
    return { tile: process.env.TILE_BIN || path.join(dir, "swaydesk-tile-asan"), client: path.join(dir, "dwclient") };
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

function swayConfig(mode, vertical) {
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
        ...(vertical ? ["default_orientation vertical"] : []),
        'for_window [app_id="^dwdialog$"] floating enable, move position center',
        `for_window [tiling workspace=__focused__] move container to mark ${TAIL}`,
        ...Object.entries(KEYS).map(([a, b]) => `bindcode --whole-window ${b} nop tile ${a}`),
        ...Object.entries(USER).map(([a, b]) => `bindcode --whole-window ${b} ${a}`),
        `output HEADLESS-1 mode ${mode} position 0 0`,
    ].join("\n") + "\n";
}

async function startSway(mode, vertical) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tilesway-"));
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(path.join(dir, "config"), swayConfig(mode, vertical));
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
    const out = { ws: [], focused: null, focusFloating: false, focusKind: null, views: 0, ids: new Set(), global: false, wsOf: new Map(), tail: [], floats: [], outputs: [], current: new Set() };
    const visit = (n, parent, ws, floating) => {
        out.ids.add(n.id);
        if (ws)
            out.wsOf.set(n.id, ws.id);
        if (ws && floating)
            (ws._floats || (ws._floats = [])).push(n.id);
        n._parent = parent;
        if (n.focused) {
            out.focused = n.id;
            out.focusFloating = floating;
            out.focusWs = ws;
            out.focusKind = isView(n) ? "view" : n.type === "workspace" ? "workspace" : "container";
        }
        if ((n.marks || []).includes(TAIL))
            out.tail.push(n.id);
        if (isView(n))
            out.views++;
        if (n.fullscreen_mode === 2)
            out.global = true;
        // Sway reports fullscreen_mode 1 on every workspace itself.
        if (n.fullscreen_mode > 0 && ws && n.type !== "workspace")
            ws._busy = true;
        for (const c of n.nodes || [])
            visit(c, n, ws || (n.type === "workspace" ? n : null), floating);
        for (const c of n.floating_nodes || [])
            visit(c, n, ws || (n.type === "workspace" ? n : null), true);
    };
    for (const o of tree.nodes) {
        if (o.name !== "__i3") {
            out.outputs.push({ name: o.name, rect: o.rect, current: o.current_workspace });
            out.current.add(o.current_workspace);
        }
        for (const w of o.nodes) {
            w._output = o.rect;
            visit(w, o, w, false);
        }
    }
    const x0 = Math.min(...out.outputs.map(o => o.rect.x)), y0 = Math.min(...out.outputs.map(o => o.rect.y));
    out.box = { x: x0, y: y0, width: Math.max(...out.outputs.map(o => o.rect.x + o.rect.width)) - x0, height: Math.max(...out.outputs.map(o => o.rect.y + o.rect.height)) - y0 };
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
            for (const f of w.floating_nodes || [])
                out.floats.push({ id: f.id, rect: f.rect, fullscreen: f.fullscreen_mode > 0, output: o.rect, ws: w.id });
            out.ws.push({ id: w.id, name: w.name, node: w, order, parents, rects, shape: shapeOf(w, order.length), busy: !!w._busy, floats: w._floats || [], output: w._output, visible: o.current_workspace === w.name });
        }
    return out;
}

function down(n) {
    while (!isView(n) && n.nodes && n.nodes.length === 1)
        n = n.nodes[0];
    return n;
}

function masterRoot(ws) {
    let r = ws;
    while (r.nodes.length === 1 && !isView(r.nodes[0]))
        r = r.nodes[0];
    return r;
}

function shapeOf(ws, n) {
    if (n === 0)
        return "empty";
    if (n === 1)
        return "single";
    const r = masterRoot(ws);
    const kids = r.nodes.map(down);
    if (r.layout === "tabbed" || r.layout === "stacked")
        return kids.every(isView) ? "monocle" : "manual";
    if (r.layout !== "splith" || kids.length !== 2 || !isView(kids[0]))
        return "manual";
    if (isView(kids[1]))
        return "master";
    return kids[1].layout === "splitv" && kids[1].nodes.map(down).every(isView) ? "master" : "manual";
}

// Master width as a share of the layout, and whether the stack windows are equally high.
function masterSizes(ws) {
    if (ws.shape !== "master")
        return null;
    const r = masterRoot(ws.node), m = ws.rects[ws.order[0]].rect, hs = ws.order.slice(1).map(id => ws.rects[id].rect.height);
    return { master: ws.order[0], frac: m.width / r.rect.width, even: Math.max(...hs) - Math.min(...hs) <= 0.04 * r.rect.height };
}

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// The commands of one tiler batch: [{ ids: [con ids], words: "move container to mark ..." }].
function parseBatch(line) {
    const ops = [];
    for (const part of line.split("; ")) {
        const m = /^\[con_id=(\d+)([^\]]*)\] (.*)$/.exec(part);
        for (const words of (m ? m[3] : part).split(", "))
            ops.push({ id: m ? +m[1] : null, floating: !!m && m[2].includes("floating"), words });
    }
    return ops;
}

const moves = op => /^(move|swap|layout) /.test(op.words);

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
        this.mode = OUTPUTS[Math.floor(this.rng() * OUTPUTS.length)];
        this.second = this.rng() < 0.35 ? OUTPUTS[Math.floor(this.rng() * OUTPUTS.length)] : null;
        this.vertical = this.rng() < 0.2;
        this.model = new Map();
        this.taintedWs = new Set();
        this.stats = {};
        this.cur = { batches: [], passes: [], fails: [] };
        this.parentFocus = false;
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
        const t = await this.sway.ipc.send(4);
        if (!t)
            throw new Error("no tree");
        return analyze(t);
    }

    async cmd(c) {
        this.note("> " + c);
        return this.sway.ipc.send(0, c);
    }

    // Bindings on pointer buttons only fire over a window.
    async aim() {
        const a = this.a, ws = a.ws.find(w => w.id === a.focusWsId);
        if (!ws || !ws.order.length)
            return false;
        const r = ws.busy || a.global ? ws.output : (ws.rects[a.focused] || ws.rects[ws.order[0]]).rect;
        await this.pointerTo(r.x + r.width / 2, r.y + r.height / 2);
        return true;
    }

    async press(code) {
        await this.pointer.send(`b ${code} 1`);
        await this.pointer.send(`b ${code} 0`);
    }

    // A command the user has on a key: by key (the tiler gets a binding event) or, for the ones
    // that raise a window event themselves, also as a plain command.
    async user(c, byKey) {
        if (!byKey || !(await this.aim()))
            return this.cmd(c);
        this.note("key> " + c);
        await this.press(USER[c]);
    }

    async settle(min) {
        const t0 = now();
        await sleep(min);
        while (now() - this.lastEvent < 45 && now() - t0 < 2000)
            await sleep(10);
    }

    alive() {
        return this.clients.filter(c => c.proc.exitCode === null && c.proc.signalCode === null);
    }

    spawnClient(kind) {
        const appId = kind === "dialog" ? "dwdialog" : this.pick(["term", "files", "web", "edit"]);
        const args = [appId, `w${++this.n}`];
        if (kind === "fixed")
            args.push("fixed");
        this.note(`open ${args.join(" ")}`);
        const name = args[1];
        const c = { proc: spawn(this.bins.client, args, { env: this.sway.env, stdio: ["pipe", "pipe", "ignore"] }), sizes: [], from: 0, buf: "", name };
        c.proc.stdin.on("error", () => {});
        c.proc.stdout.on("data", d => {
            c.buf += d;
            let k;
            while ((k = c.buf.indexOf("\n")) >= 0) {
                const m = /^c (\d+) (\d+)/.exec(c.buf.slice(0, k));
                c.buf = c.buf.slice(k + 1);
                if (m)
                    c.sizes.push(m[1] + "x" + m[2]);
            }
        });
        this.clients.push(c);
    }

    async mapped() {
        const t0 = now();
        while (now() - t0 < 1500) {
            const a = await this.tree();
            if (a.views >= this.alive().length)
                break;
            await sleep(10);
        }
    }

    async open(kind) {
        this.spawnClient(kind);
        await this.mapped();
    }

    async key(action) {
        this.note(`key ${action}`);
        if (await this.aim())
            await this.press(KEYS[action]);
        else
            await this.sway.ipc.send(10, "tile " + action);
    }

    async pointerTo(x, y) {
        const b = this.box, cl = (v, hi) => Math.max(0, Math.min(hi - 1, Math.round(v)));
        await this.pointer.send(`a ${cl(x - b.x, b.width)} ${cl(y - b.y, b.height)} ${b.width} ${b.height}`);
    }

    async dragLine(from, to) {
        await this.pointerTo(from.x, from.y);
        await this.pointer.send(`b ${BTN_LEFT} 1`);
        const steps = 3 + Math.floor(this.rng() * 3);
        for (let s = 1; s <= steps; s++)
            await this.pointerTo(from.x + (to.x - from.x) * s / steps, from.y + (to.y - from.y) * s / steps);
        await this.pointer.send(`b ${BTN_LEFT} 0`);
    }

    // Drag a tiled window by its title bar into one of the drop zones of another window, of the
    // workspace, or onto the other output.
    async drag(a) {
        const ws = a.ws.find(w => w.id === a.focusWsId);
        if (!ws || !ws.order.length)
            return false;
        const src = ws.rects[this.pick(ws.order)];
        const parent = src._parent, pr = parent.rect, d = src.deco_rect;
        if (!d || d.height <= 0)
            return false;
        const from = { x: pr.x + d.x + d.width / 2, y: pr.y + d.y + d.height / 2 };
        const other = a.ws.filter(w => w.visible && w.id !== ws.id);
        const across = other.length && this.rng() < (ws.order.length < 2 ? 1 : 0.2) ? this.pick(other) : null;
        const tws = across || ws;
        const others = tws.order.filter(id => id !== src.id).map(id => tws.rects[id]);
        let to;
        if (!others.length) {
            if (!across)
                return false;
            const o = across.node.rect;
            to = { x: o.x + o.width / 2, y: o.y + o.height / 2, zone: "empty output" };
        } else {
            const t = this.pick(others), r = t.rect, z = this.rng();
            if (z < 0.25)
                to = { x: r.x + r.width / 2, y: r.y + r.height / 2, zone: "centre" };
            else if (z < 0.55) {
                const e = this.pick(["top", "bottom", "left", "right"]), f = 0.05 + this.rng() * 0.2;
                to = { x: e === "left" ? r.x + r.width * f : e === "right" ? r.x + r.width * (1 - f) : r.x + r.width / 2, y: e === "top" ? r.y + r.height * f : e === "bottom" ? r.y + r.height * (1 - f) : r.y + r.height / 2, zone: e };
            } else if (z < 0.7) {
                const tp = t._parent.rect, td = t.deco_rect;
                to = { x: tp.x + td.x + td.width * (0.1 + this.rng() * 0.8), y: tp.y + td.y + Math.max(1, td.height / 2), zone: "titlebar" };
            } else if (z < 0.85) {
                const e = this.pick(["top", "bottom", "left", "right"]), o = tws.node.rect;
                to = { x: e === "left" ? o.x + 6 : e === "right" ? o.x + o.width - 6 : o.x + o.width / 2, y: e === "top" ? o.y + 6 : e === "bottom" ? o.y + o.height - 6 : o.y + o.height / 2, zone: "edge-" + e };
            } else {
                const o = tws.node.rect;
                to = { x: o.x + this.rng() * o.width, y: o.y + this.rng() * o.height, zone: "random" };
            }
            to.zone += ` of ${t.id}`;
        }
        this.note(`drag ${src.id} (${Math.round(from.x)},${Math.round(from.y)}) -> ${to.zone}${across ? " on the other output" : ""} (${Math.round(to.x)},${Math.round(to.y)})`);
        await this.dragLine(from, to);
        return true;
    }

    // Drag the border between the master and the stack.
    async borderDrag(ws) {
        const m = ws.rects[ws.order[0]].rect, by = (this.rng() < 0.5 ? -1 : 1) * (40 + Math.floor(this.rng() * 100));
        const from = { x: m.x + m.width - 1, y: m.y + m.height / 2 };
        this.note(`border drag (${from.x},${Math.round(from.y)}) by ${by}`);
        await this.dragLine(from, { x: from.x + by, y: from.y });
    }

    allViews(t) {
        const all = [];
        const walk = c => {
            if (isView(c))
                all.push(c.id);
            (c.nodes || []).concat(c.floating_nodes || []).forEach(walk);
        };
        walk(t);
        return all;
    }

    async step(a) {
        const n = this.alive().length, ws = a.ws.find(w => w.id === a.focusWsId), m = ws && this.model.get(ws.id);
        // Windows behind a fullscreen one cannot be seen, dragged or split.
        const free = ws && !ws.busy && !a.global;
        const tiled = free ? ws.order.length : 0, two = a.outputs.length > 1;
        const w = {
            open: n < 8 ? 20 : 0, dialog: n < 8 ? 3 : 0, fixed: n < 8 ? 2 : 0, burst: n < 6 ? 3 : 0, rapid: n < 7 ? 3 : 0,
            openfocus: n < 8 && tiled >= 2 ? 5 : 0, close: n ? 13 : 0, key: 20, tick: 3,
            drag: tiled >= 2 || (two && tiled) ? 13 : 0, workspace: 4, movews: tiled ? 4 : 0, floating: n ? 4 : 0, fullscreen: n ? 3 : 0,
            scratch: n ? 4 : 0, layout: tiled >= 2 ? 4 : 0, movedir: tiled >= 2 ? 3 : 0, resize: tiled >= 2 ? 3 : 0,
            mresize: free && ws.shape === "master" ? 2 : 0, output: two ? 3 : 0, moveout: two && tiled ? 3 : 0, combo: n ? 2 : 0,
            retitle: n ? 5 : 0, reload: 1,
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
        // Sway raises no event for a mouse drag, so after one the tiler may not have looked yet.
        const auto = m && m.auto && !m.tainted && free;
        const placed = auto && !this.unsynced && (a.focusKind === "view" || !ws.order.length);
        const act = { kind, ws: a.focusWsId, before: a, label: kind };
        const byKey = this.rng() < 0.5;
        switch (kind) {
        case "openfocus": {
            const id = this.rng() < 0.5 ? ws.order[0] : this.pick(ws.order.slice(1));
            await this.cmd(`[con_id=${id}] focus`);
            await sleep(30);
            act.label = `open:${auto ? ws.shape : "manual"}:${id === ws.order[0] ? "master" : "stack"} focused`;
            act.placed = placed;
            await this.open("open");
            break;
        }
        case "open":
            act.label = `open:${!ws ? "none" : auto ? ws.shape : free ? "manual" : "fullscreen"}`;
            act.placed = placed;
            await this.open(kind);
            break;
        case "dialog":
        case "fixed":
            await this.open(kind);
            break;
        case "burst": {
            const k = 2 + Math.floor(this.rng() * 3);
            for (let i = 0; i < k; i++)
                this.spawnClient("open");
            await this.mapped();
            break;
        }
        case "rapid": {
            const k = 3 + Math.floor(this.rng() * 4);
            for (let i = 0; i < k; i++) {
                const r = this.rng();
                if (r < 0.45 && this.alive().length < 8)
                    this.spawnClient("open");
                else if (r < 0.75) {
                    const all = this.allViews(await this.sway.ipc.send(4));
                    if (all.length)
                        await this.cmd(`[con_id=${this.pick(all)}] kill`);
                } else {
                    await this.key(this.pick(Object.keys(KEYS)));
                }
                if (this.rng() < 0.5)
                    await sleep(Math.floor(this.rng() * 12));
            }
            await this.mapped();
            break;
        }
        case "close": {
            const all = this.allViews(await this.sway.ipc.send(4));
            if (!all.length)
                break;
            const id = tiled >= 2 && this.rng() < 0.35 ? ws.order[0] : this.pick(all);
            const at = ws ? ws.order.indexOf(id) : -1;
            act.label = `close:${!auto || at < 0 || ws.shape !== "master" ? "other" : at === 0 ? "master" : "stack"}`;
            await this.cmd(`[con_id=${id}] kill`);
            break;
        }
        case "key":
        case "tick": {
            act.action = this.pick(Object.keys(KEYS));
            act.label = `key:${act.action}:${!ws ? "none" : auto ? ws.shape : free ? "manual" : "fullscreen"}`;
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
                act.kind = act.label = "none";
            break;
        case "workspace":
            await this.user(`workspace number ${1 + Math.floor(this.rng() * 3)}`, byKey);
            break;
        case "movews":
            await this.user(`move container to workspace number ${1 + Math.floor(this.rng() * 3)}`, byKey);
            break;
        case "floating":
            await this.user("floating toggle", byKey);
            break;
        case "fullscreen":
            await this.user("fullscreen toggle", byKey);
            break;
        case "scratch":
            await this.user(this.rng() < 0.5 ? "move scratchpad" : "scratchpad show", byKey);
            break;
        case "layout":
            await this.user(this.pick(["layout tabbed", "layout stacking", "layout toggle split", "split v", "split h"]), true);
            break;
        case "movedir":
            await this.user(`move ${this.pick(["left", "right", "up", "down"])}`, byKey);
            break;
        case "resize":
            await this.user(`resize ${this.pick(["grow", "shrink"])} width 60 px`, true);
            break;
        case "mresize":
            await this.borderDrag(ws);
            break;
        case "output":
            await this.user(`focus output ${this.pick(["left", "right"])}`, byKey);
            break;
        case "moveout":
            await this.user(this.pick(["move container to output right", "move container to output left", "move workspace to output right"]), byKey);
            break;
        case "retitle": {
            // Titles change all the time (a terminal's directory); nothing may move because of it.
            const live = this.alive();
            for (let i = 0; i < 3; i++) {
                const c = this.pick(live);
                this.note(`retitle ${c.name}`);
                c.proc.stdin.write("t\n");
            }
            break;
        }
        case "reload":
            await this.cmd("reload");
            await sleep(60);
            for (const c of this.alive())
                c.proc.stdin.write("t\n");
            break;
        case "combo": {
            const seq = this.pick([
                ["fullscreen toggle", "move scratchpad", "scratchpad show", "fullscreen toggle"],
                ["move scratchpad", "scratchpad show", "floating toggle"],
                ["floating toggle", "fullscreen toggle", "fullscreen toggle", "floating toggle"],
                ["fullscreen toggle", "open", "fullscreen toggle"],
                ["move scratchpad", "move scratchpad", "scratchpad show", "scratchpad show"],
                ["focus parent", "fullscreen toggle", "move scratchpad", "scratchpad show"],
                ["scratchpad show", "fullscreen toggle", "scratchpad show", "open"],
            ]);
            for (const c of seq) {
                if (c === "open" && this.alive().length < 8)
                    await this.open("open");
                else if (c !== "open")
                    await this.user(c, this.rng() < 0.5);
                if (c === "focus parent")
                    this.parentFocus = true;
                await sleep(Math.floor(this.rng() * 40));
            }
            break;
        }
        }
        return act;
    }

    bad(msg) {
        if (!this.fail)
            this.fail = msg;
        this.note("FAIL " + msg);
    }

    // How often each client was told a new size during the step.
    rounds() {
        let max = 0, configures = 0;
        for (const c of this.clients) {
            let last = null, k = 0;
            for (let i = 0; i < c.sizes.length; i++) {
                const s = c.sizes[i];
                if (i >= c.from)
                    configures++;
                if (s === "0x0" || s === last)
                    continue;
                if (i >= c.from)
                    k++;
                last = s;
            }
            c.from = c.sizes.length;
            max = Math.max(max, k);
        }
        return { max, configures };
    }

    check(act, a, rounds, i) {
        // Steps that always reach the tiler as an event; drags and some commands on containers do not.
        const dragged = ["drag", "mresize"].includes(act.kind), late = this.unsynced;
        const silent = dragged || act.kind === "combo" || act.kind === "reload";
        // (Sway 1.12 sends nothing when focus goes to a workspace that only has floating windows.)
        const heard = act.synced || (!silent && ((act.kind === "output" ? this.heardWorkspace : this.heard) > 0 || act.kind === "tick"));
        this.unsynced = !heard;
        const pre = new Map();
        for (const [id, m] of this.model)
            pre.set(id, { auto: m.auto || m.guess, shape: m.shape, tainted: m.tainted });
        for (const ws of a.ws) {
            let m = this.model.get(ws.id);
            if (!m) {
                // The tiler may have seen a workspace that is new here at an earlier, tidy moment.
                this.model.set(ws.id, { auto: ws.shape !== "manual", guess: i > 0, floats: ws.floats, order: ws.order, parents: ws.parents, shape: ws.shape, sizes: masterSizes(ws) });
                continue;
            }
            // A workspace that lost a fullscreen window to the scratchpad is left alone (Sway aborts
            // when a window there is focused).
            // The tiler sees every event, so its own report decides; a step that only looks like it is skipped.
            if (m.tainted || this.taintedWs.has(ws.id)) {
                m.tainted = true;
                continue;
            }
            if (a.hiddenFs.some(id => m.order.includes(id) || m.floats.includes(id)))
                continue;
            m.floats = ws.floats;
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
                } else if (f0 >= 0 && n >= 2 && !changed && !late) {
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
                if (ws.shape !== "manual")
                    m.auto = true;
            } else if (m.auto) {
                if (changed) {
                    // Windows that were there keep their reading order; new ones follow.
                    const want = ws.order.filter(id => m.order.includes(id)).concat(ws.order.filter(id => !m.order.includes(id)));
                    const was = act.before && act.before.ws.find(w => w.id === ws.id);
                    if (ws.shape === "manual" && (this.unsynced || late || (was && was.busy))) {
                        m.auto = !(dragged || late);
                        m.guess = true;
                    }
                    else if (ws.shape === "manual")
                        this.bad(`automatic workspace ${ws.name} left ${ws.shape} after windows changed`);
                    else if (this.unsynced || late || !was || was.busy) {
                    } else if (ws.shape === "master" && m.shape !== "monocle" && !LOOSE.has(act.kind) && !eq(ws.order, want))
                        this.bad(`order [${ws.order}], wanted [${want}]`);
                    else if (m.shape === "monocle" && ws.order.length >= 2 && ws.shape !== "monocle" && !LOOSE.has(act.kind))
                        this.bad(`tabs became ${ws.shape} after windows changed`);
                } else if ((act.kind === "retitle" || act.kind === "reload") && !late && !eq(ws.order, m.order)) {
                    this.bad(`windows moved after ${act.kind}: [${m.order}] to [${ws.order}]`);
                } else if (ws.shape === "manual") {
                    const was = act.before && act.before.ws.find(w => w.id === ws.id);
                    if (!USER_REARRANGE.has(act.kind) && was && !was.busy && !m.guess)
                        this.bad(`${ws.name} turned manual after ${act.kind}`);
                    m.auto = false;
                    m.guess = !heard;
                }
            } else if (ws.shape !== "manual") {
                m.auto = true;
                m.guess = false;
            } else if (changed && !LOOSE.has(act.kind) && !USER_REARRANGE.has(act.kind)) {
                const was = act.before.ws.find(w => w.id === ws.id);
                for (const id of was ? ws.order : [])
                    if (was.parents[id] !== undefined && was.parents[id] !== ws.parents[id] && a.ids.has(was.parents[id]))
                        this.bad(`manual layout of ${ws.name} changed: ${id} moved from ${was.parents[id]} to ${ws.parents[id]}`);
            }
            // The master keeps its width through steps that do not resize or rearrange.
            const sizes = masterSizes(ws);
            if (sizes && m.sizes && !late && sizes.master === m.sizes.master && KEEPS_WIDTH.has(act.kind) && !(keyed && !/^(focus|retile)/.test(act.action)) && Math.abs(sizes.frac - m.sizes.frac) > 0.03)
                this.bad(`master width went from ${m.sizes.frac.toFixed(3)} to ${sizes.frac.toFixed(3)} after ${act.kind}`);
            m.sizes = sizes;
            m.order = ws.order;
            m.parents = ws.parents;
            m.shape = ws.shape;
        }
        const ops = this.cur.batches.flatMap(parseBatch);
        const wsOf = id => a.wsOf.has(id) ? a.wsOf.get(id) : act.before && act.before.wsOf.get(id);
        // A layout made by hand is not touched (keys on that workspace aside).
        for (const op of ops) {
            const id = op.id === null ? null : wsOf(op.id), p = id === null ? null : pre.get(id);
            const was = id === null ? null : (act.before || a).ws.find(w => w.id === id);
            if (p && !late && was && !was.busy && !op.floating && op.id !== (act.before || a).focused && !p.auto && !p.tainted && !(act.action && act.ws === id) && !LOOSE.has(act.kind) && (moves(op) || /^focus/.test(op.words)))
                this.bad(`tiler ran "${op.words}" on ${op.id} in a workspace arranged by hand`);
        }
        // A new window is in its place before it is first drawn: nothing is moved afterwards.
        if (act.placed) {
            const fix = ops.find(op => moves(op) && wsOf(op.id) === act.ws);
            if (fix)
                this.bad(`new window was moved after it opened: ${fix.words}`);
        }
        // The mark for new windows sits on the last stack window of the focused master-stack workspace.
        if (this.unsynced)
            return;
        const fw = a.focusWs && a.ws.find(w => w.id === a.focusWs.id), fm = fw && this.model.get(fw.id);
        const tail = fw && fm && fm.auto && !fm.tainted && !fw.busy && !a.global && fw.shape === "master" ? [fw.order[fw.order.length - 1]] : [];
        if (!eq(a.tail, tail))
            this.bad(`mark ${TAIL} on [${a.tail}], wanted [${tail}] (focus ws ${fw ? fw.name : "-"} ${fw ? fw.shape : ""}${fw && fw.busy ? " busy" : ""}, auto ${fm ? fm.auto : "-"}${fm && fm.tainted ? " tainted" : ""}${fm && fm.guess ? " guess" : ""})`);
        if (a.focusKind === "container" && ops.some(op => op.words === "focus parent"))
            this.bad(`focus is on container ${a.focused} after ${act.kind}`);
        if (this.cur.fails.length && !LOOSE.has(act.kind) && !dragged)
            this.bad("command failed: " + this.cur.fails[0]);
    }

    // Floating windows that were just shown, floated or left fullscreen fit their output.
    checkFloats(a, before) {
        for (const f of a.floats)
            if (f.id === a.focused && !before.floats.some(b => b.id === f.id) && !f.fullscreen && (f.rect.width > f.output.width * 0.9 + 4 || f.rect.height > f.output.height * 0.9 + 4))
                this.bad(`floating window ${f.id} is ${f.rect.width}x${f.rect.height} on a ${f.output.width}x${f.output.height} output`);
    }

    record(act, rounds) {
        const s = this.stats[act.label] || (this.stats[act.label] = { n: 0, batches: 0, commands: 0, moves: 0, focus: 0, passes: 0, cpu: 0, wall: 0, rounds: 0, twice: 0, configures: 0, races: 0 });
        const ops = this.cur.batches.flatMap(parseBatch);
        s.n++;
        s.batches += this.cur.batches.length;
        s.commands += ops.length;
        s.moves += ops.filter(moves).length;
        s.focus += ops.filter(op => /^(focus|workspace)/.test(op.words)).length;
        s.passes += this.cur.passes.length;
        s.cpu += this.cur.passes.reduce((x, p) => x + p.cpu, 0);
        s.wall += this.cur.passes.length ? Math.max(...this.cur.passes.map(p => p.wall)) : 0;
        s.rounds += rounds.max;
        s.twice += rounds.max > 1 ? 1 : 0;
        s.configures += rounds.configures;
        s.races += this.cur.fails.length;
    }

    async run() {
        const t0 = now();
        try {
            this.sway = await startSway(this.mode, this.vertical);
            if (this.second) {
                await this.sway.ipc.send(0, "create_output");
                await this.sway.ipc.send(0, `output HEADLESS-2 mode ${this.second} position ${this.mode.split("x")[0]} 0`);
            }
            this.events = await Ipc.connect(this.sway.sock);
            this.events.onEvent = (type, e) => {
                this.lastEvent = now();
                if (type !== 3 || !["title", "mark", "urgent", "focus"].includes(e && e.change))
                    this.heard++;
                if (type === 0)
                    this.heardWorkspace++;
            };
            await this.events.send(2, JSON.stringify(["window", "workspace", "binding"]));
            this.pointer = new Pointer(this.bins.client, this.sway.env);
            await this.pointer.ready;
            let tileErr = "", rest = "";
            // TILE_OFF=1 runs the same actions without the tiler (checks are skipped).
            const tileBin = process.env.TILE_OFF ? "sleep" : this.bins.tile, tileArgs = process.env.TILE_OFF ? ["600"] : [];
            this.tile = spawn(tileBin, tileArgs, { env: Object.assign({}, this.sway.env, { SWAYDESK_TILE_DEBUG: "1", ASAN_OPTIONS: "exitcode=99:detect_leaks=1", UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1" }), stdio: ["ignore", "ignore", "pipe"] });
            this.tile.stderr.on("data", d => {
                tileErr = (tileErr + d).slice(-6000);
                const lines = (rest + d).split("\n");
                rest = lines.pop();
                for (const line of lines) {
                    const p = /pass: (\d+) us, cpu (\d+) us/.exec(line);
                    if (p)
                        this.cur.passes.push({ wall: +p[1], cpu: +p[2] });
                    else if (line.includes("left alone")) {
                        const w = /workspace (\d+) left alone/.exec(line);
                        if (w)
                            this.taintedWs.add(+w[1]);
                        this.note("  tile " + line.trim());
                    }
                    else if (line.includes("command failed")) {
                        this.cur.fails.push(line.trim());
                        this.note("  tile " + line.trim());
                    } else if (line.includes(": run: ")) {
                        this.cur.batches.push(line.slice(line.indexOf(": run: ") + 7));
                        if (process.env.TILE_DEBUG)
                            this.note("  tile " + line.slice(line.indexOf(": run: ") + 7));
                    }
                }
            });
            this.tileErr = () => tileErr;
            await sleep(80);
            let a = await this.tree();
            this.check({ kind: "start" }, a, { max: 0 }, 0);
            for (let i = 0; i < this.opts.steps && !this.fail; i++) {
                a.focusWsId = a.focusWs ? a.focusWs.id : (a.ws[0] || {}).id;
                this.box = a.box;
                const ws = a.ws.find(w => w.id === a.focusWsId);
                this.cur = { batches: [], passes: [], fails: [] };
                this.a = a;
                this.heard = this.heardWorkspace = 0;
                this.rounds();
                const act = await this.step(a);
                act.busy = !!(ws && ws.busy) || a.global;
                const floats = ["floating", "scratch", "fullscreen", "combo", "moveout", "movews", "drag"].includes(act.kind);
                await this.settle(floats ? 120 : 25);
                // Sway raises no event for a drag: the tiler sees it on its look once a second, or
                // at once when another program sends the tick "tile sync".
                if (["drag", "mresize", "combo", "reload"].includes(act.kind)) {
                    const r = this.rng();
                    if (r < 0.6)
                        await this.sway.ipc.send(10, "tile sync");
                    else if (r < 0.66)
                        await sleep(1150);
                    act.synced = r < 0.66;
                    await this.settle(40);
                }
                if (this.sway.exited()) {
                    // Why Sway stopped, and whether the tiler had sent anything during this step.
                    const why = this.sway.stderr().split("\n").filter(l => /ERROR|assert|Expected/i.test(l) && !l.includes("for_window")).slice(-1)[0] || "no message";
                    this.bad(`sway-crash (${why.replace(/^.*?\] \[/, "[")}) after ${act.label}, ${this.cur.batches.length} tiler batches in the step`);
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
                const rounds = this.rounds();
                // TILE_DUMP=k: compact tree (scratchpad included) after every step from k on.
                if (process.env.TILE_DUMP && i + 1 >= +process.env.TILE_DUMP) {
                    const t = await this.sway.ipc.send(4);
                    const c = n => `${n.type === "workspace" ? "ws" + n.name : n.id}${n.pid ? "w" + (process.env.TILE_DUMP_SIZE ? n.rect.width + "x" + n.rect.height : "") : ""}${n.layout && n.layout !== "none" ? ":" + n.layout : ""}${n.fullscreen_mode && n.type !== "workspace" ? "!FS" + n.fullscreen_mode : ""}${n.focused ? "*" : ""}${(n.marks || []).length ? "#" : ""}` +
                        ((n.nodes || []).length ? "(" + n.nodes.map(c).join(" ") + ")" : "") + ((n.floating_nodes || []).length ? "{" + n.floating_nodes.map(c).join(" ") + "}" : "");
                    this.note(`  tree@${i + 1}: ` + t.nodes.map(o => o.nodes.map(c).join(" ")).join(" | ") + `  (${this.cur.passes.length} tiler passes, resized ${rounds.max}x)`);
                }
                if (!process.env.TILE_OFF) {
                    this.check(act, a, rounds, i + 1);
                    if (floats && ["floating", "scratch", "fullscreen"].includes(act.kind))
                        this.checkFloats(a, act.before);
                    this.record(act, rounds);
                    // TILE_STATS_ONLY=1 keeps a session going for --stats whatever the checks say.
                    if (process.env.TILE_STATS_ONLY)
                        this.fail = null;
                }
                // TILE_HOLD=k: stop after step k and keep Sway running for a look with swaymsg.
                if (process.env.TILE_HOLD && i + 1 === +process.env.TILE_HOLD) {
                    console.log(`HOLD SWAYSOCK=${this.sway.sock}`);
                    await sleep(600000);
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
            }
        } catch (e) {
            await sleep(100);
            const why = this.sway ? this.sway.stderr().split("\n").filter(l => /ERROR|assert|Expected/i.test(l) && !l.includes("for_window")).slice(-1)[0] || "no message" : "";
            this.bad(this.sway && this.sway.exited() ? `sway-crash (${why.replace(/^.*?\] \[/, "[")}) during a step, ${this.cur.batches.length} tiler batches in the step` : "harness: " + e.message);
        }
        await this.close();
        return { seed: this.seed, ok: !this.fail, fail: this.fail, ms: now() - t0, log: this.log, stats: this.stats };
    }

    async close() {
        if (this.pointer)
            this.pointer.close();
        for (const c of this.clients)
            try {
                c.proc.kill("SIGKILL");
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
            while (this.tile.exitCode === null && now() - t0 < (process.env.TILE_OFF ? 0 : 3000))
                await sleep(10);
            if (this.tile.exitCode === null) {
                this.tile.kill("SIGKILL");
                if (!process.env.TILE_OFF)
                    this.bad("tiler did not exit with Sway");
            } else if (this.tile.exitCode !== 0 && !this.fail) {
                this.bad("tiler exit " + this.tile.exitCode + " (sanitizer): " + this.tileErr().slice(-1500));
            }
        }
        if (this.sway)
            fs.rmSync(this.sway.dir, { recursive: true, force: true });
    }
}

// Per kind of step: tiler batches and commands, time, and how often windows were resized.
function printStats(results) {
    const sum = {};
    for (const r of results)
        for (const [k, s] of Object.entries(r.stats)) {
            const t = sum[k] || (sum[k] = {});
            for (const f in s)
                t[f] = (t[f] || 0) + s[f];
        }
    const f = (x, n) => (x / n).toFixed(2).padStart(8);
    console.log("step".padEnd(34) + ["count", "batches", "commands", "moves", "focus", "passes", "cpu us", "wall us", "resizes", ">1 %", "config", "races"].map(h => h.padStart(9)).join(""));
    for (const k of Object.keys(sum).sort()) {
        const s = sum[k];
        console.log(k.padEnd(34) + String(s.n).padStart(9) + [s.batches, s.commands, s.moves, s.focus, s.passes, s.cpu, s.wall, s.rounds, s.twice * 100, s.configures, s.races].map(x => " " + f(x, s.n)).join(""));
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
            r.log = null;
            if (done % 50 === 0)
                console.log(`${done}/${seeds.length} done, ${results.filter(x => !x.ok).length} failed, ${((now() - t0) / 1000).toFixed(0)} s`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(opts.jobs, seeds.length) }, worker));
    if (opts.stats)
        printStats(results);
    const failed = results.filter(r => !r.ok);
    const types = {};
    for (const r of failed) {
        const k = r.fail.replace(/[\d,.]+/g, "#").slice(0, 70);
        types[k] = (types[k] || 0) + 1;
    }
    console.log(JSON.stringify({ scenarios: results.length, passed: results.length - failed.length, failed: failed.length, failedSeeds: failed.map(r => r.seed).slice(0, 60), types, wallSec: Math.round((now() - t0) / 1000) }, null, 1));
    process.exit(failed.length ? 1 : 0);
}

main();
