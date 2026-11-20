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
    local ver=F45 stub=/tmp/ks-machine.cfg f
    grep -qw F45 <<<"$(ksvalidator -l 2>/dev/null)" || ver=DEVEL
    printf 'network --hostname=test\ntimezone UTC --utc\nignoredisk --only-use=vda\nautopart\nuser --name=test\nreboot\n' > "$stub"
    for f in "$@"; do ksvalidator -v "$ver" "$f"; done
    rm -f "$stub"
    echo "kickstarts valid ($ver)"
}

if [ -n "${MIRROR:-}" ]; then
    [[ $MIRROR =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?$ ]] || { echo "MIRROR must be an https URL" >&2; exit 2; }
    MIRROR=${MIRROR%/}
fi
if [ -n "${DMS_MIRROR:-}" ]; then
    [[ $DMS_MIRROR =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?$ ]] || { echo "DMS_MIRROR must be an https URL" >&2; exit 2; }
    DMS_MIRROR=${DMS_MIRROR%/}
fi
if [ -n "${COPR_CACHE:-}" ]; then
    [[ $COPR_CACHE =~ ^https?://[A-Za-z0-9.:-]+(/[A-Za-z0-9._/-]*)?$ ]] || { echo "COPR_CACHE must be an http(s) URL" >&2; exit 2; }
    COPR_CACHE=${COPR_CACHE%/}
fi

validate "$KS" "$KS_DUAL"
[ "$MODE" = check ] && exit 0

SRC=""
for f in "$DIR"/Fedora-Everything-netinst-x86_64-45*.iso; do [ -f "$f" ] && SRC=$f; done
[ -n "$SRC" ] || { echo "missing $DIR/Fedora-Everything-netinst-x86_64-45*.iso (download and verify it first)" >&2; exit 1; }
command -v mkksiso >/dev/null || { echo "mkksiso not found: sudo dnf install lorax" >&2; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude='target/' --exclude='.git/' --exclude='__pycache__/' --exclude='*.log' \
      --exclude='*.bak' --exclude='*.bak.*' --exclude='/.lean' "$HERE/../" "$STAGE/SwayDesk/"
STAGED=("$STAGE/SwayDesk/install/ks.cfg" "$STAGE/SwayDesk/install/ks-dualboot.cfg")
if [ -n "${MIRROR:-}" ]; then
    sed -i -e "s#^url --mirrorlist=.*#url --url=\"$MIRROR/releases/45/Everything/x86_64/os/\"#" \
           -e "s#^repo --name=fedora-updates --mirrorlist=\"[^\"]*\"#repo --name=fedora-updates --baseurl=\"$MIRROR/updates/45/Everything/x86_64/\"#" \
           "${STAGED[@]}"
    echo "Fedora repos pinned to $MIRROR"
fi
if [ -n "${COPR_CACHE:-}" ]; then
    sed -i -E "s#^repo --name=(dms|danklinux) --baseurl=\S+#repo --name=\1 --baseurl=$COPR_CACHE/\1/#" "${STAGED[@]}"
    echo "DMS COPR repos served from $COPR_CACHE"
fi
if [ -n "${DMS_MIRROR:-}" ]; then
    sed -i -E "s#^repo --name=(dms|danklinux) --baseurl=\S+#repo --name=\1 --baseurl=$DMS_MIRROR/#" "${STAGED[@]}"
    echo "DMS repos served from $DMS_MIRROR"
fi
if [ -n "${MIRROR:-}${COPR_CACHE:-}${DMS_MIRROR:-}" ]; then validate "${STAGED[@]}"; fi
iso() { mkksiso --skip-mkefiboot --ks "$STAGE/SwayDesk/install/$1" -a "$STAGE/SwayDesk" -c "$2" "$SRC" "$DIR/$3"; }

sfx=""
if [ "$MODE" = lean ]; then touch "$STAGE/SwayDesk/.lean"; sfx=-lean; fi
out=("swaydesk-fedora45$sfx.iso" "swaydesk-fedora45-dualboot$sfx.iso" "swaydesk-fedora45-vm$sfx.iso")
for o in "${out[@]}"; do rm -f "${DIR:?}/$o"; done
iso ks.cfg "fbcon=font:TER16x32" "${out[0]}"
iso ks-dualboot.cfg "fbcon=font:TER16x32" "${out[1]}"
iso ks.cfg "fbcon=font:TER16x32 console=tty0 console=ttyS0,115200" "${out[2]}"
for o in "${out[@]}"; do ls -lh "$DIR/$o"; done
