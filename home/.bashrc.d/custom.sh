alias ..='cd ..'
alias ...='cd ../..'
alias .3='cd ../../..'
alias cp='cp -i'
alias mv='mv -i'
alias rm='rm -i'
alias ls='ls --color=auto'
alias ll='ls -alF --color=auto'
alias la='ls -A --color=auto'
alias l='ls -CF --color=auto'
alias grep='grep --color=auto'

alias tb='toolbox'
alias pkg='sudo dnf'

fp() {
    case ${1:-} in
        i|install) shift; flatpak install --user "$@" ;;
        r|remove)  shift; flatpak uninstall --user "$@" ;;
        s|search)  shift; flatpak search "$@" ;;
        u|update)  shift; flatpak update --user "$@" ;;
        *)         printf 'Usage: fp {install|remove|search|update} [arguments]\n' ;;
    esac
}

clean() {
    local deep=0
    case ${1:-} in
        '') ;;
        --deep|--deeply|-d) deep=1 ;;
        *) printf 'Usage: clean [--deep|--deeply|-d]\n'; return 1 ;;
    esac

    printf 'This removes package caches, unused Flatpaks, old logs, crash dumps, caches, and trash.\n'
    (( deep )) && printf 'Deep mode: also btrfs scrub + light balance (takes a few minutes).\n'
    printf 'Continue? [y/N] '
    local answer
    read -r answer
    [[ $answer =~ ^[Yy]$ ]] || return 0

    local before after
    before=$(df --output=avail -B1 / | tail -1)

    echo '==> dnf package cache'
    sudo dnf clean all

    echo '==> Unused dependencies'
    sudo dnf autoremove -y

    echo '==> Unused Flatpak runtimes (user + system)'
    flatpak uninstall --user --unused -y 2>/dev/null || true
    flatpak uninstall --system --unused -y 2>/dev/null || true

    echo '==> System logs (keep 7 days, max 200M)'
    sudo journalctl --vacuum-time=7d --vacuum-size=200M

    echo '==> Crash dumps older than 7 days'
    sudo find /var/lib/systemd/coredump -type f -mtime +7 -delete

    echo '==> Unused podman images (containers are never touched)'
    podman image prune -f >/dev/null 2>&1 || true

    echo '==> Brave cache'
    if pgrep -f brave-origin >/dev/null; then
        echo '    skipped: Brave is open (close it to clean its cache)'
    else
        command rm -rf "$HOME/.cache/BraveSoftware"
    fi

    echo '==> Thumbnails and trash'
    command rm -rf "$HOME/.cache/thumbnails"
    if command -v gio >/dev/null; then
        gio trash --empty
    fi

    if (( deep )); then
        echo '==> Btrfs scrub (checks every block against its checksum)'
        sudo btrfs scrub start -B /
        echo '==> Btrfs light balance (repacks nearly-empty data chunks)'
        sudo btrfs balance start -dusage=10 /
        echo '==> Btrfs error counters (all should be 0)'
        sudo btrfs device stats /
    fi

    after=$(df --output=avail -B1 / | tail -1)
    printf '==> Done. Freed: %s\n' "$(numfmt --to=iec $(( after > before ? after - before : 0 )))"
}

if [ ! -f /run/.toolboxenv ] && [ ! -f /run/.containerenv ]; then
    nvim() { toolbox run -c dev nvim "$@"; }
    lazygit() { toolbox run -c dev lazygit "$@"; }
fi

info() {
    fastfetch "$@"
}

cls() {
    printf '\033[2J\033[3J\033[H'
    info 2>/dev/null
}

update-starship() {
    local repo bin="$HOME/.local/bin/starship"
    repo=$(readlink -f "$HOME/.bashrc.d/custom.sh") && repo=${repo%/home/.bashrc.d/custom.sh}
    [ -x "$repo/apply.sh" ] || { echo "update-starship: SwayDesk repository not found"; return 1; }
    command mv -f "$bin" "$bin.old" 2>/dev/null
    "$repo/apply.sh" home >/dev/null
    if [ -x "$bin" ]; then command rm -f "$bin.old"; "$bin" --version | head -1
    else command mv -f "$bin.old" "$bin" 2>/dev/null; echo "update-starship: download failed; old version kept"; return 1; fi
}

if command -v starship >/dev/null; then
    eval "$(starship init bash)"
else
    PS1='\[\e[1;36m\]\w\[\e[0m\]\[\e[1;32m\]> \[\e[0m\]'
fi

if [[ $- == *i* ]] && [ ! -f "/run/.toolboxenv" ] && [ ! -f "/run/.containerenv" ]; then
    info 2>/dev/null
fi
