import QtQuick
import qs.Common
import qs.Modules.Plugins

PluginComponent {
    SwitcherCore {
        cornerRadius: Theme.cornerRadius
        panelColor: Theme.withAlpha(Theme.surfaceContainer, 0.96)
        cardColor: Theme.surfaceContainerHigh
        cardHover: Theme.surfaceContainerHighest
        cardSelected: Theme.primaryContainer
        accent: Theme.primary
        textColor: Theme.surfaceText
        dimColor: Theme.surfaceVariantText
        outline: Theme.withAlpha(Theme.outline, 0.35)
        scrim: Theme.withAlpha(Theme.background, 0.6)
        fontFamily: Theme.fontFamily
    }
}
