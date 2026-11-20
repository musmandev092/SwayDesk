#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
done_() { printf '    \033[32mok\033[0m  %s\n' "$*"; }
note() { printf '    \033[33m!!\033[0m  %s\n' "$*"; }
in_container() { [ -f /run/.toolboxenv ] || [ -f /run/.containerenv ]; }

in_container && { echo "Run apply.sh on the host, not inside a toolbox." >&2; exit 1; }
SUDO=sudo
LEAN=${LEAN:-0}; [ -e "$HERE/.lean" ] && LEAN=1; [ "$LEAN" = 1 ] || LEAN=0
FW=() FW_CHANGED=0
if [ "$(id -u)" -eq 0 ]; then
    [ "$*" = system ] || { echo "Run apply.sh as your user (as root only: apply.sh system)." >&2; exit 1; }
    SUDO=""
fi

BACKUP=/var/backups/swaydesk
sys_put() {
    local src=$1 dst=$2 mode=${3:-0644}
    if $SUDO cmp -s "$src" "$dst" 2>/dev/null; then done_ "$dst"; return 1; fi
    # first original only, outside the live directory
    if [ -e "$dst" ] && ! $SUDO test -e "$BACKUP$dst"; then
        $SUDO install -d -m 0700 "$BACKUP" && $SUDO cp -a --parents "$dst" "$BACKUP/"
    fi
    $SUDO install -D -m "$mode" "$src" "$dst"
    done_ "$dst (updated)"
    return 0
}

fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 15 "$@"; }

fw_set() {
    local op=$1 kind=$2 val=$3 has=0
    $SUDO "${FW[@]}" "--query-$kind=$val" >/dev/null 2>&1 && has=1
    if [ "$op" = add ] && [ "$has" = 0 ]; then
        $SUDO "${FW[@]}" "--add-$kind=$val" >/dev/null && FW_CHANGED=1
    elif [ "$op" = remove ] && [ "$has" = 1 ]; then
        $SUDO "${FW[@]}" "--remove-$kind=$val" >/dev/null && FW_CHANGED=1
    fi
    return 0
}

