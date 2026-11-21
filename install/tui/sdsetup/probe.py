import glob
import json
import os
import re
import subprocess
import time
import uuid

ESP_TYPE = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
MSR_TYPE = "e3c9e316-0b5c-4db8-817d-f92df00215ae"
RECOVERY_TYPE = "de94bba4-06d1-4d40-a16a-bfd50179d6ac"
ROLE_TEXT = {
    "windows": "Windows system", "bitlocker": "BitLocker", "data": "NTFS data", "ntfs": "NTFS (unreadable)",
    "esp-windows": "Windows boot", "esp": "EFI", "recovery": "Windows recovery", "msr": "Microsoft reserved",
}
GIB = 1024 ** 3
MIB = 1024 ** 2


def run(cmd, timeout=30, data=None):
    try:
        res = subprocess.run(cmd, input=data, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""
    return res.returncode, res.stdout.decode(errors="replace")


def _flag(v):
    return v in (True, 1, "1", "true")


def human(n):
    if n is None:
        return "?"
    for unit, size in (("TiB", 1024 ** 4), ("GiB", GIB), ("MiB", MIB)):
        if n >= size:
            v = n / size
            return f"{v:.0f} {unit}" if v >= 10 else f"{v:.1f} {unit}"
    return f"{n} B"


def role(p):
    """What a partition is, from its type and what was found inside it."""
    pt, fs = (p.get("parttype") or "").lower(), (p.get("fstype") or "").lower()
    if pt == ESP_TYPE:
        return "esp-windows" if p.get("winboot") or p.get("firmware") else "esp"
    if pt == MSR_TYPE:
        return "msr"
    if pt == RECOVERY_TYPE:
        return "recovery"
    if fs == "bitlocker":
        return "bitlocker"
    if fs == "ntfs":
        return "windows" if p.get("system") else "ntfs" if p.get("unreadable") else "data"
    return ""


def classify(disk):
    """Windows needs evidence (a Windows folder, or BitLocker beside its boot manager or recovery); NTFS alone is data."""
    parts = disk.get("parts", [])
    for p in parts:
        p["role"] = role(p)
    roles = [p["role"] for p in parts]
    disk["windows_boot"] = "esp-windows" in roles
    disk["bitlocker"] = "bitlocker" in roles
    disk["windows"] = "windows" in roles or (disk["bitlocker"] and (disk["windows_boot"] or "recovery" in roles)) \
        or ("ntfs" in roles and disk["windows_boot"])
    disk["hibernated"] = any(p.get("hiberfil") for p in parts if p["role"] == "windows")
    esp = sorted((p for p in parts if p["role"] in ("esp", "esp-windows")), key=lambda p: p["role"] != "esp-windows")
    disk["esp"] = esp[0]["name"] if esp else ""
    disk["esp_size"] = esp[0]["size"] if esp else 0
    disk["esp_fstype"] = esp[0].get("fstype") or "" if esp else ""
    seen = []
    for p in parts:
        r = p["role"]
        text = ROLE_TEXT.get(r, p.get("fstype") or "") if r != "msr" else ""
        if r == "data" and p.get("label"):
            text += f" '{p['label']}'"
        if text and text not in seen:
            seen.append(text)
    disk["contents"] = ", ".join(seen) or "empty"
    return disk


def _has(root, *names):
    """Case-insensitive path lookup (Windows file names)."""
    cur = root
    for n in names:
        try:
            hit = next((e for e in os.listdir(cur) if e.lower() == n.lower()), None)
        except OSError:
            return False
        if hit is None:
            return False
        cur = os.path.join(cur, hit)
    return True


def firmware_windows(efibootmgr_text):
    """Partition UUIDs of the EFI partitions that firmware boot entries named Windows point at."""
    out = set()
    for m in re.finditer(r"^Boot[0-9A-Fa-f]{4}\*?\s+([^\t\n]*?)\s+HD\(\d+,GPT,([0-9a-fA-F-]{36})", efibootmgr_text, re.M):
        if "windows" in m.group(1).lower():
            out.add(m.group(2).lower())
    return out


class Probe:
    fixture = False

    def __init__(self):
        self._cache = {}
        self.virt = self._virt()
        self.uefi = os.path.isdir("/sys/firmware/efi")

    def _virt(self):
        rc, out = run(["systemd-detect-virt"], 5)
        v = out.strip()
        return "" if v in ("", "none") else v

    @property
    def is_vm(self):
        return bool(self.virt)

    def ram(self):
        try:
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        return int(line.split()[1]) * 1024
        except OSError:
            pass
        return 0

    def battery(self):
        for p in glob.glob("/sys/class/power_supply/*/type"):
            try:
                if open(p).read().strip() == "Battery":
                    return True
            except OSError:
                pass
        return False

    def nvidia(self):
        for d in glob.glob("/sys/bus/pci/devices/*"):
            try:
                vendor = open(f"{d}/vendor").read().strip()
                cls = open(f"{d}/class").read().strip()
            except OSError:
                continue
            if vendor == "0x10de" and (cls.startswith("0x0300") or cls.startswith("0x0302")):
                return True
        return False

    def disks(self, refresh=False):
        if "disks" in self._cache and not refresh:
            return self._cache["disks"]
        rc, out = run(["lsblk", "-J", "-b", "-o",
                       "NAME,PATH,TYPE,SIZE,MODEL,TRAN,RM,RO,HOTPLUG,FSTYPE,PARTTYPE,PARTLABEL,LABEL,PTTYPE,PARTUUID"])
        fw = firmware_windows(run(["efibootmgr", "-v"], 10)[1]) if self.uefi else set()
        disks = []
        try:
            devices = json.loads(out).get("blockdevices", []) if rc == 0 else []
        except ValueError:
            devices = []
        for d in devices:
            if d.get("type") != "disk" or _flag(d.get("rm")) or _flag(d.get("ro")) or _flag(d.get("hotplug")):
                continue
            if (d.get("tran") or "") == "usb" or d["name"].startswith(("zram", "loop", "sr")):
                continue
            if not d.get("size"):
                continue
            parts = [{
                "name": c["name"], "size": int(c.get("size") or 0), "fstype": c.get("fstype") or "",
                "parttype": c.get("parttype") or "", "partlabel": c.get("partlabel") or "",
                "label": c.get("label") or "", "partuuid": (c.get("partuuid") or "").lower(),
            } for c in d.get("children", []) if c.get("type") == "part"]
            for p in parts:
                p.update(self._inspect(p))
                p["firmware"] = bool(p["partuuid"]) and p["partuuid"] in fw
            disk = {
                "name": d["name"], "path": d.get("path") or f"/dev/{d['name']}", "size": int(d["size"]),
                "model": (d.get("model") or "").strip(), "tran": d.get("tran") or "",
                "pttype": d.get("pttype") or "", "parts": parts, "free": self._free(d["name"], int(d["size"]), parts),
            }
            disks.append(classify(disk))
        self._cache["disks"] = disks
        return disks

    def _inspect(self, p):
        """Read-only look for the Windows boot manager, a Windows folder and a hibernation file."""
        pt, fs = p["parttype"].lower(), p["fstype"].lower()
        if not (pt == ESP_TYPE and fs == "vfat") and fs != "ntfs":
            return {}
        key = f"inspect:{p['name']}"
        if key in self._cache:
            return self._cache[key]
        mnt = "/tmp/swaydesk-inspect"
        os.makedirs(mnt, exist_ok=True)
        opts = "ro,noexec,nosuid,nodev"
        dev = f"/dev/{p['name']}"
        if fs == "vfat":
            ok = run(["mount", "-t", "vfat", "-o", opts, dev, mnt])[0] == 0
        else:
            ok = run(["mount", "-t", "ntfs3", "-o", opts + ",force", dev, mnt])[0] == 0 or \
                run(["mount", "-t", "ntfs-3g", "-o", opts, dev, mnt])[0] == 0
        facts = {}
        if not ok:
            facts["unreadable"] = True
        else:
            try:
                if fs == "vfat":
                    facts["winboot"] = _has(mnt, "EFI", "Microsoft", "Boot", "bootmgfw.efi")
                else:
                    facts["system"] = _has(mnt, "Windows", "System32", "ntoskrnl.exe")
                    facts["hiberfil"] = facts["system"] and _has(mnt, "hiberfil.sys")
            finally:
                run(["umount", mnt])
        self._cache[key] = facts
        return facts

    def _free(self, name, size, parts):
        if not parts:
            return size
        rc, out = run(["sfdisk", "--list-free", "--bytes", f"/dev/{name}"])
        best = 0
        for line in out.splitlines():
            f = line.split()
            if len(f) >= 4 and f[0].isdigit() and f[3].isdigit():
                best = max(best, int(f[3]))
        return best

    def esp_free(self, part):
        key = f"espfree:{part}"
        if key in self._cache:
            return self._cache[key]
        mnt = "/tmp/swaydesk/esp"
        os.makedirs(mnt, exist_ok=True)
        free = None
        if run(["mount", "-o", "ro", f"/dev/{part}", mnt])[0] == 0:
            try:
                st = os.statvfs(mnt)
                free = st.f_bavail * st.f_frsize
            finally:
                run(["umount", mnt])
        self._cache[key] = free
        return free

    def preferred_disk(self, by_id):
        if not by_id:
            return ""
        try:
            return os.path.basename(os.path.realpath(by_id)) if os.path.exists(by_id) else ""
        except OSError:
            return ""

    def online(self, urls=("https://mirrors.fedoraproject.org/",), max_age=20):
        hit = self._cache.get("online")
        if hit and time.time() - hit[1] < max_age:
            return hit[0]
        ok = any(run(["curl", "-fsS", "-o", "/dev/null", "--max-time", "8", u], 12)[0] == 0 for u in urls)
        self._cache["online"] = (ok, time.time())
        return ok

    def forget_online(self):
        self._cache.pop("online", None)

    def link(self):
        rc, out = run(["nmcli", "-t", "-e", "yes", "-f", "TYPE,STATE,CONNECTION,DEVICE", "dev"], 10)
        for line in out.splitlines():
            f = _split_nm(line)
            if len(f) >= 4 and f[1] == "connected" and f[0] in ("wifi", "ethernet"):
                return {"type": f[0], "name": f[2], "device": f[3]}
        return None

    def wired_devices(self):
        rc, out = run(["nmcli", "-t", "-e", "yes", "-f", "TYPE,DEVICE", "dev"], 10)
        return [f[1] for f in map(_split_nm, out.splitlines()) if len(f) >= 2 and f[0] == "ethernet"]

    def wifi_scan(self):
        run(["nmcli", "dev", "wifi", "rescan"], 15)
        time.sleep(3)
        rc, out = run(["nmcli", "-t", "-e", "yes", "-f", "SSID,SIGNAL,SECURITY,FREQ", "dev", "wifi", "list"], 20)
        nets, seen = [], set()
        for line in out.splitlines():
            f = _split_nm(line)
            if len(f) < 4 or not f[0] or f[0] in seen:
                continue
            seen.add(f[0])
            nets.append({"ssid": f[0], "signal": int(f[1] or 0), "security": f[2] or "open", "freq": f[3]})
        nets.sort(key=lambda n: -n["signal"])
        return nets

    def wifi_connect(self, ssid, password, security, hidden=False):
        path = write_wifi_keyfile("/etc/NetworkManager/system-connections", ssid, password, security, hidden)
        run(["nmcli", "connection", "reload"], 15)
        rc, _ = run(["nmcli", "connection", "up", "filename", path], 45)
        self.forget_online()
        return rc == 0

    def fetch(self, url, timeout=15):
        rc, out = run(["curl", "-fsSL", "--proto", "=https", "--max-time", str(timeout), url], timeout + 5)
        return out if rc == 0 else None

    def check_url(self, url, timeout=10):
        t = time.time()
        rc, _ = run(["curl", "-fsSL", "-o", "/dev/null", "--max-time", str(timeout), url], timeout + 5)
        return rc == 0, time.time() - t

    def apply_keymap(self, console):
        if console:
            run(["loadkeys", console], 10)

    def apply_font(self, font):
        run(["setfont", font], 10)

    def removable_partitions(self):
        rc, out = run(["lsblk", "-J", "-b", "-o", "NAME,TYPE,SIZE,FSTYPE,LABEL,TRAN,RM,HOTPLUG,MODEL"])
        res = []
        try:
            devices = json.loads(out).get("blockdevices", []) if rc == 0 else []
        except ValueError:
            devices = []
        for d in devices:
            if not (_flag(d.get("rm")) or _flag(d.get("hotplug")) or d.get("tran") == "usb"):
                continue
            for c in d.get("children", []) or []:
                if (c.get("fstype") or "") in ("vfat", "exfat", "ext4"):
                    res.append({"name": c["name"], "label": c.get("label") or "", "model": (d.get("model") or "").strip()})
        return res

    def save_to(self, part, filename, text):
        mnt = "/tmp/swaydesk/usb"
        os.makedirs(mnt, exist_ok=True)
        if run(["mount", f"/dev/{part}", mnt])[0] != 0:
            return False
        try:
            with open(os.path.join(mnt, filename), "w") as f:
                f.write(text)
            return True
        except OSError:
            return False
        finally:
            run(["sync"])
            run(["umount", mnt])


def _split_nm(line):
    out, cur, esc = [], [], False
    for ch in line:
        if esc:
            cur.append(ch)
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == ":":
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur))
    return out


