.pragma library

// Pure decision logic for DwindleDaemon.qml. No Qt or I/O here, so the test harness runs the same code.
//
// Placement: a new tiled window splits the last focused tile, side by side when that tile's box is
// wider than tall, stacked otherwise, and goes right or below (Hyprland dwindle, force_split = 2).
// Re-flow (Hyprland preserve_split = false): once a window has left a workspace's tiling (close, move,
// float, scratchpad, a drag that empties a branch), every split there takes the shape of its box
// again. Splits with three or more children are rebuilt into a dwindle in reading order. Resizing
// alone turns nothing.

function newState() {
    return { mru: [], held: [], off: {}, wsOf: {}, ownMoves: {}, unplaced: {}, seq: 0, mem: {}, evenLater: {}, calm: false, needTidy: false, refocus: false };
}

// Splitting a window that went fullscreen after the tree was read hands its fullscreen to the new
// container, which later crashes Sway 1.12. Criteria cannot test fullscreen, so drop it first; in
// the normal case the window is not fullscreen and this does nothing.
const SPLIT = "fullscreen disable, split ";

function isWindow(n) {
    return (n.type === "con" || n.type === "floating_con") && !(n.nodes && n.nodes.length) && (n.pid > 0 || n.app_id || n.window);
}

function tiled(n) {
    return !!n && n.type === "con" && !n._floating && isWindow(n);
}

// A tiled window, or a whole container brought back to tiling (focus parent, scratchpad, float).
function tiledNode(n) {
    return tiled(n) || (!!n && n.type === "con" && !n._floating && !!(n.nodes && n.nodes.length));
}

function isSplit(n) {
    return n.layout === "splith" || n.layout === "splitv";
}

