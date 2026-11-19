#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HOME/VMs/fedora-iso"
KS="$HERE/ks.cfg"
KS_DUAL="$HERE/ks-dualboot.cfg"
MODE=${1:-full}
case "$MODE" in full|lean|check) ;; *) echo "usage: build-iso.sh [full|lean|check]" >&2; exit 2 ;; esac

validate() {
    command -v ksvalidator >/dev/null || { echo "ksvalidator not found: sudo dnf install pykickstart" >&2; return 1; }
    local ver=F45 stub=/tmp/ks-machine.cfg
    grep -qw F45 <<<"$(ksvalidator -l 2>/dev/null)" || ver=DEVEL
    printf 'network --hostname=test\ntimezone UTC --utc\nignoredisk --only-use=vda\nautopart\nuser --name=test\nreboot\n' > "$stub"
    ksvalidator -v "$ver" "$KS"
    ksvalidator -v "$ver" "$KS_DUAL"
    rm -f "$stub"
    echo "kickstarts valid ($ver)"
}

validate
[ "$MODE" = check ] && exit 0

SRC=""
for f in "$DIR"/Fedora-Everything-netinst-x86_64-45*.iso; do [ -f "$f" ] && SRC=$f; done
[ -n "$SRC" ] || { echo "missing $DIR/Fedora-Everything-netinst-x86_64-45*.iso (download and verify it first)" >&2; exit 1; }
command -v mkksiso >/dev/null || { echo "mkksiso not found: sudo dnf install lorax" >&2; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude='target/' --exclude='.git/' --exclude='__pycache__/' --exclude='*.log' \
      --exclude='*.bak' --exclude='*.bak.*' --exclude='/.lean' "$HERE/../" "$STAGE/SwayDesk/"
iso() { mkksiso --skip-mkefiboot --ks "$STAGE/SwayDesk/install/$1" -a "$STAGE/SwayDesk" -c "$2" "$SRC" "$DIR/$3"; }

if [ "$MODE" = lean ]; then
    touch "$STAGE/SwayDesk/.lean"
    rm -f "$DIR/swaydesk-fedora45-dualboot-lean.iso"
    iso ks-dualboot.cfg "fbcon=font:TER16x32" swaydesk-fedora45-dualboot-lean.iso
    ls -lh "$DIR/swaydesk-fedora45-dualboot-lean.iso"
    exit 0
fi

rm -f "$DIR/swaydesk-fedora45.iso" "$DIR/swaydesk-fedora45-dualboot.iso" "$DIR/swaydesk-fedora45-vm.iso"
iso ks.cfg "fbcon=font:TER16x32" swaydesk-fedora45.iso
iso ks-dualboot.cfg "fbcon=font:TER16x32" swaydesk-fedora45-dualboot.iso
iso ks.cfg "fbcon=font:TER16x32 console=tty0 console=ttyS0,115200" swaydesk-fedora45-vm.iso
ls -lh "$DIR"/swaydesk-fedora45*.iso
