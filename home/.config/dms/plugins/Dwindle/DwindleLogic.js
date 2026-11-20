.pragma library

// Pure decision logic for DwindleDaemon.qml. No Qt or I/O here, so the test harness runs the same code.

function newState() {
    return { mru: [], held: [], off: {}, wsOf: {}, ownMoves: {}, unplaced: {}, needTidy: false, seq: 0 };
}

function isWindow(n) {
    return (n.type === "con" || n.type === "floating_con") && !(n.nodes && n.nodes.length) && (n.pid > 0 || n.app_id || n.window);
}

function tiled(n) {
    return n && n.type === "con" && !n._floating && isWindow(n);
}

// i3 IPC over a text socket (Quickshell.Io.Socket writes UTF-8 and reads UTF-8 text).
// A header byte >= 0x80 would be re-encoded on the way out, so the ASCII payload is padded
// with spaces until every length byte is below 0x80. Sway ignores the trailing spaces.
function ipcMessage(type, payload) {
    let p = payload;
    while ((p.length & 0x80) || (p.length & 0x8000) || (p.length & 0x800000))
        p += " ";
    const n = p.length;
    return "i3-ipc" + String.fromCharCode(n & 0x7f, (n >> 8) & 0x7f, (n >> 16) & 0x7f, 0, type, 0, 0, 0) + p;
}

