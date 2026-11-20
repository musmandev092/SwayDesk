#!/bin/bash
s() { echo test | sudo -S "$@" 2>/dev/null; }
ok()  { printf '  OK    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; }
chk() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi; }
lean=0; [ -e ~/Projects/SwayDesk/.lean ] && lean=1
echo "## profile: $([ "$lean" = 1 ] && echo "1 (lean)" || echo "3 (full)")"

echo "## system"
echo "  kernel $(uname -r), $(rpm -qa | wc -l) packages, target $(systemctl get-default)"
chk "disk is LUKS-encrypted"            sh -c 'lsblk -o FSTYPE | grep -q crypto_LUKS'
chk "root is btrfs"                     sh -c 'findmnt -no FSTYPE / | grep -qx btrfs'
chk "no failed services"                sh -c '[ -z "$(systemctl --failed --no-legend)" ]'
pend=$(s dnf -q check-upgrade | grep -cE '\.(x86_64|noarch)')
chk "fully updated ($pend pending)"     test "$pend" -eq 0
echo "  sway $(rpm -q --qf '%{VERSION}' sway), kernels: $(rpm -q kernel | tr '\n' ' ')"
echo "  NVIDIA modules for: $(rpm -qa --qf '%{NAME}\n' 'kmod-nvidia-*' | sed 's/^kmod-nvidia-//' | tr '\n' ' ')"
systemctl --failed --no-legend | sed 's/^/        /'

echo "## desktop"
chk "login screen (greetd) running"     systemctl is-active greetd
chk "quickshell is 0.3+ (DMS build)"    sh -c 'rpm -q quickshell | grep -q "^quickshell-0\.[3-9]"'
chk "sway is 1.12+"                     sh -c 'sway --version | grep -qE " 1\.1[2-9]"'
chk "Fedora copies of DMS deps hidden"  test -f /etc/dnf/repos.override.d/50-dms-copr.repo
for p in quickshell dux-search dux-gop matugen dms dux-greeter sway sway-config-minimal; do printf '        %s\n' "$(rpm -q "$p")"; done

echo "## apps"
for p in brave-origin nautilus sushi ptyxis papers loupe showtime snapshot cups system-config-printer gnome-software; do
    chk "$p" rpm -q "$p"
done
for p in chromium microsoft-edge-stable powershell toolbox; do
    if [ "$lean" = 1 ]; then chk "$p absent (Profile 1)" sh -c "! rpm -q $p"; else chk "$p" rpm -q "$p"; fi
done
chk "LocalSend in /opt"                 test -x /opt/localsend/localsend_app

echo "## security"
chk "desktop app repo is signed"        grep -qx 'gpgcheck=1' /etc/yum.repos.d/claude-desktop.repo
if [ "$lean" = 1 ]; then
    chk "no Microsoft repos (Profile 1)" sh -c '! ls /etc/yum.repos.d/microsoft-*.repo'
else
    chk "Microsoft repo limited"        grep -qx 'includepkgs=powershell' /etc/yum.repos.d/microsoft-prod.repo
fi
chk "sshd key-only drop-in"             s grep -qx 'PasswordAuthentication no' /etc/ssh/sshd_config.d/40-swaydesk.conf
fw=$(s firewall-cmd --list-all)
chk "firewall: no http/https"           sh -c '! printf "%s\n" "$1" | grep -E "^ *services:" | grep -qwE "http|https"' _ "$fw"
chk "firewall: SSH closed"              sh -c '! printf "%s\n" "$1" | grep -E "^ *services:" | grep -qw ssh' _ "$fw"
chk "firewall: no SSH rate-limit rule"  sh -c '! printf "%s\n" "$1" | grep -q "limit value"' _ "$fw"
chk "firewall: LocalSend 53317 tcp+udp" sh -c 'printf "%s\n" "$1" | grep -E "^ *ports:" | grep -q "53317/tcp" && printf "%s\n" "$1" | grep -E "^ *ports:" | grep -q "53317/udp"' _ "$fw"
chk "sudoless installed"                test -x /usr/local/bin/sudoless
chk "sshd disabled (no .sshd)"          sh -c '! systemctl is-enabled -q sshd && ! systemctl is-active -q sshd'
chk "no backups beside live files"      sh -c '! ls /etc/yum.repos.d/*.bak /usr/local/bin/*.bak /etc/ssh/sshd_config.d/*.bak'
chk "no swaybg / lxqt-policykit"        sh -c '! rpm -q swaybg && ! rpm -q lxqt-policykit'

echo "## repos"
ls /etc/yum.repos.d/ | sed 's/^/        /'
chk "dnf sees all repos (refresh)"      s dnf -q makecache

echo "## kickstart %post"
s tail -4 /root/ks-post.log | sed 's/^/        /'
s cat /root/ks-done | sed 's/^/        /'
