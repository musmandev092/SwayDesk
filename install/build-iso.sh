#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HOME/VMs/fedora-iso"
SRC=$(ls -1 "$DIR"/Fedora-Everything-netinst-x86_64-45*.iso 2>/dev/null | head -1 || true)
[ -n "$SRC" ] && [ -f "$SRC" ] || SRC="$DIR/Fedora-Everything-netinst-x86_64-45-1.0.iso"
KS="$HERE/ks.cfg"
KS_DUAL="$HERE/ks-dualboot.cfg"

[ -f "$SRC" ] || { echo "missing $SRC (download and verify it first)" >&2; exit 1; }
command -v mkksiso >/dev/null || { echo "mkksiso not found: sudo dnf install lorax" >&2; exit 1; }
command -v ksvalidator >/dev/null && {
    printf 'network --hostname=test\ntimezone UTC --utc\nignoredisk --only-use=vda\nautopart\nuser --name=test\nreboot\n' > /tmp/ks-machine.cfg
    ksvalidator -v F45 "$KS"
    ksvalidator -v F45 "$KS_DUAL"
}

LEAN=0; [ "${1:-}" = lean ] && LEAN=1

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude='target/' --exclude='.git/' --exclude='__pycache__/' --exclude='*.log' \
      --exclude='*.bak' --exclude='*.bak.*' --exclude='/.lean' "$HERE/../" "$STAGE/SwayDesk/"

if [ "$LEAN" = 1 ]; then
    touch "$STAGE/SwayDesk/.lean"
    OUT="$DIR/swaydesk-fedora45-dualboot-lean.iso"
    rm -f "$OUT"
    mkksiso --skip-mkefiboot --ks "$STAGE/SwayDesk/install/ks-dualboot.cfg" -a "$STAGE/SwayDesk" -c "fbcon=font:TER16x32" "$SRC" "$OUT"
    ls -lh "$OUT"
    exit 0
fi

rm -f "$DIR/swaydesk-fedora45.iso" "$DIR/swaydesk-fedora45-dualboot.iso" "$DIR/swaydesk-fedora45-vm.iso"
mkksiso --skip-mkefiboot --ks "$KS" -a "$STAGE/SwayDesk" -c "fbcon=font:TER16x32" "$SRC" "$DIR/swaydesk-fedora45.iso"
mkksiso --skip-mkefiboot --ks "$KS_DUAL" -a "$STAGE/SwayDesk" -c "fbcon=font:TER16x32" "$SRC" "$DIR/swaydesk-fedora45-dualboot.iso"
mkksiso --skip-mkefiboot --ks "$KS" -a "$STAGE/SwayDesk" -c "fbcon=font:TER16x32 console=tty0 console=ttyS0,115200" \
        "$SRC" "$DIR/swaydesk-fedora45-vm.iso"
ls -lh "$DIR"/swaydesk-fedora45*.iso
