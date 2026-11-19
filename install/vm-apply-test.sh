#!/bin/bash
set -u
s() { echo test | sudo -S "$@" 2>/dev/null; }
s sh -c 'echo "test ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/vmtest'

rpm -q tar rsync git-core >/dev/null 2>&1 || sudo dnf -y -q install tar rsync git-core

sudo mkdir -p /mnt/share && { mountpoint -q /mnt/share || sudo mount -o ro /dev/sr0 /mnt/share; }
mkdir -p ~/Projects && rm -rf ~/Projects/SwayDesk && cp -r /mnt/share ~/Projects/SwayDesk
chmod -R u+w ~/Projects/SwayDesk
cd ~/Projects/SwayDesk || exit 1

echo test | sudo -S -v 2>/dev/null
( while sleep 60; do echo test | sudo -S -v 2>/dev/null; done ) &
KEEPALIVE=$!
trap 'kill $KEEPALIVE 2>/dev/null' EXIT

echo "##### apply.sh"
time ./apply.sh 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
echo "##### apply.sh again (should change nothing)"
./apply.sh system home 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'updated|installed|copied|linked|!!' || echo "  nothing changed"

echo "##### checks"
ok()  { printf '  OK    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; }
chk() { local w=$1; shift; if "$@" >/dev/null 2>&1; then ok "$w"; else bad "$w"; fi; }
chk "GRUB font set"                   grep -qx 'GRUB_FONT=/boot/grub2/fonts/adwaita-mono-48.pf2' /etc/default/grub
chk "Chromium flags hook (once)"      sh -c '[ "$(grep -c "^# >>> swaydesk:" /etc/chromium/chromium.conf)" -eq 1 ]'
chk "sshd key-only drop-in"           s test -f /etc/ssh/sshd_config.d/40-swaydesk.conf
chk "firewall: SSH closed"            sh -c '! echo test | sudo -S firewall-cmd --query-service=ssh'
chk "firewall: no http"               sh -c '! echo test | sudo -S firewall-cmd --query-service=http'
chk "firewall: LocalSend tcp"         s firewall-cmd --query-port=53317/tcp
chk "firewall: LocalSend udp"         s firewall-cmd --query-port=53317/udp
chk "custom.sh linked"                test -L ~/.bashrc.d/custom.sh
chk "nvim config linked"              test -L ~/.config/nvim
chk "Nerd font installed"             sh -c 'fc-list | grep -qi "JetBrainsMono Nerd"'
chk "Urdu font installed"             sh -c 'fc-list | grep -qi "Noto Nastaliq Urdu"'
chk "sway: DMS binds linked"          test -L ~/.config/sway/config.d/91-dms.conf
chk "sway config valid"               sway -C
chk "DMS settings"                    test -f ~/.config/dms/settings.json
chk "starship"                        ~/.local/bin/starship --version
chk "lazygit"                         ~/.local/bin/lazygit --version
chk "dev toolbox exists"              podman container exists dev
chk "nvim inside dev"                 toolbox run -c dev nvim --version
chk "rust inside dev"                 toolbox run -c dev cargo --version
chk "go inside dev"                   toolbox run -c dev go version
chk "node inside dev"                 toolbox run -c dev node --version
chk "gh inside dev"                   toolbox run -c dev gh --version
echo "## a new login shell (custom.sh + starship):"
bash -lic 'type nvim | head -1; type fp | head -1; echo "starship hook: $(declare -F starship_precmd >/dev/null && echo yes || echo no)"' 2>/dev/null </dev/null | sed "s/^/  /"
echo "## LSP check (Rust file, inside dev):"
cd ~/Projects/SwayDesk/nvim-setup/test 2>/dev/null && toolbox run -c dev nvim --headless rs/src/main.rs -c 'luafile ../check-file.lua' 2>/dev/null | head -1 | sed 's/^/  /'