// One reply is in flight at a time, so the buffer holds a single message. Its length bytes may
// arrive garbled by UTF-8 decoding; the type field ends in three zero bytes and the JSON starts
// right after them. Returns the parsed reply, or undefined while it is incomplete.
function ipcReply(buf) {
    const m = /\u0000\u0000\u0000(?=[\[{])/.exec(buf.slice(6, 40));
    if (buf.lastIndexOf("i3-ipc", 0) !== 0 || !m)
        return undefined;
    const body = buf.slice(6 + m.index + 3);
    const last = body.replace(/\s+$/, "").slice(-1);
    if (last !== "}" && last !== "]")
        return undefined;
    try {
        return parseTree(body);
    } catch (e) {
        return undefined;
    }
}

// Sway can print NaN for "percent" (a split with no size yet), which is not JSON.
function parseTree(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return JSON.parse(text.replace(/:\s*-?(NaN|Infinity)\b/g, ": 0"));
    }
}

function index(tree) {
    const ids = {};
    const walk = (n, parent, ws, floating) => {
        n._parent = parent;
        n._ws = ws;
        n._floating = floating;
        ids[n.id] = n;
        const w = n.type === "workspace" ? n : ws;
        for (const c of n.nodes || [])
            walk(c, n, w, floating);
        for (const c of n.floating_nodes || [])
            walk(c, n, w, true);
    };
    walk(tree, null, null, false);
    const map = {};
    for (const id in ids) {
        const n = ids[id];
        if (isWindow(n) && n._ws)
            map[id] = n._ws.name;
    }
    return { root: tree, ids: ids, wsMap: map };
}

// Criteria for a node that still has to be on the workspace it was read on. Commands on windows
// inside a container that was just sent to the scratchpad crash Sway 1.12, and a batch runs
// atomically, so this check is race free. Names that cannot be quoted safely go without it.
function sel(n, extra) {
    const name = n._ws ? n._ws.name : "";
    const ws = name && !/["\\^\]]/.test(name) ? ` workspace="^${name.replace(/[.*+?$(){}|[]/g, "[$&]")}$"` : "";
    return `[con_id=${n.id}${extra ? " " + extra : ""}${ws}]`;
}

function leaves(node) {
    const out = [];
    const walk = n => {
        for (const c of n.nodes || []) {
            if (tiled(c))
                out.push(c);
            else
                walk(c);
        }
    };
    walk(node);
    return out;
}

// A mouse drop onto a fullscreen window can hand fullscreen to a split container, so look at
// every tiled node. Moving windows out of such a container has crashed Sway 1.12.
function hasFullscreen(ws, except) {
    const walk = n => (n.nodes || []).some(c => (c.fullscreen_mode > 0 && c.id !== except) || walk(c));
    return walk(ws);
}

function dirOf(r) {
    return r.width > r.height ? "h" : "v";
}

function focusedNode(t) {
    for (const id in t.ids)
        if (t.ids[id].focused)
            return t.ids[id];
    return null;
}

function focusedWs(t) {
    const n = focusedNode(t);
    return !n ? null : n.type === "workspace" ? n : n._ws;
}

// A window still waiting for placement, or a container holding only such windows (the windows
// opened behind a fullscreen one can be left in a container of their own).
function unplaced(st, k, id) {
    if (!isWindow(k))
        return !!(k.nodes && k.nodes.length) && k.nodes.every(c => unplaced(st, c, id));
    return tiled(k) && (k.id === id || st.unplaced[k.id] || !(k.id in st.wsOf));
}

// P's box before the windows still waiting for placement took their share of each split.
// Sway leaves the rects of untouched ancestors stale after moves, so only the size ratios
// between siblings are used, scaled down from the workspace.
function slotOf(st, p, id) {
    const chain = [];
    for (let a = p; a._parent && a.type !== "workspace"; a = a._parent)
        chain.unshift(a);
    const slot = { width: p._ws.rect.width, height: p._ws.rect.height };
    for (const a of chain) {
        const y = a._parent;
        const key = y.layout === "splith" ? "width" : y.layout === "splitv" ? "height" : "";
        if (!key)
            continue;
        // A window's rect leaves out its title bar; a container's includes its children's.
        const size = k => k.rect[key] + (key === "height" && isWindow(k) && k.deco_rect ? k.deco_rect.height : 0);
        const kids = y.nodes || [];
        const placed = kids.filter(k => k === a || !unplaced(st, k, id));
        const total = kids.reduce((s, k) => s + size(k), 0);
        // Windows behind a fullscreen one, or in a subtree Sway has not arranged again yet, report
        // sizes that do not add up to the parent; assume the even split the plugin made.
        if (placed.some(k => !(size(k) > 0)) || Math.abs(total - y.rect[key]) > 10 * kids.length + 10)
            slot[key] /= placed.length;
        else
            slot[key] *= size(a) / placed.reduce((s, k) => s + size(k), 0);
    }
    return slot;
}

// The tile right before n in its container: where Sway inserted a window moved to a workspace
// (after its last focused tile there; the IPC focus lists do not always agree with that).
function prevTile(st, n) {
    const kids = n._parent ? n._parent.nodes || [] : [];
    const k = kids[kids.indexOf(n) - 1];
    return k && tiled(k) && !st.unplaced[k.id] ? k : null;
}

// moved: the window came from another workspace or output. It splits the tile it was put after.
// When it already forms a pair with that tile, the direction is left alone: a mouse drop on a
// window edge builds exactly such a pair, in the direction the user aimed at.
function place(st, t, id, snap, moved, seq) {
    const n = t.ids[id];
    if (!tiled(n) || !n._ws || n._ws.name === "__i3_scratch" || st.off[n._ws.name])
        return [];
    // Wait while another window covers the workspace. A global fullscreen window cannot be moved.
    // Held windows stay in the order they arrived, however often they are released and held again.
    if (n.fullscreen_mode === 2 || hasFullscreen(n._ws, id)) {
        const q = moved && prevTile(st, n);
        const h = { id: id, snap: q ? [q.id] : snap, seq: seq === undefined ? ++st.seq : seq };
        let i = st.held.length;
        while (i > 0 && st.held[i - 1].seq > h.seq)
            i--;
        st.held.splice(i, 0, h);
        st.unplaced[id] = true;
        return [];
    }
    const x = n._parent;
    if (!x || x.layout === "tabbed" || x.layout === "stacked")
        return [];
    // The partner is the most recently focused tile here that is already in place.
    let p = moved ? prevTile(st, n) : null;
    for (const s of moved ? [] : snap) {
        const c = t.ids[s];
        if (s !== id && c && c._ws === n._ws && tiled(c) && !st.unplaced[s]) {
            p = c;
            break;
        }
    }
    if (!p || p.fullscreen_mode > 0)
        return [];
    const kids = x.nodes || [];
    if (moved && kids.length === 2)
        return [];
    // A window that lands beside a tab group joins it.
    const grouped = p._parent.layout === "tabbed" || p._parent.layout === "stacked";
    const d = grouped ? "" : dirOf(slotOf(st, p, id));
    const cmds = [`${sel(p, "tiling")} mark --add _dw_p`];
    const move = `${sel(n, "tiling")} move container to mark _dw_p`;
    if (!grouped && kids.length === 2 && kids.some(k => k.id === p.id) && kids.some(k => k.id === id)) {
        // Already a pair: put the new window second and set the direction.
        const pair = kids[0].id === p.id ? [] : cmds.concat([move, "unmark _dw_p"]);
        return x.layout === "split" + d ? pair : pair.concat([`${sel(n, "tiling")} layout split${d}`]);
    }
    if (!grouped)
        cmds.push(`${sel(p, "tiling")} split ${d}`);
    cmds.push(move, "unmark _dw_p");
    // The window's old container may keep a single child once it leaves; tidy() flattens it.
    if (x !== p._parent && x.type === "con" && kids.length <= 2)
        st.needTidy = true;
    if (n.focused)
        cmds.push(`${sel(n, "tiling")} focus`);
    return cmds;
}

function tidy(st, t) {
    const cmds = [];
    // "split none" on a node flattens every one-child ancestor above it, so one command at the
    // bottom of a chain of one-child containers removes the whole chain.
    const walk = n => {
        let c = n;
        if (n.type === "con" && !n._floating && (n.layout === "splith" || n.layout === "splitv") && (n.nodes || []).length === 1 && n._ws && !st.off[n._ws.name]) {
            c = n.nodes[0];
            while (!isWindow(c) && (c.nodes || []).length === 1)
                c = c.nodes[0];
            cmds.push(`${sel(c)} split none`);
        }
        for (const k of c.nodes || [])
            walk(k);
    };
    walk(t.root);
    return cmds;
}

function tabs(st, t) {
    const ws = focusedWs(t);
    if (!ws || ws.name === "__i3_scratch")
        return [];
    const v = leaves(ws);
    if (v.length < 2 || hasFullscreen(ws))
        return [];
    // Keep the focused window, or the last focused tile when a floating window has focus.
    const focus = focusedNode(t);
    const f = v.find(w => w.focused) || st.mru.map(i => t.ids[i]).find(w => w && v.indexOf(w) >= 0) || v[0];
    const refocus = [`${sel(f, "tiling")} focus`];
    if (focus && focus !== f && focus._floating && isWindow(focus))
        refocus.push(`${sel(focus)} focus`);
    const tabsParent = v[0]._parent;
    const allTabbed = tabsParent && tabsParent.layout === "tabbed" && v.every(w => w._parent === tabsParent);
    const w = k => sel(v[k], "tiling");
    const cmds = [];
    if (!allTabbed) {
        cmds.push(`${w(0)} mark --add _dw_t`);
        for (let i = 1; i < v.length; i++)
            cmds.push(`${w(i)} move container to mark _dw_t`, `${w(i)} mark --add _dw_t`);
        cmds.push(`${w(0)} layout tabbed`);
        return cmds.concat(refocus, ["unmark _dw_t"]);
    }
    let r = { width: tabsParent.rect.width, height: tabsParent.rect.height };
    let d = dirOf(r);
    // A tab group moved to an empty workspace becomes the workspace's own layout. "layout" on a
    // top-level window would wrap the windows and keep the tabbed workspace around them (a second
    // tab bar), so the workspace itself gets the new layout, through focus.
    if (tabsParent.type === "workspace")
        cmds.push(`${w(0)} focus`, "focus parent", `layout split${d}`);
    else
        cmds.push(`${w(0)} layout split${d}`);
    for (let i = 1; i < v.length - 1; i++) {
        r = d === "h" ? { width: r.width / 2, height: r.height } : { width: r.width, height: r.height / 2 };
        d = dirOf(r);
        cmds.push(`${w(i)} mark --add _dw_t`, `${w(i)} split ${d}`, `${w(i + 1)} move container to mark _dw_t`);
    }
    return cmds.concat(refocus, ["unmark _dw_t"]);
}

// Flips the focused workspace in st.off. Returns its name, or "" when nothing is focused.
function toggle(st, t) {
    const ws = focusedWs(t);
    if (!ws)
        return "";
    if (st.off[ws.name])
        delete st.off[ws.name];
    else
        st.off[ws.name] = true;
    return ws.name;
}

function bindingAction(command) {
    const m = /(?:^|[,;]\s*)nop\s+dwindle\s+(tabs|toggle)\b/.exec(command || "");
    return m ? m[1] : "";
}

// Takes the next job off the queue. Every job tidies the tree it reads, so queued tidy jobs go too.
function nextJob(queue) {
    return { job: queue[0], rest: queue.slice(1).filter(j => j.kind !== "tidy") };
}

// Window event -> { jobs, tidy }. tidy asks the caller to (re)start the debounced tidy job.
// A window that maps floating (fixed size, has a parent) needs no job. The type in move events
// is not reliable (a tiled window moved to another output is reported as floating_con).
function onWindowEvent(st, change, c) {
    const out = { jobs: [], tidy: false };
    c = c || {};
    switch (change) {
    case "focus":
        st.mru = [c.id].concat(st.mru.filter(i => i !== c.id)).slice(0, 64);
        break;
    case "new":
        if (c.type === "floating_con")
            break;
        st.unplaced[c.id] = true;
        out.jobs.push({ kind: "place", id: c.id, snap: st.mru.slice(), seq: ++st.seq });
        break;
    case "floating":
        if (c.type === "con") {
            st.unplaced[c.id] = true;
            out.jobs.push({ kind: "place", id: c.id, snap: st.mru.filter(i => i !== c.id), seq: ++st.seq });
        } else
            out.tidy = true;
        break;
    case "move":
        if (st.ownMoves[c.id]) {
            delete st.ownMoves[c.id];
            break;
        }
        // Jobs that run before this one refresh wsOf, so remember where the window was.
        out.jobs.push({ kind: "moved", id: c.id, from: st.wsOf[c.id] });
        out.tidy = true;
        break;
    case "close":
        st.mru = st.mru.filter(i => i !== c.id);
        delete st.unplaced[c.id];
        out.tidy = true;
        break;
    }
    // Held windows wait for their workspace to lose its fullscreen window, which also happens
    // when that window closes, floats or moves away. place() holds them again if needed.
    // They go first so that their order survives repeated holds.
    if (st.held.length && (change === "close" || change === "floating" || change === "move" || (change === "fullscreen_mode" && c.fullscreen_mode === 0))) {
        out.jobs = st.held.map(j => ({ kind: "place", id: j.id, snap: j.snap, seq: j.seq })).concat(out.jobs);
        st.held = [];
    }
    return out;
}

// Runs one queued job against a freshly indexed tree. Returns { cmds, toggled }.
function runJob(st, job, t) {
    let cmds = [];
    let toggled = "";
    // Move events of the previous job have arrived by now; a stale entry would hide a user move.
    st.ownMoves = {};
    if (job.kind === "place") {
        cmds = place(st, t, job.id, job.snap, false, job.seq);
    } else if (job.kind === "moved") {
        const before = job.from;
        const now = t.wsMap[job.id];
        if (before !== undefined && now !== undefined && before !== now)
            cmds = place(st, t, job.id, st.mru.filter(i => i !== job.id), true, ++st.seq);
    } else if (job.kind === "tidy") {
        cmds = tidy(st, t);
    } else if (job.kind === "tabs") {
        // Moving every window leaves emptied wrappers behind; tidy once the batch has run.
        cmds = tabs(st, t);
        st.needTidy = st.needTidy || cmds.length > 0;
    } else if (job.kind === "toggle") {
        toggled = toggle(st, t);
    }
    if (job.id !== undefined && !st.held.some(h => h.id === job.id))
        delete st.unplaced[job.id];
    // Some changes (a mouse drop that ends where it started) send no event; every fetched tree
    // gets tidied for free. The commands above name windows only, so flattening first is safe.
    if (job.kind !== "tidy")
        cmds = tidy(st, t).concat(cmds);
    st.wsOf = t.wsMap;
    for (const c of cmds) {
        const m = /^\[con_id=(\d+).*?\] move container/.exec(c);
        if (m)
            st.ownMoves[m[1]] = true;
    }
    const needTidy = !!st.needTidy;
    st.needTidy = false;
    return { cmds: cmds, toggled: toggled, tidy: needTidy };
}
