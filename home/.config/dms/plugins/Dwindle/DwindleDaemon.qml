import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.I3
import qs.Modules.Plugins
import "DwindleLogic.js" as Logic

// Sway only. New tiled windows split the last focused tiled window (Hyprland dwindle, new window right/bottom).
// The decisions live in DwindleLogic.js; this file only moves events, trees and commands.
// Jobs run one at a time: read the tree, decide, send one command batch, wait for its reply.
PluginComponent {
    id: root

    property var st: Logic.newState()
    property var queue: []
    property var fitIds: []
    property bool busy: false
    property var pending: null
    property string expect: ""
    property string buf: ""
    readonly property string stateFile: (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state") + "/swaydesk/dwindle-off.json"

    function enqueue(job) {
        if (job.kind === "tidy" && queue.some(j => j.kind === "tidy"))
            return;
        queue = queue.concat([job]);
        pump();
    }

    function pump() {
        if (busy || !queue.length)
            return;
        busy = true;
        const next = Logic.nextJob(queue);
        pending = next.job;
        queue = next.rest;
        // Every job tidies the tree it reads, so a pending tidy is covered.
        tidyTimer.stop();
        request("tree", 4, "");
    }

    function finish() {
        watchdog.stop();
        expect = "";
        busy = false;
        pending = null;
        pump();
    }

    // Requests go over a persistent IPC socket; swaymsg is the fallback while it is down.
    function request(kind, type, payload) {
        expect = kind;
        if (ipc.connected) {
            buf = "";
            watchdog.restart();
            ipc.write(Logic.ipcMessage(type, payload));
            ipc.flush();
        } else if (kind === "tree") {
            treeProc.running = true;
        } else {
            cmdProc.command = ["swaymsg", "--", payload];
            cmdProc.running = true;
        }
    }

    function onReply(data) {
        if (!expect)
            return;
        buf += data;
        const reply = Logic.ipcReply(buf);
        if (reply === undefined)
            return;
        buf = "";
        watchdog.stop();
        if (expect === "tree")
            runJob(reply);
        else
            commandDone(Array.isArray(reply) && reply.every(r => r.success));
    }

    function runJob(tree) {
        if (!pending)
            return;
        let res;
        try {
            res = Logic.runJob(st, pending, Logic.index(tree));
        } catch (e) {
            console.warn("dwindle: " + e);
            return finish();
        }
        if (res.toggled)
            saveOff(res.toggled);
        for (const j of res.jobs)
            queue = queue.concat([j]);
        if (res.tidy)
            tidyTimer.restart();
        if (!res.cmds.length)
            return finish();
        request("cmd", 0, res.cmds.join("; "));
    }

    // A command fails when the tree changed after it was read; tidy then cleans up what the batch left.
    function commandDone(ok) {
        if (!ok)
            tidyTimer.restart();
        finish();
    }

    function saveOff(ws) {
        const names = Object.keys(st.off);
        saveProc.command = ["sh", "-c", 'mkdir -p "${1%/*}" && printf %s "$2" > "$1"', "sh", stateFile, JSON.stringify(names)];
        saveProc.running = true;
        notifyProc.command = ["notify-send", "-a", "SwayDesk", "-t", "1500", "Dwindle " + (st.off[ws] ? "off" : "on") + " on workspace " + ws];
        notifyProc.running = true;
    }

    function swayEvent(type, data) {
        if (type === "binding") {
            let e;
            try {
                e = JSON.parse(data);
            } catch (err) {
                return;
            }
            const a = Logic.bindingAction(e.binding && e.binding.command);
            if (a)
                enqueue({ kind: a });
            return;
        }
        const out = Logic.onWindowData(st, data);
        for (const j of out.jobs)
            enqueue(j);
        if (out.fit && out.fit.length) {
            fitIds = fitIds.concat(out.fit);
            fitTimer.restart();
        }
    }

    // Fit shown windows once their clients had time to take the size Sway gave them.
    Timer {
        id: fitTimer
        interval: 150
        onTriggered: {
            root.enqueue({ kind: "fit", ids: root.fitIds });
            root.fitIds = [];
        }
    }

    // A second look after a failed batch, or when a cleanup needs the tree the batch made.
    Timer {
        id: tidyTimer
        interval: 25
        onTriggered: root.enqueue({ kind: "tidy" })
    }

    // A reply that never comes (Sway restarting) must not stall the queue.
    Timer {
        id: watchdog
        interval: 2000
        onTriggered: {
            console.warn("dwindle: no reply from sway");
            ipc.connected = false;
            reconnect.restart();
            root.finish();
        }
    }

    Timer {
        id: reconnect
        interval: 1000
        onTriggered: ipc.connected = true
    }

    Socket {
        id: ipc
        path: Quickshell.env("SWAYSOCK")
        connected: true
        parser: SplitParser {
            splitMarker: ""
            onRead: data => root.onReply(data)
        }
        onConnectionStateChanged: {
            if (connected)
                return;
            reconnect.restart();
            if (root.busy && root.expect)
                root.finish();
        }
    }

    Process {
        id: treeProc
        command: ["swaymsg", "-t", "get_tree", "-r"]
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    root.runJob(Logic.parseTree(text));
                } catch (e) {
                    root.finish();
                }
            }
        }
    }

    Process {
        id: cmdProc
        onExited: (exitCode, exitStatus) => root.commandDone(exitCode === 0)
    }

    Process {
        id: saveProc
    }

    Process {
        id: notifyProc
    }

    Process {
        id: loadProc
        command: ["cat", root.stateFile]
        running: true
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    const o = {};
                    for (const n of JSON.parse(text || "[]"))
                        o[n] = true;
                    root.st.off = o;
                } catch (e) {}
            }
        }
    }

    // The same actions as the key bindings, for callers without a binding event: dms ipc call dwindle action tabs
    IpcHandler {
        target: "dwindle"

        function action(name: string): string {
            if (!/^(tabs|toggle|(focus|swap)-(next|prev))$/.test(name))
                return "unknown";
            root.enqueue({ kind: name });
            return "ok";
        }
    }

    I3IpcListener {
        subscriptions: ["window", "binding"]
        onIpcEvent: event => root.swayEvent(event.type, event.data)
    }

    Component.onCompleted: enqueue({ kind: "tidy" })
}
