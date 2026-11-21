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
    readonly property bool active: mode !== "default"
    readonly property var hints: ({
            "resize": [["A", "Narrower"], ["D", "Wider"], ["W", "Taller"], ["S", "Shorter"], ["Shift", "Bigger steps"], ["Esc", "Done"]],
            "passthrough": [["Super+Pause", "Leave"]]
        })
    readonly property int duration: Theme.expressiveDurations ? Theme.expressiveDurations.expressiveEffects : Theme.shortDuration

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
            id: win
            required property var modelData
            property string shownMode: "default"
            screen: modelData
            visible: root.active || pill.opacity > 0
            color: "transparent"
            anchors.top: true
            margins.top: Theme.spacingS
            exclusionMode: ExclusionMode.Ignore
            WlrLayershell.layer: WlrLayer.Overlay
            WlrLayershell.namespace: "dms:sway-mode"
            WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
            implicitWidth: pill.width + Theme.spacingL * 2
            implicitHeight: pill.height + Theme.spacingL * 2
            mask: Region {}

            Connections {
                target: root
                function onModeChanged() {
                    if (root.active)
                        win.shownMode = root.mode;
                }
            }

            Item {
                id: pill
                anchors.centerIn: parent
                width: row.implicitWidth + Theme.spacingL * 2
                height: Theme.buttonHeightS ? Theme.buttonHeightS + Theme.spacingS * 2 : 44
                opacity: root.active ? 1 : 0
                scale: root.active ? 1 : (Theme.popupEnterScale || 0.92)

                readonly property real radius: Theme.fullRadius ? Theme.fullRadius(width, height) : Theme.cornerRadius
                readonly property color fill: Theme.withAlpha(Theme.hostSurface || Theme.surfaceContainer, Theme.popupTransparency)

                Rectangle {
                    anchors.fill: parent
                    z: -1
                    radius: pill.radius
                    color: pill.fill
                    border.color: Theme.outlineVariant
                    border.width: 1
                }

                Behavior on opacity {
                    NumberAnimation {
                        duration: root.duration
                        easing.type: Theme.emphasizedEasing
                    }
                }
                Behavior on scale {
                    NumberAnimation {
                        duration: root.duration
                        easing.type: Theme.emphasizedEasing
                    }
                }

                Row {
                    id: row
                    anchors.centerIn: parent
                    spacing: Theme.spacingM

                    Text {
                        text: win.shownMode.charAt(0).toUpperCase() + win.shownMode.slice(1)
                        color: Theme.primary
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeMedium
                        font.weight: Font.Bold
                        anchors.verticalCenter: parent.verticalCenter
                    }

                    Repeater {
                        model: root.hints[win.shownMode] || []

                        Row {
                            required property var modelData
                            spacing: Theme.spacingXS
                            anchors.verticalCenter: parent.verticalCenter

                            Rectangle {
                                width: Math.max(height, keyText.implicitWidth + Theme.spacingS * 2)
                                height: keyText.implicitHeight + Theme.spacingXS * 2
                                radius: Theme.cornerRadiusXS || Theme.cornerRadius / 2
                                color: Theme.chipSurface || Theme.surfaceContainerHigh
                                anchors.verticalCenter: parent.verticalCenter

                                Text {
                                    id: keyText
                                    anchors.centerIn: parent
                                    text: modelData[0]
                                    color: Theme.surfaceText
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    font.weight: Font.DemiBold
                                }
                            }

                            Text {
                                text: modelData[1]
                                color: Theme.surfaceVariantText
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                anchors.verticalCenter: parent.verticalCenter
                            }
                        }
                    }
                }
            }
        }
    }
}