function isGroup(n) {
    return n.layout === "tabbed" || n.layout === "stacked";
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
    if (buf.lastIndexOf("i3-ipc", 0) !== 0)
        return undefined;
    let e = buf.length - 1;
    while (e > 0 && buf.charCodeAt(e) <= 32)
        e--;
    if (buf[e] !== "}" && buf[e] !== "]")
        return undefined;
    const m = /\u0000\u0000\u0000(?=[\[{])/.exec(buf.slice(6, 40));
    if (!m)
        return undefined;
    try {
        return parseTree(buf.slice(6 + m.index + 3));
    } catch (err) {
        return undefined;
    }
}

// Sway can print NaN for "percent" (a split with no size yet), which is not JSON.
function parseTree(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        if (!/NaN|Infinity/.test(text))
            throw e;
        return JSON.parse(text.replace(/:\s*-?(NaN|Infinity)\b/g, ": 0"));
    }
}

function index(tree) {
    const ids = {}, wsMap = {}, wss = [];
    let focused = null;
    const walk = (n, parent, ws, floating) => {
        n._parent = parent;
        n._ws = ws;
        n._floating = floating;
        ids[n.id] = n;
        if (n.focused)
            focused = n;
        if (n.type === "workspace") {
            ws = n;
            n._fs = false;
            wss.push(n);
        } else if (ws && isWindow(n)) {
            wsMap[n.id] = ws.name;
        }
        // Sway stops arranging a workspace's tiles while anything on it is fullscreen.
        if (ws && n.fullscreen_mode > 0 && n.type !== "workspace")
            ws._fs = true;
        const a = n.nodes, f = n.floating_nodes;
        if (a)
            for (let i = 0; i < a.length; i++)
                walk(a[i], n, ws, floating);
        if (f)
            for (let i = 0; i < f.length; i++)
                walk(f[i], n, ws, true);
    };
    walk(tree, null, null, false);
    return { root: tree, ids: ids, wsMap: wsMap, wss: wss, focused: focused };
}

// Criteria for a node that still has to be on the workspace it was read on. Commands on windows
// inside a container that was just sent to the scratchpad crash Sway 1.12, and a batch runs
// atomically, so this check is race free. Names that cannot be quoted safely go without it.
function sel(n, extra) {
    const name = n._ws ? n._ws.name : n.type === "workspace" ? n.name : "";
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

function dirOf(r) {
    return r.width > r.height ? "h" : "v";
}

function focusedWs(t) {
    const n = t.focused;
    return !n ? null : n.type === "workspace" ? n : n._ws;
}

// A window opened, moved or tiled since the last tree read, still waiting for its job.
function waiting(st, n) {
    return !!st.unplaced[n.id] || !(n.id in st.wsOf);
}

// The bottom of a chain of one-child containers (a tab group holding one window stays a group).
function survivor(n) {
    while (!isWindow(n) && n.nodes && n.nodes.length === 1 && (isSplit(n) || !isWindow(n.nodes[0])))
        n = n.nodes[0];
    return n;
}

// What is left of a chain of one-child containers once tidy has run (see flatten).
function remains(n) {
    const c = survivor(n);
    return isWindow(c) ? c : n;
}

// Removes the chain of one-child containers from top down to child's survivor. "split none" flattens
// every one-child ancestor of a window. A container at the bottom is not flattened that way (Sway 1.12
// has crashed later when a container replaced its parent); top takes its layout and its children
// instead, and Sway reaps the emptied chain. child: top's one remaining child.
function flatten(st, top, child, cmds, sizes) {
    const c = survivor(child);
    if (isWindow(c)) {
        cmds.push(`${sel(c)} split none`);
        return;
    }
    // A window still waiting inside is placed by its own job first (it may pair with a sibling);
    // a later look dissolves the container. Moved children get even shares at the end.
    const kids = c.nodes;
    if (kids.some(k => isWindow(k) && waiting(st, k))) {
        st.needTidy = true;
        return;
    }
    cmds.push(`${sel(child)} layout ${c.layout}`, `${sel(top)} mark --add _dw_f`);
    for (const k of kids)
        cmds.push(`${sel(k)} move container to mark _dw_f`);
    cmds.push("unmark _dw_f");
    // A moved window that had focus hands it to its old parent.
    st.refocus = true;
    if (kids.length === 2 && isSplit(c))
        sizes.push(even(remains(kids[0]), c.layout === "splith" ? "h" : "v"));
}

// One-child splits go, and so does a tab group around a single container (a second tab bar).
// Returns whether a branch was emptied (a wrapper around a window still waiting does not count).
function tidy(st, ws, cmds, sizes) {
    let emptied = false;
    const walk = n => {
        let c = n;
        const kids = n.nodes || [];
        if (n.type === "con" && kids.length === 1 && (isSplit(n) || !isWindow(kids[0]))) {
            c = survivor(n);
            // A wrapper around a window still waiting goes when its job moves the window; look
            // again afterwards in case it stays.
            if (isWindow(c) && waiting(st, c)) {
                st.needTidy = true;
                return;
            }
            emptied = true;
            flatten(st, n, kids[0], cmds, sizes);
        }
        // A container at the bottom of the chain has handed its children to n.
        const done = isGroup(c) && c.nodes.length > 1 ? unnest(isWindow(c) ? c : n, c.nodes, cmds) : [];
        for (const k of c.nodes || [])
            if (done.indexOf(k) < 0)
                walk(k);
    };
    const done = isGroup(ws) && ws.nodes.length > 1 ? unnest(ws, ws.nodes, cmds) : [];
    if (done.length)
        emptied = true;
    for (const k of ws.nodes || [])
        if (done.indexOf(k) < 0)
            walk(k);
    return emptied;
}

// A tab group moved into another one as a whole: its windows join the outer group (a mark on a
// container takes moved windows in at its end). A tabbed workspace cannot be marked, so there the
// inner group becomes a split.
function unnest(g, kids, cmds) {
    const done = [];
    for (const h of kids) {
        if (!isGroup(h) || !h.nodes.length)
            continue;
        const v = leaves(h);
        if (g.type === "workspace") {
            cmds.push(`${sel(h.nodes[0])} layout split${dirOf(h.rect)}`);
            continue;
        }
        done.push(h);
        cmds.push(`${sel(g)} mark --add _dw_g`);
        for (const w of v)
            cmds.push(`${sel(w, "tiling")} move container to mark _dw_g`);
        cmds.push("unmark _dw_g");
    }
    return done;
}

// A workspace's tiling as dwindle sees it: windows still waiting are left out, and one-child splits
// fold into their child as tidy removes them. n is the node that stays, top the parent's direct
// child whose size counts.
function vtree(st, n, top) {
    if (isWindow(n))
        return tiled(n) && !waiting(st, n) ? { n: n, top: top, kids: [] } : null;
    if (st.unplaced[n.id])
        return null;
    const kids = [];
    for (const c of n.nodes || []) {
        const k = vtree(st, c, c);
        if (k)
            kids.push(k);
    }
    if (!kids.length)
        return null;
    if (kids.length === 1 && isSplit(n)) {
        kids[0].top = top;
        return kids[0];
    }
    return { n: n, top: top, kids: kids };
}

function record(v, m) {
    if (!v.kids.length) {
        m.wins[v.n.id] = true;
        return;
    }
    m.cons[v.n.id] = true;
    for (const k of v.kids)
        record(k, m);
}

// Child boxes along a split: Sway's size ratios while the direction stays, even shares once it
// turns (the other axis has no sizes yet). Windows still waiting give their share back.
function childBoxes(v, box, d, keep) {
    const key = d === "h" ? "width" : "height";
    const size = k => k.rect[key] + (key === "height" && isWindow(k) && k.deco_rect ? k.deco_rect.height : 0);
    const kids = v.kids;
    let ok = keep && kids.every(k => size(k.top) > 0);
    if (ok) {
        const real = v.n.nodes || [];
        const all = real.reduce((s, k) => s + size(k), 0);
        ok = Math.abs(all - v.n.rect[key]) <= 10 * real.length + 10;
    }
    const total = kids.reduce((s, k) => s + size(k.top), 0);
    return kids.map(k => {
        const b = { width: box.width, height: box.height };
        b[key] = ok ? box[key] * size(k.top) / total : box[key] / kids.length;
        return b;
    });
}

function half(r, d) {
    return d === "h" ? { width: r.width / 2, height: r.height } : { width: r.width, height: r.height / 2 };
}

// Tidy and re-flow every workspace dwindle runs on. Returns the commands, the size commands that go
// last, and the box of every node as it will be once they have run. skip: the workspace a tabs job
// rebuilds itself.
function arrange(st, t, skip) {
    const out = { cmds: [], boxes: {}, sizes: [], later: {}, seen: {} }, cmds = out.cmds, mem = {};
    for (const ws of t.wss) {
        if (ws.name === "__i3_scratch" || st.off[ws.name])
            continue;
        const root = vtree(st, ws, ws);
        const old = st.mem[ws.name];
        const m = { wins: {}, cons: {}, split: !!root && root.n === ws, w: ws.rect.width, h: ws.rect.height };
        if (root)
            record(root, m);
        if (ws.name === skip) {
            mem[ws.name] = ws._fs && old ? old : m;
            continue;
        }
        // Nothing moves behind a fullscreen window (moving out of a fullscreen container has crashed
        // Sway 1.12); a job runs once it is gone.
        const emptied = !ws._fs && tidy(st, ws, cmds, out.sizes);
        // A window left the tiling here, a branch was emptied (tidy has a one-child split to remove),
        // the workspace's own split collapsed onto one of its containers, or the workspace changed shape.
        let removal = false;
        if (old) {
            // Smart gaps alone move the edges by a few pixels.
            const resized = Math.abs(old.w - m.w) > 32 || Math.abs(old.h - m.h) > 32;
            removal = emptied || resized || (old.split && !m.split && !!root && root.n.id in old.cons);
            for (const id in old.wins)
                if (!(id in m.wins))
                    removal = true;
        }
        // Sizes behind a fullscreen window say nothing; the change waits until it is gone.
        if (ws._fs) {
            if (old)
                Object.assign(m.wins, old.wins);
            mem[ws.name] = old ? Object.assign({}, old, { wins: m.wins }) : m;
            continue;
        }
        mem[ws.name] = m;
        if (root)
            flow(st, root, { width: ws.rect.width, height: ws.rect.height }, removal, out);
    }
    st.mem = mem;
    // A request that waits gets a look after this batch; one for a split not looked at this time
    // (behind a fullscreen window) waits on.
    for (const id in out.later)
        st.needTidy = true;
    for (const id in st.evenLater)
        if (!out.seen[id] && t.ids[id])
            out.later[id] = true;
    st.evenLater = out.later;
    return out;
}

// Sway sizes a turned split by old fractions of the other axis: even halves, set once the whole
// batch has moved its windows (a window still waiting may sit in the split until then).
function even(k, d) {
    return `${sel(k)} resize set ${d === "h" ? "width" : "height"} 50 ppt`;
}

function flow(st, v, box, removal, out) {
    out.boxes[v.n.id] = box;
    const kids = v.kids;
    if (!kids.length)
        return;
    if (!isSplit(v.n)) {
        for (const k of kids)
            flow(st, k, box, removal, out);
        return;
    }
    const lay = v.n.layout === "splith" ? "h" : "v";
    // A box within a few pixels of square keeps its direction, so rounding cannot flip it.
    const s = Math.abs(box.width - box.height) < 8 ? lay : dirOf(box);
    // "layout" acts on the parent of the node it names.
    const first = remains(kids[0].top);
    // Even halves only once the split holds just its two children: a window still waiting inside
    // takes its share along when it leaves, so the request waits for a later tree.
    const evenOut = d => {
        if (v.n.nodes.length === 2)
            out.sizes.push(even(first, d));
        else
            out.later[v.n.id] = true;
    };
    out.seen[v.n.id] = true;
    if (kids.length === 2) {
        const turn = removal && lay !== s;
        if (turn)
            out.cmds.push(`${sel(first)} layout split${s}`);
        if (turn || st.evenLater[v.n.id])
            evenOut(turn ? s : lay);
        const b = childBoxes(v, box, turn ? s : lay, !turn);
        flow(st, kids[0], b[0], removal, out);
        flow(st, kids[1], b[1], removal, out);
        return;
    }
    // Three or more children (a mouse drop, a keyboard move): a dwindle in reading order, each child
    // splitting off the rest of the box.
    if (lay !== s)
        out.cmds.push(`${sel(first)} layout split${s}`);
    if (v.n.nodes.length === kids.length)
        out.sizes.push(even(first, s));
    else
        out.later[v.n.id] = true;
    let r = box, d = s;
    flow(st, kids[0], half(r, d), removal, out);
    for (let i = 1; i < kids.length - 1; i++) {
        r = half(r, d);
        d = dirOf(r);
        const k = remains(kids[i].top), next = remains(kids[i + 1].top);
        if (isWindow(k)) {
            out.cmds.push(`${sel(k, "tiling")} mark --add _dw_r, ${SPLIT}${d}`);
        } else {
            // A mark on a container takes moved windows inside it, so mark the new wrapper instead.
            out.cmds.push(`${sel(k)} ${SPLIT}${d}, focus`, "focus parent", "mark --add _dw_r");
            st.refocus = true;
        }
        out.cmds.push(`${sel(next)} move container to mark _dw_r`);
        out.sizes.push(even(k, d));
        flow(st, kids[i], half(r, d), removal, out);
    }
    out.cmds.push("unmark _dw_r");
    flow(st, kids[kids.length - 1], half(r, d), removal, out);
}

// The tile right before n in its container: where Sway inserted a window moved to a workspace
// (after its last focused tile there; the IPC focus lists do not always agree with that).
function prevTile(st, n) {
    const kids = n._parent ? n._parent.nodes || [] : [];
    const k = kids[kids.indexOf(n) - 1];
    return k && tiled(k) && !waiting(st, k) ? k : null;
}

// moved: the window came from another workspace or output. It splits the tile it was put after.
function place(st, t, id, snap, moved, seq, boxes, held) {
    const n = t.ids[id];
    if (!tiledNode(n) || !n._ws || n._ws.name === "__i3_scratch" || st.off[n._ws.name])
        return [];
    // Wait while anything on the workspace is fullscreen, this window included. Held windows stay
    // in the order they arrived, however often they are released and held again.
    if (n._ws._fs) {
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
    if (!x || isGroup(x))
        return [];
    // The partner is the most recently focused tile here that is already in place.
    let p = moved ? prevTile(st, n) : null;
    for (const s of moved ? [] : snap) {
        const c = t.ids[s];
        if (s !== id && c && c._ws === n._ws && tiled(c) && !waiting(st, c)) {
            p = c;
            break;
        }
    }
    // None focused yet (windows opened behind a fullscreen one): the tile Sway put it after, or the
    // last one in reading order.
    if (!p && !moved)
        p = prevTile(st, n) || leaves(n._ws).filter(k => k !== n && !waiting(st, k)).pop() || null;
    const box = p && boxes[p.id];
    if (!box)
        return [];
    const kids = x.nodes;
    const pair = kids.length === 2 && kids.indexOf(p) >= 0;
    // A window that lands beside a tab group joins it.
    const grouped = isGroup(p._parent);
    const d = dirOf(box);
    if (!grouped && pair) {
        // Already a pair: put the new window second and set the direction.
        const cmds = kids[0] === p ? [] : [`${sel(p, "tiling")} mark --add _dw_p`, `${sel(n, "tiling")} move container to mark _dw_p`, "unmark _dw_p"];
        return x.layout === "split" + d ? cmds : cmds.concat([`${sel(n, "tiling")} layout split${d}`]);
    }
    const cmds = [`${sel(p, "tiling")} mark --add _dw_p${grouped ? "" : ", " + SPLIT + d}`];
    cmds.push(`${sel(n, "tiling")} move container to mark _dw_p${n.focused ? ", focus" : ""}`, "unmark _dw_p");
    // The container the window came from keeps one child: a window goes now, a container waits for
    // a fresh tree (this batch has just changed what is inside it).
    // Its container empties and goes, which can leave the one above with a single child.
    if (x !== p._parent && x.type !== "workspace" && kids.length === 1)
        st.needTidy = true;
    if (x !== p._parent && x.type !== "workspace" && kids.length === 2) {
        const c = survivor(kids[0] === n ? kids[1] : kids[0]);
        if (isWindow(c))
            cmds.push(`${sel(c)} split none`);
        else
            st.needTidy = true;
    }
    // A window opened behind a fullscreen one landed in another split, which made room for it; the
    // two left share it evenly again. (Not for new windows: more may arrive there before this runs.)
    if (held && x !== p._parent && isSplit(x) && kids.length === 3) {
        const rest = kids.filter(k => k !== n);
        cmds.push(even(remains(rest[0]), x.layout === "splith" ? "h" : "v"));
    }
    return cmds;
}

// Tabs on: every tile of the focused workspace goes into one tab group. Tabs off: the group becomes
// a fresh dwindle in tab order.
function tabs(st, t) {
    const ws = focusedWs(t);
    if (!ws || ws.name === "__i3_scratch")
        return [];
    const v = leaves(ws);
    if (!v.length || ws._fs)
        return [];
    // Keep the focused window, or the last focused tile when a floating window has focus.
    const focus = t.focused;
    const f = v.find(w => w.focused) || st.mru.map(i => t.ids[i]).find(w => w && v.indexOf(w) >= 0) || v[0];
    const refocus = [`${sel(f, "tiling")} focus`];
    if (focus && focus !== f && focus._floating && isWindow(focus))
        refocus.push(`${sel(focus)} focus`);
    const x = v[0]._parent;
    const w = k => sel(v[k], "tiling");
    const cmds = [];
    // A workspace's own layout is set through focus; "layout" on a top-level window wraps them all.
    const wsLayout = l => [`${w(0)} focus`, "focus parent", `layout ${l}`];
    // The workspace's child that holds the windows. Every window moves straight into it (a mark on a
    // container takes them in at its end), so the containers in between are emptied and reaped.
    let top = x;
    while (top.type !== "workspace" && top._parent.type !== "workspace")
        top = top._parent;
    const gather = () => [`${sel(top)} mark --add _dw_t`].concat(v.map((k, i) => `${w(i)} move container to mark _dw_t`), ["unmark _dw_t"]);
    if (!(isGroup(x) && v.every(k => k._parent === x))) {
        if (top.type === "workspace") {
            cmds.push(`${w(0)} mark --add _dw_t`);
            for (let i = 1; i < v.length; i++)
                cmds.push(`${w(i)} move container to mark _dw_t`, `${w(i)} mark --add _dw_t`);
            cmds.push("unmark _dw_t");
        } else {
            cmds.push(...gather());
            // One tab bar: not a tabbed workspace above the group.
            if (isGroup(ws))
                cmds.push(`${sel(top)} focus`, "focus parent", `layout split${dirOf(ws.rect)}`);
        }
        cmds.push(`${w(0)} layout tabbed`);
        return cmds.concat(refocus);
    }
    let r = { width: ws.rect.width, height: ws.rect.height };
    let d = dirOf(r);
    if (top !== x && top.type !== "workspace")
        cmds.push(...gather());
    if (v.length === 1)
        return cmds.concat(x.type === "workspace" ? wsLayout("split" + d) : [`${w(0)} split none`], refocus);
    cmds.push(...(x.type === "workspace" ? wsLayout("split" + d) : [`${w(0)} layout split${d}`]));
    // Even halves at every level (the group's sizes are old ones from before it was tabbed).
    const sizes = [`${w(0)} resize set ${d === "h" ? "width" : "height"} 50 ppt`];
    for (let i = 1; i < v.length - 1; i++) {
        r = half(r, d);
        d = dirOf(r);
        cmds.push(`${w(i)} mark --add _dw_t, ${SPLIT}${d}`, `${w(i + 1)} move container to mark _dw_t`);
        sizes.push(`${w(i)} resize set ${d === "h" ? "width" : "height"} 50 ppt`);
    }
    return cmds.concat(["unmark _dw_t"], sizes, refocus);
}

// A floating window back from the scratchpad, floated or moved: a frame larger than the window's own
// size (a fixed-size client does not follow a bigger frame) or than 90% of the output shrinks to fit,
// and a frame that was shrunk or reaches off the output is centred. Nothing grows.
function fit(st, t, ids) {
    const cmds = [], seen = {};
    for (const id of ids) {
        // A window inside a floating container moves with it.
        let n = t.ids[id];
        while (n && n._parent && n._parent.type !== "workspace")
            n = n._parent;
        const o = n && n._ws && n._ws._parent ? n._ws._parent.rect : null;
        if (!o || n.type !== "floating_con" || seen[n.id] || n._ws.name === "__i3_scratch" || n.fullscreen_mode > 0)
            continue;
        seen[n.id] = true;
        const r = n.rect, c = isWindow(n) && n.window_rect ? n.window_rect : r, g = isWindow(n) ? n.geometry : null;
        // Title bar and borders; "resize set" on a floating window sets the outer size.
        const dx = r.width - c.width, dy = r.height - c.height;
        // Terminals leave a few pixels of a character cell unused; that is not a fixed size.
        let w = c.width, h = c.height;
        if (g && g.width > 0 && g.width < w - 32)
            w = g.width;
        if (g && g.height > 0 && g.height < h - 32)
            h = g.height;
        w = Math.min(w + dx, Math.floor(o.width * 0.9));
        h = Math.min(h + dy, Math.floor(o.height * 0.9));
        const off = r.x < o.x || r.y < o.y || r.x + r.width > o.x + o.width || r.y + r.height > o.y + o.height;
        if (w < r.width - 2 || h < r.height - 2)
            cmds.push(`${sel(n, "floating")} resize set width ${w} px height ${h} px, move position center`);
        else if (off)
            cmds.push(`${sel(n, "floating")} move position center`);
    }
    return cmds;
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

// Focus or swap with the next/previous tiled window of the workspace, in reading order.
function cycle(st, t, step, swap) {
    const ws = focusedWs(t);
    if (!ws || ws.name === "__i3_scratch")
        return [];
    const v = leaves(ws);
    if (v.length < 2)
        return [];
    const f = v.find(w => w.focused) || st.mru.map(i => t.ids[i]).find(w => w && v.indexOf(w) >= 0) || v[0];
    const target = v[(v.indexOf(f) + step + v.length) % v.length];
    if (!swap)
        return [`${sel(target, "tiling")} focus`];
    if (ws._fs)
        return [];
    return [`${sel(f, "tiling")} swap container with con_id ${target.id}, focus`];
}

// Own commands ("nop dwindle ..."), or "tidy" for other bindings that change the layout without a
// window event (layout, split, resize), so the change is looked at right away.
function bindingAction(command) {
    const c = command || "";
    const m = /(?:^|[,;]\s*)nop\s+dwindle\s+(tabs|toggle|(?:focus|swap)\s+(?:next|prev))\b/.exec(c);
    if (m)
        return m[1].replace(/\s+/, "-");
    return /\b(layout|split|swap|resize)\b/.test(c) ? "tidy" : "";
}

// Takes the next job off the queue. Every job tidies the tree it reads, so queued tidy jobs go too.
function nextJob(queue) {
    return { job: queue[0], rest: queue.slice(1).filter(j => j.kind !== "tidy") };
}

// Raw window event -> jobs. Focus, title and mark events are the most frequent; they are read
// without parsing the JSON (Sway writes "change" first and the container's "id" first).
function onWindowData(st, data) {
    const m = /^\s*\{\s*"change":\s*"(\w+)",\s*"container":\s*\{\s*"id":\s*(\d+)/.exec(data);
    if (m && m[1] === "focus")
        return onWindowEvent(st, "focus", { id: +m[2] });
    if (m && (m[1] === "title" || m[1] === "mark" || m[1] === "urgent"))
        return { jobs: [] };
    let e;
    try {
        e = parseTree(data);
    } catch (err) {
        return { jobs: [] };
    }
    return onWindowEvent(st, e.change, e.container);
}

// The closed window was the last tile of its workspace, or one of two held by the workspace itself.
function lastTwo(st, id) {
    const m = st.mem[st.wsOf[id]];
    // The memory is the tree as read, before the last job's commands.
    if (!m || !m.wins[id] || !st.calm)
        return false;
    for (const k in st.unplaced)
        if (st.wsOf[k] === st.wsOf[id] || !(k in st.wsOf))
            return false;
    const n = Object.keys(m.wins).length;
    return n === 1 || (n === 2 && m.split && Object.keys(m.cons).length === 1);
}

// Window event -> { jobs, fit }. A window that maps floating needs no job. The type in move events is
// not reliable (a tiled window moved to another output is reported as floating_con). fit: windows to
// check with a "fit" job once their clients had time to take the new size (see fit()).
function onWindowEvent(st, change, c) {
    const out = { jobs: [], fit: [] };
    c = c || {};
    switch (change) {
    case "focus":
        if (st.mru[0] !== c.id)
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
        } else {
            out.jobs.push({ kind: "tidy" });
            out.fit.push(c.id);
        }
        break;
    case "move":
        if (st.ownMoves[c.id]) {
            delete st.ownMoves[c.id];
            break;
        }
        // Back from the scratchpad, or moved to another output.
        out.fit.push(c.id);
        // Jobs that run before this one refresh wsOf, so remember where the window was.
        st.unplaced[c.id] = st.unplaced[c.id] || "move";
        out.jobs.push({ kind: "moved", id: c.id, from: st.wsOf[c.id] });
        break;
    case "close":
        st.mru = st.mru.filter(i => i !== c.id);
        delete st.unplaced[c.id];
        // A floating window, a disabled workspace, or one tile left: nothing to re-flow.
        if (c.type !== "floating_con" && !st.off[st.wsOf[c.id]] && !lastTwo(st, c.id))
            out.jobs.push({ kind: "tidy" });
        break;
    case "fullscreen_mode":
        // Nothing is arranged behind a fullscreen window; catch up once it is gone. A floating window
        // gets its old frame back, which may no longer fit.
        if (c.fullscreen_mode === 0) {
            out.jobs.push({ kind: "tidy" });
            out.fit.push(c.id);
        }
        break;
    }
    // Held windows wait for their workspace to lose its fullscreen window, which also happens
    // when that window closes, floats or moves away. place() holds them again if needed.
    // They go first so that their order survives repeated holds.
    if (st.held.length && (change === "close" || change === "floating" || change === "move" || (change === "fullscreen_mode" && c.fullscreen_mode === 0))) {
        out.jobs = st.held.map(j => ({ kind: "place", id: j.id, snap: j.snap, seq: j.seq, held: true })).concat(out.jobs);
        st.held = [];
    }
    return out;
}

// Runs one queued job against a freshly indexed tree. Returns { cmds, toggled, tidy }.
function runJob(st, job, t) {
    let cmds = [];
    let toggled = "";
    // Move events of the previous job have arrived by now; a stale entry would hide a user move.
    st.ownMoves = {};
    st.refocus = false;
    // A window with a placement still queued (floating toggle sends move, then floating) waits for it.
    // A move within the workspace (a mouse drop, a keyboard move) puts the window where the user wanted.
    // So does a window dropped in front of a tile elsewhere: the rebuild in reading order takes it in.
    const placing = job.kind === "moved" && st.unplaced[job.id] === true;
    const mn = t.ids[job.id];
    if (job.kind === "moved" && !placing && (t.wsMap[job.id] === job.from || (tiled(mn) && !prevTile(st, mn))))
        delete st.unplaced[job.id];
    if (job.kind === "toggle")
        toggled = toggle(st, t);
    const ws = job.kind === "tabs" ? focusedWs(t) : null;
    const pre = arrange(st, t, ws && !st.off[ws.name] ? ws.name : "");
    if (job.kind === "place") {
        cmds = place(st, t, job.id, job.snap, false, job.seq, pre.boxes, !!job.held);
        // A whole container back in the tiling: its own splits get a look once it is in place.
        if (t.ids[job.id] && !isWindow(t.ids[job.id]))
            st.needTidy = true;
    } else if (job.kind === "moved" && !placing) {
        const now = t.wsMap[job.id];
        if (job.from !== undefined && now !== undefined && job.from !== now)
            cmds = place(st, t, job.id, st.mru.filter(i => i !== job.id), true, ++st.seq, pre.boxes);
    } else if (job.kind === "tabs") {
        cmds = tabs(st, t);
    } else if (job.kind === "fit") {
        cmds = fit(st, t, job.ids);
    } else if (/^(focus|swap)-(next|prev)$/.test(job.kind)) {
        const [verb, dir] = job.kind.split("-");
        cmds = cycle(st, t, dir === "next" ? 1 : -1, verb === "swap");
    }
    if (job.id !== undefined && !placing && !st.held.some(h => h.id === job.id)) {
        delete st.unplaced[job.id];
        // Placed now: its leaving later is a removal, even before the next tree read records it.
        const n = t.ids[job.id], m = n && n._ws && st.mem[n._ws.name];
        if (m && tiled(n))
            m.wins[job.id] = true;
    }
    // Tidy first: the commands above name windows and the nodes tidy leaves in place. A rebuild that
    // moved focus gives it back before the job's own commands (which may focus something else).
    // A focused container may be one this batch dissolves; then the last focused window gets it.
    let to = t.focused && (t.focused.type === "workspace" || isWindow(t.focused)) ? t.focused : null;
    if (!to && t.focused)
        to = st.mru.map(i => t.ids[i]).find(n => n && isWindow(n) && n._ws === t.focused._ws) || t.focused._ws;
    const back = !st.refocus || !to ? [] : [to.type === "workspace" ? `workspace --no-auto-back-and-forth "${to.name.replace(/["\\]/g, "\\$&")}"` : `[con_id=${to.id}] focus`];
    cmds = pre.cmds.concat(back, cmds, pre.sizes);
    st.wsOf = t.wsMap;
    st.calm = !cmds.length;
    for (const c of cmds) {
        const m = /^\[con_id=(\d+).*?\] move container/.exec(c);
        if (m)
            st.ownMoves[m[1]] = true;
    }
    const needTidy = !!st.needTidy;
    st.needTidy = false;
    return { cmds: cmds, toggled: toggled, tidy: needTidy, jobs: release(st, t) };
}

// A fullscreen container (not a window) ends without an event: release windows held for it once
// a tree shows their workspace free.
function release(st, t) {
    const free = st.held.some(h => {
        const n = t.ids[h.id];
        return !n || !n._ws || !n._ws._fs;
    });
    if (!free)
        return [];
    const jobs = st.held.map(h => ({ kind: "place", id: h.id, snap: h.snap, seq: h.seq, held: true }));
    st.held = [];
    return jobs;
}
