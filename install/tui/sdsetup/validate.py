import base64
import hashlib
import ipaddress
import re
import struct

from . import data
from .probe import GIB, MIB

SYSTEM_USERS = {
    "root", "bin", "daemon", "adm", "lp", "sync", "shutdown", "halt", "mail", "operator", "games", "ftp",
    "nobody", "dbus", "polkitd", "sshd", "systemd-network", "systemd-resolve", "systemd-timesync",
    "systemd-coredump", "systemd-oom", "tss", "avahi", "chrony", "colord", "geoclue", "gdm", "greeter",
    "pipewire", "rtkit", "unbound", "dnsmasq", "nm-openvpn", "usbmuxd", "wheel", "users", "flatpak",
    "qemu", "libstoragemgmt", "setroubleshoot", "saslauth", "cups", "abrt", "tcpdump",
}
MIN_PASSWORD = 4
MIN_LINUX_GIB = 30
URL_RE = re.compile(r"^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?$")
CACHE_RE = re.compile(r"^https?://[A-Za-z0-9.:-]+(/[A-Za-z0-9._/-]*)?$")
HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
PKG_RE = re.compile(r"^@?[A-Za-z0-9][A-Za-z0-9._+-]*$")
NTP_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$")
KEY_TYPES = ("ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
             "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com", "ssh-rsa")


def hostname(v):
    if not HOST_RE.match(v or ""):
        return "1-63 letters, digits or -, not starting or ending with -"
    return ""


def username(v, taken=()):
    if not USER_RE.match(v or ""):
        return "lower-case letters, digits, _ or -, starting with a letter (max 32)"
    if v in SYSTEM_USERS:
        return f"{v} is a system account name"
    if v in taken:
        return f"{v} is already used"
    return ""


def fullname(v):
    if v is None or len(v) > 256 or any(c in v for c in ":\n\r\t\x00"):
        return "no colon or line breaks, up to 256 characters"
    return ""


def password(pw, confirm, minimum=MIN_PASSWORD):
    if len(pw) < minimum:
        return f"at least {minimum} characters"
    if any(ord(c) < 32 for c in pw):
        return "no control characters"
    if pw != confirm:
        return "the two entries do not match"
    return ""


def passphrase_notes(pw):
    notes = []
    if any(ord(c) > 126 for c in pw):
        notes.append("Non-ASCII letters may be hard to type at the unlock prompt")
    return notes


def mirror_url(v):
    return "" if URL_RE.match(v or "") else "an https:// URL (letters, digits, . / - _)"


def cache_url(v):
    return "" if CACHE_RE.match(v or "") else "an http(s):// URL"


def kernel_args(v):
    if not v:
        return ""
    if any(c in v for c in "\"'`\\$;|&<>") or not v.isprintable():
        return "printable text without quotes, $ or shell characters"
    if len(v) > 512:
        return "too long"
    return ""


def size_gib(v, free_bytes):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return "a whole number of GiB"
    if n < MIN_LINUX_GIB:
        return f"at least {MIN_LINUX_GIB} GiB"
    if free_bytes is not None and n * GIB > free_bytes:
        return f"only {free_bytes // GIB} GiB free"
    return ""


def package(v):
    return "" if PKG_RE.match(v or "") and len(v) < 200 else "a package name (letters, digits, . _ + -)"


def ntp_server(v):
    return "" if NTP_RE.match(v or "") else "a host name"


def ipv4_cidr(v):
    try:
        iface = ipaddress.IPv4Interface(v)
    except ValueError:
        return "an address with prefix, like 192.168.1.20/24"
    if "/" not in v or iface.network.prefixlen in (0, 32):
        return "include the prefix, like /24"
    return ""


def ipv4(v):
    try:
        ipaddress.IPv4Address(v)
    except ValueError:
        return "an IPv4 address"
    return ""


def dns_list(v):
    items = [x for x in re.split(r"[ ,]+", v or "") if x]
    if not items:
        return "at least one DNS server"
    for x in items:
        try:
            ipaddress.ip_address(x)
        except ValueError:
            return f"{x} is not an IP address"
    return ""


def gateway(v, cidr):
    err = ipv4(v)
    if err:
        return err
    try:
        if ipaddress.IPv4Address(v) not in ipaddress.IPv4Interface(cidr).network:
            return "the gateway is outside the network"
    except ValueError:
        pass
    return ""


def _read_string(blob, off):
    (n,) = struct.unpack(">I", blob[off:off + 4])
    return blob[off + 4:off + 4 + n], off + 4 + n


