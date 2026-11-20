#!/bin/bash
s() { echo test | sudo -S "$@" 2>/dev/null; }
ok()  { printf '  OK    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; }
chk() { local w=$1; shift; if "$@" >/dev/null 2>&1; then ok "$w"; else bad "$w"; fi; }
state=~/.local/state/swaydesk
lean=0; [ -e ~/Projects/SwayDesk/.lean ] && lean=1
echo "## profile: $([ "$lean" = 1 ] && echo "1 (lean)" || echo "3 (full)")"

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
chk "greetd running"                   systemctl is-active greetd
chk "fully updated"                    sh -c '[ "$(echo test | sudo -S dnf -q check-upgrade 2>/dev/null | grep -cE "\.(x86_64|noarch)")" -eq 0 ]'
if [ "$lean" = 1 ]; then
    chk "no Chromium (Profile 1)"      sh -c '! test -e /etc/chromium/chromium.conf'
    chk "no toolbox (Profile 1)"       sh -c '! rpm -q toolbox'
else
    chk "Chromium flags hook (once)"   sh -c '[ "$(grep -c "^# >>> swaydesk:" /etc/chromium/chromium.conf)" -eq 1 ]'
    chk "toolbox installed"            rpm -q toolbox
fi
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
grep -E 'ok|!!|mason:|treesitter:' "$state/firstrun.log" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g; s/^/        /' | tail -40
chk "custom.sh linked"                 test -L ~/.bashrc.d/custom.sh
chk "starship"                         ~/.local/bin/starship --version
chk "JetBrainsMono Nerd Font"          test -f ~/.local/share/fonts/JetBrainsMonoNerdFont-Regular.ttf
chk "sway: DMS binds linked"           test -L ~/.config/sway/config.d/91-dms.conf
chk "switcher binds linked"            test -L ~/.config/sway/config.d/92-switcher.conf
chk "switcher uses binding events"     grep -q '^bindsym Mod1+Tab nop switcher open windows' ~/.config/sway/config.d/92-switcher.conf
chk "DMS welcome page marked seen"     sh -c 'ls ~/.config/dms/.changelog-* >/dev/null'
chk "no second polkit agent"           sh -c '! ls ~/.config/sway/config.d/*policykit*'
chk "Switcher plugin linked"           test -L ~/.config/dms/plugins/Switcher
chk "OpenHere plugin linked"           test -L ~/.config/dms/plugins/OpenHere
chk "plugins enabled in DMS"           sh -c 'grep -q "\"switcher\"" ~/.config/dms/plugin_settings.json && grep -q "\"openHere\"" ~/.config/dms/plugin_settings.json'
chk "sway config valid"                env WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway -C
if [ "$lean" = 1 ]; then
    chk "no dev toolbox (Profile 1)"   sh -c '! podman container exists dev'
else
    chk "lazygit"                      ~/.local/bin/lazygit --version
    chk "dev toolbox: nvim"            toolbox run -c dev nvim --version
    chk "dev toolbox: cargo"           toolbox run -c dev cargo --version
fi
