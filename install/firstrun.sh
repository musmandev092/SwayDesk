#!/bin/bash
set -u
repo="$HOME/Projects/SwayDesk"
state="$HOME/.local/state/swaydesk"
log="$state/firstrun.log"
mkdir -p "$state"
notify() { notify-send -a "SwayDesk" "$@" 2>/dev/null || true; }

for _ in $(seq 120); do
    curl -fsS -o /dev/null --max-time 5 https://fedoraproject.org/ && break
    sleep 5
done
sleep 15

steps=(home toolbox nvim)
[ -e "$repo/.lean" ] && steps=(home)
notify "Setting up SwayDesk" "Personal tools (${steps[*]}): a few minutes. You can keep working."
if "$repo/apply.sh" "${steps[@]}" > "$log" 2>&1; then
    touch "$state/firstrun.done"
    notify "SwayDesk is ready" "Everything is set up. Log: $log"
else
    notify -u critical "Setup did not finish" "See $log. Retry at next login or run $repo/apply.sh"
fi

# Link the login screen to the live DMS theme and wallpaper; needs the password once.
if [ ! -e "$state/greeter-sync.done" ] && command -v dms-greeter >/dev/null; then
    export $(systemctl --user show-environment | grep -E '^(WAYLAND_DISPLAY|SWAYSOCK|XDG_CURRENT_DESKTOP)=')
    notify "Login screen" "Enter your password once so the login screen follows your wallpaper and theme."
    "$HOME/.local/bin/ptyxis-e" bash -c "DMS_PRIVESC=sudo dms-greeter sync --yes && touch '$state/greeter-sync.done'; sleep 3"
fi