has_nvidia() {
    local d
    for d in /sys/bus/pci/devices/*; do
        [ "$(cat "$d/vendor" 2>/dev/null)" = 0x10de ] || continue
        case $(cat "$d/class" 2>/dev/null) in 0x0300*|0x0302*) return 0 ;; esac
    done
    return 1
}

do_system() {
    say "system (sudo)"
    [ -z "$SUDO" ] || $SUDO -n true 2>/dev/null || $SUDO -v

    # Wayland session entry for Sway
    sys_put "$HERE/etc/wayland-sessions/sway.desktop" /usr/share/wayland-sessions/sway.desktop || true

    # Native Sway 1.12 from official Fedora 45 repositories
    if sway --version 2>/dev/null | grep -q ' 1\.1[2-9]'; then
        done_ "sway $(sway --version | awk '{print $3}') (native)"
    else
        $SUDO dnf -y install sway wlroots sway-config-minimal
        done_ "sway $(sway --version | awk '{print $3}') (installed)"
    fi

    # Core system packages and fonts
    local extra=(dconf fwupd-efi fwupd-plugin-uefi-capsule-data gnome-software PackageKit
                 rpmfusion-free-appstream-data rpmfusion-nonfree-appstream-data
                 libayatana-appindicator-gtk3 plymouth-system-theme gh gnome-keyring-pam grub2-tools-extra
                 google-noto-nastaliq-urdu-fonts google-noto-sans-arabic-vf-fonts google-noto-naskh-arabic-vf-fonts
                 google-noto-sans-cjk-fonts google-noto-serif-cjk-fonts google-noto-sans-thai-vf-fonts
                 google-noto-sans-bengali-vf-fonts google-noto-sans-devanagari-vf-fonts google-noto-sans-gurmukhi-vf-fonts
                 google-noto-color-emoji-fonts dejavu-sans-fonts dejavu-sans-mono-fonts dejavu-serif-fonts
                 adwaita-sans-fonts adwaita-mono-fonts
                 xdg-desktop-portal-gtk pipewire-gstreamer cups-pk-helper gutenprint-cups kf6-kimageformats alsa-utils btop
                 sway sway-config-minimal sway-systemd grim grimshot slurp brightnessctl
                 pulseaudio-utils xdg-desktop-portal-wlr
                 ffmpeg gstreamer1-plugin-libav gstreamer1-plugins-ugly gstreamer1-plugins-bad-freeworld) missing=() p
    for p in "${extra[@]}"; do rpm -q "$p" >/dev/null 2>&1 || missing+=("$p"); done
    if [ ${#missing[@]} -gt 0 ]; then
        $SUDO dnf -y -q --setopt=install_weak_deps=False --setopt=fastestmirror=True \
            install --allowerasing "${missing[@]}" && done_ "extra packages (installed: ${missing[*]})"
    else done_ "extra packages (fonts, portal, printing, codecs, btop)"; fi

    # Boot screen: bgrt
    if [ "$(plymouth-set-default-theme 2>/dev/null)" = bgrt ]; then done_ "boot screen: bgrt"
    else $SUDO plymouth-set-default-theme -R bgrt && done_ "boot screen: bgrt (updated, initramfs rebuilt)"; fi

    # sudoless helper
    sys_put "$HERE/etc/local-bin/sudoless" /usr/local/bin/sudoless 0755 || true

    # Hardware Profile 2: Detect NVIDIA and setup drivers
    if has_nvidia; then
        if bash "$HERE/etc/local-bin/swaydesk-nvidia-sync"; then done_ "NVIDIA driver (kmod matches newest kernel)"
        else note "NVIDIA: driver not installed for the newest kernel; run swaydesk-nvidia-sync later"; fi
        sys_put "$HERE/etc/local-bin/prime-run" /usr/local/bin/prime-run 0755 || true
        sys_put "$HERE/etc/local-bin/swaydesk-nvidia-sync" /usr/local/bin/swaydesk-nvidia-sync 0755 || true
        for s in nvidia-hibernate.service nvidia-suspend.service nvidia-resume.service nvidia-powerd.service; do
            systemctl is-enabled "$s" >/dev/null 2>&1 || $SUDO systemctl enable "$s" 2>/dev/null || true
        done
        done_ "NVIDIA services and prime-run"
    else
        done_ "Hardware: Intel/AMD graphics (NVIDIA skipped)"
    fi

    # GRUB HiDPI font
    local font=/boot/grub2/fonts/adwaita-mono-48.pf2
    if [ ! -f "$font" ]; then
        $SUDO mkdir -p /boot/grub2/fonts
        if $SUDO grub2-mkfont -s 48 -o "$font" /usr/share/fonts/adwaita-mono-fonts/AdwaitaMono-Regular.ttf 2>/dev/null; then
            done_ "GRUB font: adwaita-mono-48.pf2 (generated)"
        else note "GRUB font: grub2-mkfont failed"; fi
    else done_ "GRUB font: adwaita-mono-48.pf2"; fi
    if [ -f "$font" ] && [ -f /etc/default/grub ] && ! grep -qxF "GRUB_FONT=$font" /etc/default/grub; then
        $SUDO sed -i '/^GRUB_FONT=/d' /etc/default/grub
        echo "GRUB_FONT=$font" | $SUDO tee -a /etc/default/grub >/dev/null
        $SUDO grub2-mkconfig -o /boot/grub2/grub.cfg >/dev/null 2>&1 && done_ "GRUB_FONT (updated, grub.cfg regenerated)"
    fi

    # Desktop app repository (signed)
    sys_put "$HERE/etc/yum.repos.d/claude-desktop.repo" /etc/yum.repos.d/claude-desktop.repo || true

    # LocalSend installation
    local rel ls_ver ls_have tmp icon=/usr/local/share/icons/hicolor/512x512/apps/localsend.png
    rel=$(fetch https://api.github.com/repos/localsend/localsend/releases/latest) || rel=""
    ls_ver=$(python3 -I -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))' <<<"$rel" 2>/dev/null) || ls_ver=""
    [[ $ls_ver =~ ^[0-9]+(\.[0-9]+)*$ ]] || ls_ver=""
    ls_have=$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' /opt/localsend/data/flutter_assets/version.json 2>/dev/null) || ls_have=""
    if [ -z "$ls_ver" ]; then note "LocalSend: GitHub not reachable; left as it is (${ls_have:-not installed})"
    elif [ "$ls_have" = "$ls_ver" ]; then done_ "LocalSend $ls_ver"
    else
        tmp=$(mktemp -d)
        if gh_release_asset localsend/localsend "LocalSend-$ls_ver-linux-x86-64\.tar\.gz" "$tmp/ls.tgz"; then
            $SUDO rm -rf /opt/localsend.new && $SUDO mkdir -p /opt/localsend.new
            $SUDO tar -xzf "$tmp/ls.tgz" -C /opt/localsend.new --no-same-owner
            $SUDO rm -rf /opt/localsend && $SUDO mv /opt/localsend.new /opt/localsend
            done_ "LocalSend $ls_ver (installed, SHA-256 checked)"
        else note "LocalSend: download or SHA-256 check failed; left as it is (${ls_have:-not installed})"; fi
        rm -rf "$tmp"
    fi
    if [ -x /opt/localsend/localsend_app ]; then
        $SUDO ln -sfn /opt/localsend/localsend_app /usr/local/bin/localsend
        cmp -s /opt/localsend/data/flutter_assets/assets/img/logo-512.png "$icon" \
            || $SUDO install -D -m 0644 /opt/localsend/data/flutter_assets/assets/img/logo-512.png "$icon"
        $SUDO rm -f /usr/local/share/applications/localsend.desktop
        sys_put "$HERE/etc/localsend/org.localsend.localsend_app.desktop" \
            /usr/local/share/applications/org.localsend.localsend_app.desktop || true
    fi

    # Profile 3: Extra browsers (Chromium, Edge) and PowerShell
    if [ "$LEAN" = 0 ]; then
        sys_put "$HERE/etc/yum.repos.d/microsoft-edge.repo" /etc/yum.repos.d/microsoft-edge.repo || true
        sys_put "$HERE/etc/yum.repos.d/microsoft-prod.repo" /etc/yum.repos.d/microsoft-prod.repo || true
        for p in microsoft-edge-stable powershell chromium toolbox; do
            if rpm -q "$p" >/dev/null 2>&1; then done_ "$p"
            elif $SUDO dnf -y -q install "$p"; then done_ "$p (installed)"
            else note "$p: install failed; retried on next run"; fi
        done
    fi

    # Chromium flags
    local cc=/etc/chromium/chromium.conf blk
    if [ -f "$cc" ]; then
        blk=$(printf '# >>> swaydesk: Google sign-in keys >>>\n%s\n# <<< swaydesk <<<' "$(cat "$HERE/etc/chromium/chromium.conf.d-swaydesk")")
        if [ "$(sed -n '/^# >>> swaydesk:/,/^# <<< swaydesk <<<$/p' "$cc")" = "$blk" ]; then
            done_ "Chromium: per-user flags (Google sign-in)"
        else
            $SUDO sed -i '/^# >>> swaydesk:/,/^# <<< swaydesk <<<$/d' "$cc"
            printf '%s\n' "$blk" | $SUDO tee -a "$cc" >/dev/null
            done_ "Chromium: per-user flags (Google sign-in) (updated)"
        fi
    fi

    # SSH: key-only; service and port enabled only when .sshd exists
    if sys_put "$HERE/etc/ssh/sshd_config.d/40-swaydesk.conf" /etc/ssh/sshd_config.d/40-swaydesk.conf 0600 \
       && systemctl is-active -q sshd 2>/dev/null; then
        $SUDO sshd -t && $SUDO systemctl reload sshd && done_ "sshd reloaded (key-only)"
    fi
    if [ -e "$HERE/.sshd" ]; then
        if systemctl is-enabled -q sshd 2>/dev/null; then done_ "sshd on (key-only)"
        elif $SUDO systemctl enable --now sshd >/dev/null 2>&1; then done_ "sshd enabled (key-only)"
        else note "sshd: could not enable"; fi
    elif systemctl is-enabled -q sshd 2>/dev/null || systemctl is-active -q sshd 2>/dev/null; then
        if $SUDO systemctl disable --now sshd >/dev/null 2>&1; then done_ "sshd disabled (no .sshd)"
        else note "sshd: could not disable"; fi
    else done_ "sshd off"; fi

    # Firewall: LocalSend open, no web ports
    FW=(firewall-cmd --permanent); FW_CHANGED=0
    $SUDO firewall-cmd --state >/dev/null 2>&1 || FW=(firewall-offline-cmd)
    fw_set remove service http
    fw_set remove service https
    fw_set remove rich-rule 'rule service name="ssh" accept limit value="6/m"'
    fw_set add port 53317/tcp
    fw_set add port 53317/udp
    if [ -e "$HERE/.sshd" ]; then fw_set add service ssh; else fw_set remove service ssh; fi
    if [ "$FW_CHANGED" = 1 ]; then
        [ "${FW[0]}" = firewall-cmd ] && $SUDO firewall-cmd --reload >/dev/null
        done_ "firewall rules (updated)"
    else done_ "firewall rules"; fi
    if [ -e "$HERE/.sshd" ]; then done_ "firewall: LocalSend 53317 open, SSH open (key-only)"
    else done_ "firewall: LocalSend 53317 open, SSH closed"; fi
}

gh_release_asset() {
    local repo=$1 pat=$2 out=$3 rel name url sum
    rel=$(fetch "https://api.github.com/repos/$repo/releases/latest") || return 1
    read -r name url sum < <(python3 -I -c '
import json, re, sys
d = json.load(sys.stdin); pat = re.compile(sys.argv[1], re.I)
for a in d["assets"]:
    if pat.fullmatch(a["name"]) and (a.get("digest") or "").startswith("sha256:"):
        print(a["name"], a["browser_download_url"], a["digest"][7:]); break' "$pat" <<<"$rel") || return 1
    [ -n "${name:-}" ] || return 1
    fetch -o "$out" "$url" || return 1
    echo "$sum  $out" | sha256sum -c --status
}

link() {
    local src="$HERE/$1" dst="$HOME/$2"
    if [ "$(readlink -f "$dst" 2>/dev/null)" = "$(readlink -f "$src")" ]; then done_ "~/$2"; return; fi
    mkdir -p "$(dirname "$dst")"
    [ -e "$dst" ] || [ -L "$dst" ] && mv "$dst" "$dst.bak.$(date +%s)"
    ln -s "$src" "$dst"
    done_ "~/$2 -> SwayDesk (linked)"
}

do_home() {
    say "home"
    link home/.bashrc.d/custom.sh .bashrc.d/custom.sh
    link home/.config/nvim .config/nvim
    link home/.config/fastfetch .config/fastfetch
    link home/.config/fontconfig .config/fontconfig
    link home/.config/starship.toml .config/starship.toml
    if [ -f "$HOME/.local/bin/sudoless" ] && [ ! -L "$HOME/.local/bin/sudoless" ]; then
        mv "$HOME/.local/bin/sudoless" "$HOME/.local/bin/sudoless.bak" && done_ "~/.local/bin/sudoless -> .bak (now /usr/local/bin/sudoless)"
    fi
    [ -f "$HOME/.gitconfig" ] || { cp "$HERE/home/.gitconfig" "$HOME/.gitconfig"; done_ "~/.gitconfig (copied)"; }

    # Terminal Monospace Font: JetBrains Mono Nerd Font
    local font_dir="$HOME/.local/share/fonts" tmp
    mkdir -p "$font_dir"
    if [ ! -f "$font_dir/JetBrainsMonoNerdFont-Regular.ttf" ]; then
        tmp=$(mktemp -d)
        if gh_release_asset ryanoasis/nerd-fonts 'JetBrainsMono\.tar\.xz' "$tmp/jb.tar.xz" \
           && tar -xJf "$tmp/jb.tar.xz" -C "$font_dir" --wildcards '*.ttf' \
           && [ -f "$font_dir/JetBrainsMonoNerdFont-Regular.ttf" ]; then
            fc-cache -f >/dev/null 2>&1 || true
            done_ "JetBrainsMono Nerd Font (installed, SHA-256 checked)"
        else note "JetBrainsMono Nerd Font: download failed; retried on next run"; fi
        rm -rf "$tmp"
    else done_ "JetBrainsMono Nerd Font"; fi

    local lsp="$HOME/.local/share/org.localsend.localsend_app/shared_preferences.json"
    if python3 -I - "$lsp" <<'EOF'
import json, os, sys
p = sys.argv[1]
d = json.load(open(p)) if os.path.exists(p) else {}
if d.get("flutter.ls_minimize_to_tray") is True:
    sys.exit(0)
d["flutter.ls_minimize_to_tray"] = True
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(d, open(p, "w"))
sys.exit(1)
EOF
    then done_ "LocalSend: close to tray"
    else done_ "LocalSend: close to tray (updated)"; fi

    # Sway and DMS configurations
    link home/.config/sway/config .config/sway/config
    local f
    mkdir -p "$HOME/.config/sway/config.d"
    find "$HOME/.config/sway/config.d" -xtype l -delete
    for f in "$HERE"/home/.config/sway/config.d/*.conf; do link "${f#"$HERE"/}" ".config/sway/config.d/${f##*/}"; done
    swaymsg reload >/dev/null 2>&1 || true

    local ds="$HOME/.config/dms/settings.json" dmark="$HOME/.local/state/swaydesk/dms-settings.applied"
    mkdir -p "$HOME/.config/dms" "${dmark%/*}"
    if [ ! -f "$dmark" ]; then
        [ -f "$ds" ] && cp "$ds" "$ds.bak"
        cp "$HERE/home/.config/dms/settings.json" "$ds" && touch "$dmark"
        done_ "DMS settings (copied once)"
    elif cmp -s "$HERE/home/.config/dms/settings.json" "$ds"; then done_ "DMS settings"
    else done_ "DMS settings (live ones kept)"; fi
    local dv
    dv=$(rpm -q --qf '%{VERSION}' dms 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+') || dv=""
    if [ -n "$dv" ] && [ ! -e "$HOME/.config/dms/.changelog-$dv" ]; then
        echo "$dv" > "$HOME/.config/dms/.changelog-$dv" && done_ "DMS $dv welcome page (marked as seen)"
    fi

    link home/.local/bin/open-here-cwd .local/bin/open-here-cwd
    link home/.local/bin/open-here-toolbox .local/bin/open-here-toolbox
    link home/.config/dms/plugins/OpenHere .config/dms/plugins/OpenHere
    link home/.config/dms/plugins/Switcher .config/dms/plugins/Switcher

    local ps="$HOME/.config/dms/plugin_settings.json" psr=0 pl
    for pl in openHere:"Open Here" switcher:"Window Switcher"; do
        psr=0
        python3 -I - "$ps" "${pl%%:*}" 2>/dev/null <<'PYEOF' || psr=$?
import json, os, sys
f, pid = sys.argv[1:]
d = json.load(open(f)) if os.path.isfile(f) and os.path.getsize(f) else {}
if "enabled" in d.get(pid, {}):
    sys.exit(2)
d.setdefault(pid, {})["enabled"] = True
json.dump(d, open(f, "w"), indent=2)
PYEOF
        if [ "$psr" = 0 ]; then
            dms ipc call plugin-scan scan >/dev/null 2>&1 && sleep 1 && dms ipc call plugins enable "${pl%%:*}" >/dev/null 2>&1 || true
            done_ "${pl#*:} plugin enabled (updated)"
        elif [ "$psr" = 2 ]; then done_ "${pl#*:} plugin enabled"
        fi
    done

    link home/.local/bin/sway-keys .local/bin/sway-keys
    link home/.local/bin/ptyxis-e .local/bin/ptyxis-e
    link home/.local/bin/sway-colors-apply .local/bin/sway-colors-apply
    link home/.config/matugen/config.toml .config/matugen/config.toml
    link home/.config/matugen/templates .config/matugen/templates
    link home/.local/bin/open-with .local/bin/open-with
    link home/.local/share/applications/open-with.desktop .local/share/applications/open-with.desktop
    link home/.local/bin/screenshot-notify .local/bin/screenshot-notify

    # Starship prompt installer
    mkdir -p "$HOME/.local/bin"
    if [ -x "$HOME/.local/bin/starship" ]; then done_ "starship $("$HOME/.local/bin/starship" --version | head -1 | cut -d' ' -f2)"
    else
        tmp=$(mktemp -d)
        if gh_release_asset starship/starship 'starship-x86_64-unknown-linux-gnu\.tar\.gz' "$tmp/starship.tgz" \
           && tar -xzf "$tmp/starship.tgz" -C "$tmp" starship && install -m 755 "$tmp/starship" "$HOME/.local/bin/starship"; then
            done_ "starship (installed, SHA-256 checked)"
        fi
        rm -rf "$tmp"
    fi

    # Herdr installer via PowerShell
    if command -v pwsh >/dev/null 2>&1 && [ ! -d "$HOME/.herdr" ]; then
        pwsh -NoProfile -c "irm https://releases.herdr.dev/app/install.ps1 | iex" >/dev/null 2>&1 && done_ "herdr installed" || true
    fi
}

