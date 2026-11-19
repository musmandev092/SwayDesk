#!/bin/bash
s() { echo test | sudo -S "$@" 2>/dev/null; }
ok()  { printf '  OK    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; }
chk() { local w=$1; shift; if "$@" >/dev/null 2>&1; then ok "$w"; else bad "$w"; fi; }
state=~/.local/state/swaydesk

echo "## answers became the system"
chk "computer name is vmtest"          sh -c '[ "$(hostname)" = vmtest ]'
chk "time zone Asia/Karachi"           sh -c 'timedatectl show -p Timezone --value | grep -qx Asia/Karachi'
chk "user is an administrator (wheel)" sh -c 'id -nG | grep -qw wheel'
chk "full name Test User"              sh -c 'getent passwd test | cut -d: -f5 | grep -q "Test User"'
chk "no passphrase in saved kickstart" sh -c '! echo test | sudo -S grep -q passphrase /root/anaconda-ks.cfg'

echo "## installer did the system part"
chk "SwayDesk copied to ~/Projects"    test -x ~/Projects/SwayDesk/apply.sh
chk "SwayDesk owned by the user"       sh -c '[ "$(stat -c %U ~/Projects/SwayDesk/apply.sh)" = test ]'
chk "GRUB font"                        grep -qx 'GRUB_FONT=/boot/grub2/fonts/adwaita-mono-48.pf2' /etc/default/grub
chk "Chromium flags hook"              grep -qxF '# >>> swaydesk: Google sign-in keys >>>' /etc/chromium/chromium.conf
chk "Chromium hook written once"       sh -c '[ "$(grep -c "^# >>> swaydesk:" /etc/chromium/chromium.conf)" -eq 1 ]'
chk "toolbox installed"                rpm -q toolbox
chk "greetd running"                   systemctl is-active greetd
chk "fully updated"                    sh -c '[ "$(echo test | sudo -S dnf -q check-upgrade 2>/dev/null | grep -cE "\.(x86_64|noarch)")" -eq 0 ]'
s tail -3 /root/ks-post-nochroot.log | sed 's/^/        /'

echo "## first login: personal setup runs by itself"
chk "first-run service enabled"        test -L ~/.config/systemd/user/default.target.wants/swaydesk-firstrun.service
echo "  waiting for it to finish (up to 25 min) ..."
for _ in $(seq 150); do
    [ -f "$state/firstrun.done" ] && break
    systemctl --user is-active -q swaydesk-firstrun.service || { [ -f "$state/firstrun.log" ] && break; }
    sleep 10
done
chk "first-run finished (done marker)" test -f "$state/firstrun.done"
grep -E 'ok|!!|mason:|treesitter:' "$state/firstrun.log" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g; s/^/        /' | tail -30
chk "custom.sh linked"                 test -L ~/.bashrc.d/custom.sh
chk "starship"                         ~/.local/bin/starship --version
chk "lazygit"                          ~/.local/bin/lazygit --version
chk "JetBrainsMono Nerd Font"          test -f ~/.local/share/fonts/JetBrainsMonoNerdFont-Regular.ttf
chk "sway: DMS binds linked"           test -L ~/.config/sway/config.d/91-dms.conf
chk "dev toolbox: nvim"                toolbox run -c dev nvim --version
chk "dev toolbox: cargo"               toolbox run -c dev cargo --version
