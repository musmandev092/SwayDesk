import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.I3
import Quickshell.Wayland
import Quickshell.Widgets

// Sway only. Keys arrive as Sway binding events (`nop switcher ...`), the window list comes from
// `swaymsg -t get_tree`, previews from `grim -T <foreign toplevel id>`. The overlay takes the keyboard
// while it is open, so it sees Alt being released.
Scope {
    id: root

    property real cornerRadius: 12
    property color scrim: "#8c0c0c10"
    property color panelColor: "#f01e1e24"
    property color cardColor: "#2b2b32"
    property color cardHover: "#363640"
    property color cardSelected: "#3d4c73"
    property color accent: "#89b4fa"
    property color textColor: "#e8e8ee"
    property color dimColor: "#a0a0ac"
    property color outline: "#40ffffff"
    property string fontFamily: ""
    readonly property real radius: Math.max(cornerRadius, 8)

    property string kind: ""
    property bool active: false
    property bool revealed: false
    property bool ready: false
    property bool altHeld: false
    property bool pendingCommit: false
    property bool pointerMoved: false
    property int startDir: 1
    property var items: []
    property string filter: ""
    property int sel: 0
    property int cols: 1
    property var mru: []
    property string outputName: ""
    property int stamp: 0
    property var shots: ({})
    readonly property string cacheDir: (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/sway-switcher"

    readonly property var view: {
        const words = filter.toLowerCase().split(/\s+/).filter(w => w.length);
        if (!words.length)
            return items;
        return items.filter(it => {
            const t = (it.title + " " + it.appId + " " + it.wsLabel).toLowerCase();
            return words.every(w => t.indexOf(w) >= 0);
        });
    }
    // Repeater delegates get copies of the item objects, so cards find their place by window id.
    readonly property var viewIndex: {
        const m = {};
        view.forEach((it, i) => m[it.id] = i);
        return m;
    }
    readonly property var groups: {
        const out = [];
        for (const it of view) {
            let g = out.length ? out[out.length - 1] : null;
            if (!g || g.key !== it.wsKey) {
                g = { key: it.wsKey, label: it.wsLabel, current: it.wsCurrent, items: [] };
                out.push(g);
            }
            g.items.push(it);
        }
        return out;
    }
    readonly property int widest: {
        if (kind !== "overview")
            return items.length;
        const n = {};
        let m = 1;
        for (const it of items) {
            n[it.wsKey] = (n[it.wsKey] || 0) + 1;
            m = Math.max(m, n[it.wsKey]);
        }
        return m;
    }

    onFilterChanged: sel = 0

    function iconFor(appId) {
        let e = null;
        try {
            e = DesktopEntries.heuristicLookup(appId);
        } catch (err) {
            e = DesktopEntries.byId(appId);
        }
        return Quickshell.iconPath(e && e.icon ? e.icon : appId, "application-x-executable");
    }

    function open(k, dir, held) {
        if (k === "keys") {
            close();
            openKeys();
            return;
        }
        if (k !== "windows" && k !== "overview")
            return;
        if (active && kind === k) {
            move(dir === "prev" ? -1 : 1);
            return;
        }
        close();
        kind = k;
        altHeld = !!held && k === "windows";
        startDir = dir === "prev" ? -1 : 1;
        filter = "";
        items = [];
        sel = 0;
        shots = ({});
        ready = false;
        pendingCommit = false;
        pointerMoved = false;
        outputName = I3.focusedMonitor ? I3.focusedMonitor.name : outputName;
        active = true;
        revealTimer.interval = k === "windows" ? 110 : 0;
        revealTimer.restart();
        treeProc.running = true;
    }

    function close() {
        active = false;
        revealed = false;
        altHeld = false;
        pendingCommit = false;
        keysShown = false;
        revealTimer.stop();
    }

    function reveal() {
        if (active && ready && !pendingCommit)
            revealed = true;
    }

    function commit() {
        if (!active)
            return;
        if (!ready) {
            pendingCommit = true;
            return;
        }
        const it = view[sel];
        close();
        if (it)
            I3.dispatch(it.scratch ? "[con_id=" + it.id + "] scratchpad show" : "[con_id=" + it.id + "] focus");
    }

    function killItem(it) {
        if (it)
            I3.dispatch("[con_id=" + it.id + "] kill");
    }

    function move(d) {
        const n = view.length;
        if (n)
            sel = ((sel + d) % n + n) % n;
    }

    function moveVertical(d) {
        const n = view.length;
        if (!n)
            return;
        if (kind !== "overview") {
            const t = sel + d * cols;
            if (t >= 0 && t < n)
                sel = t;
            return;
        }
        const gs = groups;
        let gi = 0, base = 0;
        for (; gi < gs.length - 1; gi++) {
            if (sel < base + gs[gi].items.length)
                break;
            base += gs[gi].items.length;
        }
        const len = gs[gi].items.length, idx = sel - base, col = idx % cols, row = Math.floor(idx / cols);
        if (d > 0 && (row + 1) * cols < len) {
            sel = base + Math.min(idx + cols, len - 1);
            return;
        }
        if (d < 0 && row > 0) {
            sel = base + idx - cols;
            return;
        }
        const tg = gi + d;
        if (tg < 0 || tg >= gs.length)
            return;
        const tlen = gs[tg].items.length;
        const tbase = d > 0 ? base + len : base - tlen;
        const trow = d > 0 ? 0 : Math.ceil(tlen / cols) - 1;
        sel = tbase + Math.min(trow * cols + col, tlen - 1);
    }

    function build(json) {
        const tree = JSON.parse(json);
        let focusedWs = "";
        const all = [];
        const visit = (node, ws) => {
            for (const c of (node.nodes || []).concat(node.floating_nodes || [])) {
                const w = c.type === "workspace" ? c : ws;
                if (c.focused && w)
                    focusedWs = w.name;
                if (c.foreign_toplevel_identifier && w) {
                    const scratch = w.name === "__i3_scratch";
                    all.push({
                        id: c.id,
                        ident: c.foreign_toplevel_identifier,
                        appId: c.app_id || (c.window_properties ? c.window_properties.class || "" : ""),
                        title: c.name || "",
                        wsKey: w.name,
                        wsNum: scratch ? 1e6 : (w.num >= 0 ? w.num : 1e5),
                        wsLabel: scratch ? "Scratchpad" : "Workspace " + w.name,
                        wsCurrent: false,
                        scratch: scratch,
                        focused: !!c.focused,
                        order: all.length
                    });
                }
                visit(c, w);
            }
        };
        visit(tree, null);
        if (!focusedWs && I3.focusedWorkspace)
            focusedWs = I3.focusedWorkspace.name;
        for (const it of all)
            it.wsCurrent = it.wsKey === focusedWs;
        let list;
        if (kind === "windows") {
            const rank = it => it.focused ? -1 : (mru.indexOf(it.id) >= 0 ? mru.indexOf(it.id) : 1e4 + it.order);
            list = all.filter(it => it.wsCurrent).sort((a, b) => rank(a) - rank(b));
            sel = list.length > 1 ? (startDir > 0 ? 1 : list.length - 1) : 0;
        } else {
            list = all.sort((a, b) => a.wsNum - b.wsNum || (a.wsKey < b.wsKey ? -1 : a.wsKey > b.wsKey ? 1 : a.order - b.order));
            const f = list.findIndex(it => it.focused);
            sel = f < 0 ? 0 : f;
        }
        items = list;
    }

    function capture() {
        stamp++;
        if (capProc.running)
            capProc.running = false;
        capProc.command = ["sh", "-c",
            'd=$1; s=$2; shift 2; mkdir -p "$d"; for id; do ( rm -f "$d/$id-"*.png; grim -l 1 -T "$id" "$d/$id-$s.png" 2>/dev/null && echo "$s $id" ) & done; wait',
            "sh", cacheDir, String(stamp)].concat(items.map(i => i.ident));
        capProc.running = true;
    }

    function keyPressed(e) {
        if (altHeld && !(e.modifiers & Qt.AltModifier) && e.key !== Qt.Key_Alt) {
            commit();
            e.accepted = true;
            return;
        }
        switch (e.key) {
        case Qt.Key_Escape:
            if (filter)
                filter = "";
            else
                close();
            break;
        case Qt.Key_Return:
        case Qt.Key_Enter:
            commit();
            break;
        case Qt.Key_Tab:
        case Qt.Key_Right:
            move(1);
            break;
        case Qt.Key_Backtab:
        case Qt.Key_Left:
            move(-1);
            break;
        case Qt.Key_Down:
            moveVertical(1);
            break;
        case Qt.Key_Up:
            moveVertical(-1);
            break;
        case Qt.Key_Home:
            sel = 0;
            break;
        case Qt.Key_End:
            sel = Math.max(0, view.length - 1);
            break;
        case Qt.Key_Delete:
            killItem(view[sel]);
            break;
        case Qt.Key_Backspace:
            filter = filter.slice(0, -1);
            break;
        default:
            if (kind === "overview" && e.text.length === 1 && e.text >= " "
                    && !(e.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier))) {
                filter += e.text;
                break;
            }
            return;
        }
        e.accepted = true;
    }

    function keyReleased(e) {
        if (altHeld && (e.key === Qt.Key_Alt || !(e.modifiers & Qt.AltModifier))) {
            commit();
            e.accepted = true;
        }
    }

    function swayEvent(type, data) {
        let ev;
        try {
            ev = JSON.parse(data);
        } catch (err) {
            return;
        }
        if (type === "binding") {
            const b = ev.binding || {};
            const m = /(?:^|[,;]\s*)nop\s+switcher\s+(\w+)(?:\s+(\w+))?(?:\s+(\w+))?/.exec(b.command || "");
            if (!m)
                return;
            const alt = (b.event_state_mask || []).indexOf("Mod1") >= 0;
            switch (m[1]) {
            case "open":
                open(m[2] || "windows", m[3] || "", alt);
                break;
            case "next":
                move(1);
                break;
            case "prev":
                move(-1);
                break;
            case "commit":
                commit();
                break;
            case "cancel":
                close();
                break;
            }
        } else if (type === "window" && ev.container) {
            const id = ev.container.id;
            if (ev.change === "focus") {
                mru = [id].concat(mru.filter(x => x !== id)).slice(0, 200);
            } else if (ev.change === "close") {
                mru = mru.filter(x => x !== id);
                if (active && items.some(x => x.id === id)) {
                    const cur = view[sel];
                    items = items.filter(x => x.id !== id);
                    if (!items.length) {
                        close();
                        return;
                    }
                    const ni = view.indexOf(cur);
                    sel = ni >= 0 ? ni : Math.min(sel, view.length - 1);
                }
            }
        }
    }

    Timer {
        id: revealTimer
        repeat: false
        onTriggered: root.reveal()
    }

    Process {
        id: treeProc
        command: ["swaymsg", "-t", "get_tree", "-r"]
        stdout: StdioCollector {
            onStreamFinished: {
                if (!root.active)
                    return;
                try {
                    root.build(text);
                } catch (err) {
                    console.warn("switcher: " + err);
                    root.close();
                    return;
                }
                if (!root.items.length) {
                    root.close();
                    return;
                }
                root.ready = true;
                if (root.pendingCommit) {
                    root.pendingCommit = false;
                    root.commit();
                    return;
                }
                root.capture();
                if (!revealTimer.running)
                    root.reveal();
            }
        }
    }

    Process {
        id: capProc
        stdout: SplitParser {
            onRead: line => {
                const p = line.split(" ");
                if (p.length !== 2)
                    return;
                const s = Object.assign({}, root.shots);
                s[p[1]] = "file://" + root.cacheDir + "/" + p[1] + "-" + p[0] + ".png";
                root.shots = s;
            }
        }
    }

    I3IpcListener {
        subscriptions: ["window", "binding"]
        onIpcEvent: event => root.swayEvent(event.type, event.data)
    }

    IpcHandler {
        target: "switcher"
        function open(kind: string): string { root.open(kind, "", false); return "ok"; }
        function next(): string { root.move(1); return "ok"; }
        function prev(): string { root.move(-1); return "ok"; }
        function up(): string { root.moveVertical(-1); return "ok"; }
        function down(): string { root.moveVertical(1); return "ok"; }
        function commit(): string { root.commit(); return "ok"; }
        function cancel(): string { root.close(); return "ok"; }
        function status(): string { return root.active ? root.kind + " " + root.view.length + " sel " + root.sel + (root.revealed ? " shown" : " hidden") : (root.keysShown ? "keys" : "closed"); }
        function scroll(dir: string): string { root.scrollKeys(dir); return "ok"; }
        function keysFilter(text: string): string { root.keyFilter = text; root.keySel = 0; return "ok"; }
        function keysRun(): string { root.runKey(root.filteredRows[root.keySel]); return "ok"; }
    }

    PanelWindow {
        id: win
        visible: root.active
        screen: Quickshell.screens.find(s => s.name === root.outputName) || Quickshell.screens[0]
        anchors { left: true; right: true; top: true; bottom: true }
        color: "transparent"
        exclusionMode: ExclusionMode.Ignore
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: root.active ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
        WlrLayershell.namespace: "dms:switcher"

        readonly property bool ov: root.kind === "overview"
        readonly property int gap: 12
        readonly property int pad: 20
        readonly property int headerH: 36
        readonly property int cardW: Math.round(Math.max(190, Math.min(ov ? 260 : 300, width * (ov ? 0.13 : 0.15))))
        readonly property int cardH: Math.round(cardW * 0.6) + headerH + 8
        readonly property int fitCols: Math.max(1, Math.floor((width * 0.9 - 2 * pad + gap) / (cardW + gap)))
        readonly property int colsUsed: Math.max(1, Math.min(fitCols, root.widest))
        readonly property int flowW: colsUsed * (cardW + gap) - gap

        onColsUsedChanged: root.cols = colsUsed
        Component.onCompleted: root.cols = colsUsed
        onVisibleChanged: if (visible) catcher.forceActiveFocus()

        function ensureVisible(item) {
            if (!item || !flick)
                return;
            const p = item.mapToItem(flick.contentItem, 0, 0);
            if (p.y < flick.contentY)
                flick.contentY = Math.max(0, p.y - 8);
            else if (p.y + item.height > flick.contentY + flick.height)
                flick.contentY = p.y + item.height - flick.height + 8;
        }

        Item {
            id: catcher
            anchors.fill: parent
            focus: true
            Keys.onPressed: e => root.keyPressed(e)
            Keys.onReleased: e => root.keyReleased(e)

            Rectangle {
                anchors.fill: parent
                color: root.scrim
                opacity: root.revealed ? (win.ov ? 1 : 0.55) : 0
                Behavior on opacity { NumberAnimation { duration: 100 } }
                MouseArea {
                    anchors.fill: parent
                    onClicked: root.close()
                    onWheel: w => root.move(w.angleDelta.y > 0 ? -1 : 1)
                }
            }

            Rectangle {
                id: panel
                anchors.centerIn: parent
                width: win.flowW + 2 * win.pad
                height: Math.min(parent.height * 0.88, body.implicitHeight + 2 * win.pad)
                radius: root.radius + 6
                color: root.panelColor
                border.width: 1
                border.color: root.outline
                opacity: root.revealed ? 1 : 0
                scale: root.revealed ? 1 : 0.97
                Behavior on opacity { NumberAnimation { duration: 100 } }
                Behavior on scale { NumberAnimation { duration: 120; easing.type: Easing.OutCubic } }

                MouseArea {
                    anchors.fill: parent
                    onWheel: w => root.move(w.angleDelta.y > 0 ? -1 : 1)
                }

                Column {
                    id: body
                    x: win.pad
                    y: win.pad
                    width: win.flowW
                    spacing: 12

                    Rectangle {
                        visible: win.ov
                        width: parent.width
                        height: 38
                        radius: root.radius
                        color: Qt.rgba(0, 0, 0, 0.2)
                        border.width: 1
                        border.color: root.filter ? root.accent : root.outline
                        Text {
                            anchors { left: parent.left; leftMargin: 14; right: parent.right; rightMargin: 14; verticalCenter: parent.verticalCenter }
                            text: root.filter ? root.filter + "▏" : "Type to search windows"
                            color: root.filter ? root.textColor : root.dimColor
                            font.family: root.fontFamily
                            font.pixelSize: 15
                            elide: Text.ElideLeft
                        }
                    }

                    Flickable {
                        id: flick
                        width: parent.width
                        height: Math.min(contentHeight, panel.parent.height * 0.88 - 2 * win.pad - (win.ov ? 38 + 12 : 0) - 30)
                        contentWidth: width
                        contentHeight: cards.implicitHeight
                        clip: true
                        boundsBehavior: Flickable.StopAtBounds
                        interactive: contentHeight > height

                        Column {
                            id: cards
                            width: flick.width
                            spacing: 18

                            Repeater {
                                model: win.ov ? root.groups : [{ key: "", label: "", current: true, items: root.view }]
                                delegate: Column {
                                    id: group
                                    required property var modelData
                                    width: cards.width
                                    spacing: 8

                                    Text {
                                        visible: win.ov
                                        text: group.modelData.label + (group.modelData.current ? "   • current" : "")
                                        color: group.modelData.current ? root.accent : root.dimColor
                                        font.family: root.fontFamily
                                        font.pixelSize: 13
                                        font.weight: Font.DemiBold
                                    }
                                    Flow {
                                        width: parent.width
                                        spacing: win.gap
                                        Repeater {
                                            model: group.modelData.items
                                            delegate: Rectangle {
                                                id: card
                                                required property var modelData
                                                readonly property var it: modelData
                                                readonly property int vi: root.viewIndex[it.id] !== undefined ? root.viewIndex[it.id] : -1
                                                readonly property bool selected: vi === root.sel
                                                readonly property string shot: root.shots[it.ident] || ""

                                                width: win.cardW
                                                height: win.cardH
                                                radius: root.radius
                                                readonly property bool hovered: hover.hovered && root.pointerMoved
                                                color: selected ? root.cardSelected : (hovered ? root.cardHover : root.cardColor)
                                                border.width: selected ? 2 : 1
                                                border.color: selected ? root.accent : root.outline

                                                onSelectedChanged: if (selected) Qt.callLater(win.ensureVisible, card)
                                                Component.onCompleted: if (selected) Qt.callLater(win.ensureVisible, card)

                                                HoverHandler {
                                                    id: hover
                                                }

                                                MouseArea {
                                                    id: mouse
                                                    anchors.fill: parent
                                                    hoverEnabled: true
                                                    acceptedButtons: Qt.LeftButton | Qt.MiddleButton
                                                    property point start: Qt.point(-1, -1)
                                                    onPositionChanged: m => {
                                                        if (!root.pointerMoved) {
                                                            const p = mapToItem(null, m.x, m.y);
                                                            if (start.x < 0) {
                                                                start = p;
                                                                return;
                                                            }
                                                            if (Math.abs(p.x - start.x) + Math.abs(p.y - start.y) < 6)
                                                                return;
                                                            root.pointerMoved = true;
                                                        }
                                                        root.sel = card.vi;
                                                    }
                                                    onClicked: m => {
                                                        if (m.button === Qt.MiddleButton) {
                                                            root.killItem(card.it);
                                                            return;
                                                        }
                                                        root.sel = card.vi;
                                                        root.commit();
                                                    }
                                                }

                                                Item {
                                                    id: head
                                                    anchors { left: parent.left; right: parent.right; top: parent.top; margins: 8 }
                                                    height: win.headerH - 8

                                                    IconImage {
                                                        id: icon
                                                        anchors { left: parent.left; verticalCenter: parent.verticalCenter }
                                                        implicitSize: 20
                                                        source: root.iconFor(card.it.appId)
                                                    }
                                                    Text {
                                                        anchors { left: icon.right; leftMargin: 8; right: closeBtn.left; rightMargin: 6; verticalCenter: parent.verticalCenter }
                                                        text: card.it.title || card.it.appId
                                                        color: root.textColor
                                                        font.family: root.fontFamily
                                                        font.pixelSize: 13
                                                        font.weight: card.selected ? Font.DemiBold : Font.Normal
                                                        elide: Text.ElideRight
                                                    }
                                                    Rectangle {
                                                        id: closeBtn
                                                        anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                                                        width: 22
                                                        height: 22
                                                        radius: 11
                                                        visible: card.hovered
                                                        color: closeMouse.containsMouse ? "#e0c42b1c" : "transparent"
                                                        Text {
                                                            anchors.centerIn: parent
                                                            text: "✕"
                                                            color: closeMouse.containsMouse ? "white" : root.dimColor
                                                            font.pixelSize: 12
                                                        }
                                                        MouseArea {
                                                            id: closeMouse
                                                            anchors.fill: parent
                                                            hoverEnabled: true
                                                            onClicked: root.killItem(card.it)
                                                        }
                                                    }
                                                }

                                                ClippingRectangle {
                                                    anchors { left: parent.left; right: parent.right; top: head.bottom; bottom: parent.bottom; margins: 8; topMargin: 4 }
                                                    radius: Math.max(2, root.radius - 4)
                                                    color: Qt.rgba(0, 0, 0, 0.18)

                                                    IconImage {
                                                        anchors.centerIn: parent
                                                        implicitSize: Math.min(parent.width, parent.height) * 0.42
                                                        source: icon.source
                                                        visible: preview.status !== Image.Ready
                                                    }
                                                    Image {
                                                        id: preview
                                                        anchors.fill: parent
                                                        source: card.shot
                                                        fillMode: Image.PreserveAspectFit
                                                        asynchronous: true
                                                        cache: false
                                                        smooth: true
                                                        mipmap: true
                                                        opacity: status === Image.Ready ? 1 : 0
                                                        Behavior on opacity { NumberAnimation { duration: 90 } }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    Text {
                        width: parent.width
                        horizontalAlignment: Text.AlignHCenter
                        text: win.ov ? (root.view.length ? "Arrows move  •  Enter switches  •  Del closes  •  Esc cancels" : "No window matches")
                                     : (root.altHeld ? "Release Alt to switch  •  Tab or arrows move  •  Del closes  •  Esc cancels"
                                                     : "Enter switches  •  arrows move  •  Del closes  •  Esc cancels")
                        color: root.dimColor
                        font.family: root.fontFamily
                        font.pixelSize: 12
                        elide: Text.ElideRight
                    }
                }
            }
        }
    }

    // ---- shortcut list: every bindsym of the Fedora spin, DMS and your own config, merged by `sway-keys --write` ----
    property bool keysShown: false
    property var keyRows: []
    property string keyFilter: ""
    property int keySel: 0
    readonly property var filteredRows: {
        const words = keyFilter.toLowerCase().split(/\s+/).filter(w => w.length);
        if (!words.length)
            return keyRows;
        return keyRows.filter(r => {
            const t = (r.key + " " + r.label + " " + r.cmd).toLowerCase();
            return words.every(w => t.indexOf(w) >= 0);
        });
    }

    readonly property var keyLabels: [
        [/nop switcher open windows prev/, "Switch windows (backwards)"],
        [/nop switcher open windows/, "Switch windows"],
        [/nop switcher open overview prev/, "All workspaces (backwards)"],
        [/nop switcher open overview/, "All workspaces"],
        [/nop switcher open keys/, "This shortcut list"],
        [/^exec dms ipc call spotlight toggle$/, "App launcher"],
        [/^exec dms ipc call spotlight-bar toggle$/, "Quick search bar"],
        [/^exec dms ipc call clipboard toggle$/, "Clipboard history"],
        [/^exec dms ipc call powermenu toggle$/, "Power menu"],
        [/^exec dms ipc call lock lock$/, "Lock screen"],
        [/^exec dms ipc call night toggle$/, "Night light"],
        [/^exec dms ipc call dash toggle wallpaper$/, "Wallpapers"],
        [/^exec dms ipc call dash toggle media$/, "Media panel"],
        [/^exec dms ipc call notepad toggle$/, "Notepad"],
        [/^exec dms ipc call notepad toggleExpand$/, "Notepad (large)"],
        [/^exec dms ipc call notifications toggle$/, "Notification centre"],
        [/^exec dms ipc call settings focusOrToggle$/, "DMS settings"],
        [/^exec dms ipc call inhibit toggle$/, "Idle inhibit"],
        [/^exec dms ipc call processlist focusOrToggle$/, "Task manager"],
        [/^exec dms ipc call color-picker toggle$/, "Colour picker"],
        [/^exec dms ipc call openHere toggle$/, "Open Here"],
        [/^exec dms ipc outputs cycleProfile$/, "Display profile"],
        [/^exec dms ipc call audio increment/, "Volume up"],
        [/^exec dms ipc call audio decrement/, "Volume down"],
        [/^exec dms ipc call audio micmute/, "Mic mute"],
        [/^exec dms ipc call audio mute/, "Mute"],
        [/^exec dms ipc call brightness increment/, "Brightness up"],
        [/^exec dms ipc call brightness decrement/, "Brightness down"],
        [/^exec dms ipc call mpris playPause/, "Play / pause"],
        [/^exec dms ipc call mpris next/, "Next track"],
        [/^exec dms ipc call mpris previous/, "Previous track"],
        [/^exec ptyxis/, "Terminal"],
        [/screenshot-notify full$/, "Screenshot: screen (Edit button)"],
        [/screenshot-notify$/, "Screenshot: area (Edit button)"],
        [/^exec grimshot .*area/, "Screenshot: area"],
        [/^exec grimshot save output/, "Screenshot: screen"],
        [/^exec grimshot save active/, "Screenshot: window"],
        [/^exec gnome-calculator/, "Calculator"],
        [/^kill$/, "Close window"],
        [/^reload$/, "Reload Sway config"],
        [/^fullscreen/, "Fullscreen"],
        [/^floating toggle$/, "Float / tile"],
        [/^focus mode_toggle$/, "Focus tiled / floating"],
        [/^focus parent$/, "Focus parent"],
        [/^focus (left|right|up|down)$/, "Focus $1"],
        [/^move (left|right|up|down)$/, "Move window $1"],
        [/^workspace number (\d+)$/, "Go to workspace $1"],
        [/^move container to workspace number (\d+)$/, "Send window to workspace $1"],
        [/^move container to workspace next/, "Take window to next workspace"],
        [/^move container to workspace prev/, "Take window to previous workspace"],
        [/^workspace next$/, "Next workspace"],
        [/^workspace prev$/, "Previous workspace"],
        [/^splith$/, "Split side by side"],
        [/^splitv$/, "Split top / bottom"],
        [/^layout stacking$/, "Layout: stacking"],
        [/^layout tabbed$/, "Layout: tabbed"],
        [/^layout toggle split$/, "Layout: toggle split"],
        [/^move scratchpad$/, "Send to scratchpad"],
        [/^scratchpad show$/, "Show scratchpad"],
        [/^mode "resize"$/, "Resize mode"],
        [/^mode "passthrough"$/, "Passthrough mode"],
        [/swaynag .*exit sway/, "Exit Sway"]
    ]

    function prettyKey(k, vars) {
        let s = k;
        for (const n in vars)
            s = s.split(n).join(vars[n]);
        return s.replace(/Mod4/g, "Super").replace(/Mod1/g, "Alt").replace(/Control/g, "Ctrl").replace(/\+/g, " + ");
    }

    function labelFor(cmd) {
        const first = cmd.split(";")[0].trim();
        for (const [re, lab] of keyLabels) {
            const m = re.exec(first);
            if (m)
                return lab.replace(/\$(\d)/g, (_, i) => m[+i] || "");
        }
        return first.replace(/^exec\s+/, "");
    }

    function parseKeys(text) {
        const vars = {}, rows = [];
        for (const ln of text.split("\n")) {
            const s = ln.trim();
            let m = /^set\s+(\$\S+)\s+(.+)$/.exec(s);
            if (m) {
                vars[m[1]] = m[2];
                continue;
            }
            m = /^bindsym\s+((?:--\S+\s+)*)(\S+)\s+(.+)$/.exec(s);
            if (m) {
                let cmd = m[3];
                for (const n in vars)
                    cmd = cmd.split(n).join(vars[n]);
                rows.push({ key: prettyKey(m[2], vars), label: labelFor(cmd), cmd: cmd });
            }
        }
        keyRows = rows;
    }

    function openKeys() {
        kind = "keys";
        keyFilter = "";
        keySel = 0;
        outputName = I3.focusedMonitor ? I3.focusedMonitor.name : outputName;
        keysProc.running = true;
    }

    // Enter or a click runs the shortcut's own Sway command once the list has let go of the keyboard.
    function runKey(row) {
        if (!row)
            return;
        close();
        const sw = /nop switcher open (\w+)(?: (\w+))?/.exec(row.cmd);
        if (sw) {
            Qt.callLater(() => root.open(sw[1], sw[2] || "", false));
            return;
        }
        Quickshell.execDetached(["sh", "-c", 'sleep 0.25; swaymsg "$1" >/dev/null 2>&1', "sh", row.cmd]);
    }

    function moveKey(delta) {
        const n = filteredRows.length;
        if (!n)
            return;
        keySel = Math.max(0, Math.min(n - 1, keySel + delta));
        const top = Math.floor(keySel / 2) * 30, f = keysFlick;
        if (top < f.contentY)
            f.contentY = top;
        else if (top + 30 > f.contentY + f.height)
            f.contentY = top + 30 - f.height;
    }

    function scrollKeys(dir) {
        const f = keysFlick;
        const step = 260 * (dir === "up" ? -1 : 1);
        f.contentY = Math.max(0, Math.min(f.contentHeight - f.height, f.contentY + step));
    }

    Process {
        id: keysProc
        command: ["sh", "-c", '"$HOME/.local/bin/sway-keys" --write >/dev/null && cat "${XDG_RUNTIME_DIR:-/tmp}/sway-keys.conf"']
        stdout: StdioCollector {
            onStreamFinished: {
                root.parseKeys(text);
                root.keysShown = root.keyRows.length > 0;
            }
        }
    }

    PanelWindow {
        id: keysWin
        visible: root.keysShown
        screen: Quickshell.screens.find(s => s.name === root.outputName) || Quickshell.screens[0]
        anchors { left: true; right: true; top: true; bottom: true }
        color: "transparent"
        exclusionMode: ExclusionMode.Ignore
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: root.keysShown ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
        WlrLayershell.namespace: "dms:switcher-keys"

        onVisibleChanged: if (visible) {
            search.text = "";
            search.forceActiveFocus();
        }

        Rectangle {
            anchors.fill: parent
            color: root.scrim
            MouseArea { anchors.fill: parent; onClicked: root.close() }

            Rectangle {
                id: keysPanel
                anchors.centerIn: parent
                width: Math.min(parent.width - 80, 1100)
                height: parent.height - 120
                radius: root.radius + 6
                color: root.panelColor
                border.width: 1
                border.color: root.outline
                MouseArea { anchors.fill: parent }

                Row {
                    id: keysHead
                    anchors { top: parent.top; left: parent.left; right: parent.right; margins: 18 }
                    spacing: 16
                    height: 38

                    Rectangle {
                        width: 340
                        height: 38
                        radius: root.radius
                        color: Qt.rgba(0, 0, 0, 0.2)
                        border.width: 1
                        border.color: search.text ? root.accent : root.outline
                        TextInput {
                            id: search
                            anchors { fill: parent; leftMargin: 12; rightMargin: 12 }
                            verticalAlignment: TextInput.AlignVCenter
                            color: root.textColor
                            font.family: root.fontFamily
                            font.pixelSize: 15
                            clip: true
                            focus: true
                            onTextChanged: {
                                root.keyFilter = text;
                                root.keySel = 0;
                                keysFlick.contentY = 0;
                            }
                            Keys.onEscapePressed: root.close()
                            Keys.onDownPressed: root.moveKey(1)
                            Keys.onUpPressed: root.moveKey(-1)
                            Keys.onReturnPressed: root.runKey(root.filteredRows[root.keySel])
                            Keys.onEnterPressed: root.runKey(root.filteredRows[root.keySel])
                            Text {
                                visible: search.text.length === 0
                                anchors.verticalCenter: parent.verticalCenter
                                text: "Type to search shortcuts"
                                color: root.dimColor
                                font.family: root.fontFamily
                                font.pixelSize: 15
                            }
                        }
                    }
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: root.filteredRows.length + " of " + root.keyRows.length + "     Up / Down + Enter or a click runs it     Esc closes"
                        color: root.dimColor
                        font.family: root.fontFamily
                        font.pixelSize: 13
                    }
                }

                Flickable {
                    id: keysFlick
                    anchors { top: keysHead.bottom; left: parent.left; right: parent.right; bottom: parent.bottom; topMargin: 14; margins: 18 }
                    contentWidth: width
                    contentHeight: keysGrid.height
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds

                    Flow {
                        id: keysGrid
                        width: keysFlick.width
                        spacing: 0
                        Repeater {
                            model: root.filteredRows
                            delegate: Rectangle {
                                id: keyRow
                                required property var modelData
                                required property int index
                                readonly property bool selected: index === root.keySel
                                width: keysGrid.width / 2
                                height: 30
                                radius: root.radius / 2
                                color: selected ? root.cardSelected : "transparent"

                                Rectangle {
                                    id: chip
                                    anchors { left: parent.left; leftMargin: 4; verticalCenter: parent.verticalCenter }
                                    width: Math.min(parent.width * 0.5, keyText.implicitWidth + 16)
                                    height: 24
                                    radius: root.radius / 2
                                    color: root.cardColor
                                    border.width: keyRow.selected ? 1 : 0
                                    border.color: root.accent
                                    Text {
                                        id: keyText
                                        anchors.centerIn: parent
                                        text: keyRow.modelData.key
                                        color: root.textColor
                                        font.family: root.fontFamily
                                        font.pixelSize: 13
                                        elide: Text.ElideRight
                                        width: Math.min(implicitWidth, keyRow.width * 0.5 - 16)
                                    }
                                }
                                Text {
                                    anchors { left: chip.right; leftMargin: 12; right: parent.right; rightMargin: 12; verticalCenter: parent.verticalCenter }
                                    text: keyRow.modelData.label
                                    color: keyRow.selected ? root.textColor : root.dimColor
                                    font.family: root.fontFamily
                                    font.pixelSize: 13
                                    elide: Text.ElideRight
                                }
                                MouseArea {
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    onEntered: root.keySel = keyRow.index
                                    onClicked: root.runKey(keyRow.modelData)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