do_toolbox() {
    say "toolbox: dev"
    if ! podman container exists dev 2>/dev/null; then
        toolbox create -y -c dev --distro fedora --release "$(rpm -E %fedora)"
    fi
    mapfile -t pkgs < <(grep -vE '^\s*(#|$)' "$HERE/toolbox/dev-packages.txt")
    toolbox run -c dev sudo dnf -y -q --setopt=install_weak_deps=False install "${pkgs[@]}"
    done_ "${#pkgs[@]} dev packages"
    toolbox run -c dev sudo ln -sf /usr/bin/flatpak-xdg-open /usr/local/bin/xdg-open \
        && done_ "xdg-open in dev opens host browser"

    if [ -x "$HOME/.local/bin/lazygit" ]; then done_ "lazygit"
    else
        local tmp
        tmp=$(mktemp -d)
        if gh_release_asset jesseduffield/lazygit 'lazygit_[0-9.]+_linux_x86_64\.tar\.gz' "$tmp/lg.tgz" \
           && tar -xzf "$tmp/lg.tgz" -C "$tmp" lazygit && install -m 755 "$tmp/lazygit" "$HOME/.local/bin/lazygit"; then
            done_ "lazygit (installed, SHA-256 checked)"
        fi
        rm -rf "$tmp"
    fi
    grep -q '^prefix=' "$HOME/.npmrc" 2>/dev/null || echo "prefix=$HOME/.local" >> "$HOME/.npmrc"
    toolbox run -c dev bash -c 'command -v neovim-node-host >/dev/null || npm install -g -s neovim' && done_ "neovim node provider"
}

