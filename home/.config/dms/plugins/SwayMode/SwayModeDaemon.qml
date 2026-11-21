import QtQuick
import Quickshell
import Quickshell.I3
import Quickshell.Wayland
import qs.Common
import qs.Modules.Plugins

// Pill shown while a Sway binding mode other than "default" is active.
PluginComponent {
    id: root

    property string mode: "default"
    readonly property var hints: ({
            "resize": "A D width   W S height   Shift bigger   Esc done",
            "passthrough": "Keys go to the app   Super+Pause leaves"
        })

    I3IpcListener {
        subscriptions: ["mode"]
        onIpcEvent: event => {
            try {
                root.mode = JSON.parse(event.data).change || "default";
            } catch (e) {
                root.mode = "default";
            }
        }
    }

    Variants {
        model: Quickshell.screens

        PanelWindow {
            required property var modelData
            screen: modelData
            visible: root.mode !== "default"
            color: "transparent"
            anchors.top: true
            margins.top: 6
            exclusionMode: ExclusionMode.Ignore
            WlrLayershell.layer: WlrLayer.Overlay
            WlrLayershell.namespace: "dms:sway-mode"
            WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
            implicitWidth: pill.width
            implicitHeight: pill.height
            mask: Region {}

            Rectangle {
                id: pill
                width: row.implicitWidth + 28
                height: 34
                radius: height / 2
                color: Theme.primaryContainer
                border.color: Theme.primary
                border.width: 1

                Row {
                    id: row
                    anchors.centerIn: parent
                    spacing: 12

                    Text {
                        text: root.mode.toUpperCase()
                        color: Theme.primary
                        font.family: Theme.fontFamily
                        font.pixelSize: 15
                        font.weight: Font.Bold
                        anchors.verticalCenter: parent.verticalCenter
                    }

                    Text {
                        text: root.hints[root.mode] || ""
                        visible: text !== ""
                        color: Theme.surfaceText
                        font.family: Theme.fontFamily
                        font.pixelSize: 13
                        anchors.verticalCenter: parent.verticalCenter
                    }
                }
            }
        }
    }
}