def ssh_key(line):
    parts = (line or "").strip().split(None, 2)
    if len(parts) < 2:
        return "paste one public key: type, base64 data, optional comment", None
    ktype, b64 = parts[0], parts[1]
    if ktype not in KEY_TYPES:
        return f"key type {ktype} not accepted (ed25519, ecdsa, sk-*, rsa 3072+)", None
    try:
        blob = base64.b64decode(b64, validate=True)
        inner, off = _read_string(blob, 0)
    except (ValueError, struct.error):
        return "the key data is not valid base64", None
    if inner.decode(errors="replace") != ktype:
        return "the key data does not match its type", None
    bits = 256
    if ktype == "ssh-rsa":
        try:
            _, off = _read_string(blob, off)
            n, _ = _read_string(blob, off)
        except struct.error:
            return "the RSA key is damaged", None
        bits = int.from_bytes(n, "big").bit_length()
        if bits < 3072:
            return f"RSA key has {bits} bits; 3072 or more needed", None
    fp = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    short = ktype.replace("ssh-", "").replace("-sha2-nistp", "-").split("@")[0]
    return "", {"type": short, "bits": bits, "comment": parts[2] if len(parts) > 2 else "",
                "fingerprint": fp, "line": f"{ktype} {b64}" + (f" {parts[2]}" if len(parts) > 2 else "")}


def selected_disk(config, probe):
    for d in probe.disks():
        if d["name"] == config.disk.device:
            return d
    return None


def check(config, secrets, probe, online=None):
    missing, warnings = [], []
    d = selected_disk(config, probe)
    if not probe.disks():
        missing.append("Disk: no internal disk found")
    elif d is None:
        missing.append("Disk configuration: choose a disk")
    elif config.disk.mode == "alongside":
        if d["pttype"] != "gpt":
            missing.append(f"Disk: {d['name']} is not GPT (alongside needs GPT)")
        if not d["esp"]:
            missing.append(f"Disk: no EFI partition on {d['name']}")
        elif d["esp_fstype"] not in ("vfat", ""):
            missing.append(f"Disk: the EFI partition is {d['esp_fstype']}, not FAT")
        else:
            free = probe.esp_free(d["esp"])
            if free is not None and free < 50 * MIB:
                missing.append(f"Disk: the EFI partition has only {free // MIB} MiB free (50 needed)")
            if d["esp_size"] and d["esp_size"] <= 110 * MIB:
                warnings.append(f"EFI partition is small ({d['esp_size'] // MIB} MiB)")
        if d["free"] < MIN_LINUX_GIB * GIB:
            missing.append(f"Disk: largest free block is {d['free'] // GIB} GiB ({MIN_LINUX_GIB} needed)")
        elif config.disk.size_gib and config.disk.size_gib * GIB > d["free"]:
            missing.append(f"Disk: Linux size {config.disk.size_gib} GiB is more than the free space")
        if d["bitlocker"]:
            warnings.append("BitLocker found: keep the recovery key ready")
        if d["hibernated"]:
            warnings.append("Windows Fast Startup or hibernation is on: turn it off in Windows first")
        if not probe.uefi:
            missing.append("Alongside install needs UEFI firmware")
    else:
        if d["windows"]:
            warnings.append(f"ERASES Windows on {d['name']}")
        elif d["parts"]:
            warnings.append(f"ERASES everything on {d['name']} ({d['contents']})")
    if config.disk.encrypt and not secrets.luks:
        missing.append("Disk passphrase" if config.disk.separate_pass else "Disk passphrase (set the administrator password)")
    if not config.disk.encrypt:
        warnings.append("Disk encryption is off")
    admin = config.auth.admin
    if username(admin.name) or fullname(admin.fullname):
        missing.append("Administrator: user name or full name")
    if not secrets.admin:
        missing.append("Administrator password")
    if not config.auth.root_locked and not secrets.root:
        missing.append("Root password")
    for u in config.auth.users:
        if not secrets.users.get(u.name):
            missing.append(f"Password for {u.name}")
    if hostname(config.hostname):
        missing.append("Hostname")
    if not data.zone_exists(config.time.zone) and config.time.zone != "UTC":
        missing.append("Timezone")
    if config.network.wired == "static":
        n = config.network
        if ipv4_cidr(n.address) or gateway(n.gateway, n.address) or dns_list(n.dns) or not n.device:
            missing.append("Network: static address settings")
    if online is None:
        online = probe.online()
    if not online:
        missing.append("Internet connection (Network configuration)")
    if config.ssh.enabled and not config.ssh.keys:
        warnings.append("SSH on but no keys: nobody can log in over SSH")
    if not probe.uefi:
        warnings.append("Legacy BIOS mode: UEFI is recommended")
    if d and d["windows"] and config.disk.mode == "alongside" and config.time.utc:
        warnings.append("Windows found: consider hardware clock in local time")
    idx = data.pkgindex()
    unknown = [p for p in config.packages if idx and p not in idx]
    if unknown:
        warnings.append(f"{len(unknown)} package(s) not in the index: installed after setup, best effort")
    return missing, warnings