def _kf_escape(s):
    s = s.replace("\\", "\\\\").replace("\n", "\\n").replace("\t", "\\t").replace("\r", "\\r")
    return "\\s" + s[1:] if s.startswith(" ") else s


def write_wifi_keyfile(directory, ssid, password, security, hidden=False):
    os.makedirs(directory, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", ssid) or "wifi"
    path = os.path.join(directory, f"swaydesk-{safe}.nmconnection")
    lines = ["[connection]", f"id={_kf_escape(ssid)}", f"uuid={uuid.uuid4()}", "type=wifi", "",
             "[wifi]", "mode=infrastructure", f"ssid={_kf_escape(ssid)}"]
    if hidden:
        lines.append("hidden=true")
    sec = (security or "").upper()
    if password:
        mgmt = "sae" if "WPA3" in sec and "WPA2" not in sec else "wpa-psk"
        lines += ["", "[wifi-security]", f"key-mgmt={mgmt}", f"psk={_kf_escape(password)}"]
    lines += ["", "[ipv4]", "method=auto", "", "[ipv6]", "method=auto", ""]
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines))
    os.chmod(path, 0o600)
    return path


class FixtureProbe(Probe):
    fixture = True

    def __init__(self, path):
        with open(path) as f:
            self.data = json.load(f)
        self._cache = {}
        self.virt = self.data.get("virt", "")
        self.uefi = self.data.get("uefi", True)
        self.calls = []

    def ram(self):
        return self.data.get("ram", 16 * GIB)

    def battery(self):
        return self.data.get("battery", False)

    def nvidia(self):
        return self.data.get("nvidia", False)

    def disks(self, refresh=False):
        return [classify(dict(d)) for d in self.data.get("disks", [])]

    def esp_free(self, part):
        return self.data.get("esp_free", {}).get(part)

    def preferred_disk(self, by_id):
        return self.data.get("preferred_disk", "")

    def online(self, urls=(), max_age=20):
        return self.data.get("online", True)

    def link(self):
        return self.data.get("link")

    def wired_devices(self):
        return self.data.get("wired", ["enp0s31f6"])

    def wifi_scan(self):
        return self.data.get("wifi", [])

    def wifi_connect(self, ssid, password, security, hidden=False):
        self.calls.append(("wifi", ssid))
        self.data["online"] = True
        self.data["link"] = {"type": "wifi", "name": ssid, "device": "wlp0s20f3"}
        return True

    def fetch(self, url, timeout=15):
        return self.data.get("fetch", {}).get(url)

    def check_url(self, url, timeout=10):
        return True, 0.1

    def apply_keymap(self, console):
        self.calls.append(("loadkeys", console))

    def apply_font(self, font):
        self.calls.append(("setfont", font))

    def removable_partitions(self):
        return self.data.get("usb", [])

    def save_to(self, part, filename, text):
        self.calls.append(("save", part, filename))
        return True