do_nvim() {
    say "nvim: plugins, LSPs, parsers (inside dev)"
    toolbox run -c dev nvim --headless "+Lazy! sync" +qa >/dev/null 2>&1
    done_ "plugins synced (lazy-lock.json)"
    local out try
    for try in 1 2 3; do
        out=$(toolbox run -c dev bash -c "cd '$HERE/nvim-setup' && nvim --headless -c 'luafile install-all.lua'" 2>&1) || true
        grep -q 'mason: .*failures: none' <<<"$out" && break
        [ "$try" -lt 3 ] && note "Mason reported failures; retrying ($try/3)"
    done
    if grep -qE '(mason|treesitter):' <<<"$out"; then
        grep -oE '(mason|treesitter): .*' <<<"$out" | sed 's/^/    /'
    fi
    toolbox run -c dev nvim --headless "+checkhealth" "+w! /tmp/checkhealth.txt" +qa >/dev/null 2>&1 || true
    local errs; errs=$(toolbox run -c dev grep -c 'ERROR' /tmp/checkhealth.txt 2>/dev/null || echo "?")
    done_ ":checkhealth ERROR lines: $errs"
}

steps=("$@")
if [ ${#steps[@]} -eq 0 ]; then
    steps=(system home); [ "$LEAN" = 1 ] || steps+=(toolbox nvim)
fi
for s in "${steps[@]}"; do
    case "$s" in
        system|home|toolbox|nvim) "do_$s" ;;
        *) echo "unknown step: $s (system, home, toolbox, nvim)" >&2; exit 2 ;;
    esac
done
say "done"
