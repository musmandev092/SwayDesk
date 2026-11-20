from . import data, kickstart, validate
from .probe import GIB, human

SWAP = {
    "zram": "zram (min of RAM and 8 GiB)",
    "zram-half": "zram, half of RAM",
    "zram-full": "zram, same as RAM",
    "none": "none",
}
FS_NOTE = {
    "btrfs": "btrfs: compression, subvolumes, snapshots possible.",
    "ext4": "ext4: the classic Linux filesystem.",
    "xfs": "xfs: fast for large files; cannot shrink.",
}
PROFILE = {
    True: ["PROFILE 1  LEAN  (~690 packages)", "Sway + DMS, Switcher, Brave, Mesa, CUPS, GNOME utilities,",
           "Urdu/Arabic/Indic/Thai/CJK fonts. Native apps only."],
    False: ["PROFILE 3  FULL  (~770 packages)", "Everything in Profile 1, plus Chromium, Microsoft Edge,",
            "PowerShell, toolbox with a developer container, Neovim IDE."],
}


def keyboard(c):
    loc = c.locale
    s = loc.layout + (f" ({loc.variant})" if loc.variant else "")
    if loc.layout2:
        s += f" + {loc.layout2}" + (f" ({loc.variant2})" if loc.variant2 else "")
    return s


def locale_value(c):
    return f"{keyboard(c)} / {data.locale_name(c.locale.language)}"


def repos_value(c):
    r = c.repos
    f = "one mirror" if r.fedora else "mirror list"
    d = "mirror" if r.dms else ("cache" if r.copr_cache else "COPR")
    return f"{f}, DMS {d}" + (", testing" if r.testing else "")


def zram_size(c, ram):
    cap = 8 * GIB
    return {"zram": min(ram, cap), "zram-half": ram // 2, "zram-full": ram}.get(c.swap, 0)


def disk_obj(c, probe):
    return validate.selected_disk(c, probe)


def disk_value(c, probe):
    d = disk_obj(c, probe)
    name = d["name"] if d else "no disk"
    mode = "erase" if c.disk.mode == "erase" else "alongside"
    enc = "LUKS2" if c.disk.encrypt else "no encryption"
    return f"{name}, {mode}, {c.disk.fs}, {enc}"


def disk_plan(c, probe, ram=0):
    d = disk_obj(c, probe)
    if not d:
        return [("No disk chosen.", "err")]
    out = [(f"PLANNED LAYOUT  {d['name']}", "bold"), f"{d['model'] or 'disk'}  {human(d['size'])}", ""]
    enc = "LUKS2 (argon2id)" if c.disk.encrypt else "not encrypted"
    if c.disk.mode == "erase":
        out += ["EFI     600 MiB  new", "/boot   2 GiB    ext4"]
        if c.disk.fs == "btrfs":
            out += [f"system  rest     {enc}", "        btrfs zstd:1", "        root  /", "        home  /home"]
        else:
            scheme = "LVM" if c.disk.scheme == "lvm" else "plain"
            out += [f"system  rest     {enc}", f"        {scheme} {c.disk.fs}", "        /"]
            if c.disk.home:
                out.append("        /home (separate)")
        out.append("")
        if d["windows"]:
            out.append((f"! ERASES Windows and everything else on {d['name']}", "err"))
        elif d["parts"]:
            out.append((f"! ERASES: {d['contents']} on this disk", "err"))
        else:
            out.append("The disk is empty.")
    else:
        size = f"{c.disk.size_gib} GiB" if c.disk.size_gib else f"all free ({d['free'] // GIB} GiB)"
        for p in d["parts"]:
            tag = "EFI, reused" if p["name"] == d["esp"] else "kept"
            out.append(f"{p['name']:<10} {human(p['size']):>8}  {p['fstype'] or '-':<7} {tag}")
        out += [f"new /boot  2 GiB ext4", f"new Linux  {size}  {enc}", f"           {c.disk.fs}" +
                (" root + home" if c.disk.fs == "btrfs" else " /"), "", "Other systems are never changed."]
        if d["bitlocker"]:
            out.append(("! Keep the BitLocker recovery key ready", "warn"))
    out.append("")
    out.append(f"swap: {SWAP[c.swap]}" + (f", {human(zram_size(c, ram))}" if c.swap != "none" and ram else ""))
    return out


def confirm_word(c, probe):
    d = disk_obj(c, probe)
    if c.disk.mode == "alongside":
        return "INSTALL"
    return "WIPE-WINDOWS" if d and d["windows"] else "WIPE"


def auth_value(c, secrets):
    s = c.auth.admin.name or "not set"
    if c.auth.users:
        s += f" +{len(c.auth.users)}"
    return s


def boot_value(c):
    return f"GRUB, {c.boot.timeout} s" + ("" if c.boot.os_prober else ", no other systems")


def ssh_value(c):
    if not c.ssh.enabled:
        return "off"
    return f"on, {len(c.ssh.keys)} key(s)"


def profile_value(c, env):
    p = "1 Lean" if c.profile.lean else "3 Full"
    nv = kickstart.wants_nvidia(c, env)
    return p + (" + NVIDIA" if nv else "")


def services_value(c):
    return f"BT {'on' if c.services.bluetooth else 'off'}, print {'on' if c.services.printing else 'off'}"


def network_value(c, probe, online):
    link = probe.link()
    if not online:
        return "offline"
    if link:
        return f"{'Wi-Fi ' + link['name'] if link['type'] == 'wifi' else 'wired'}"
    return "online"


def packages_value(c):
    return "none" if not c.packages else f"{len(c.packages)}: " + ", ".join(c.packages[:3]) + ("..." if len(c.packages) > 3 else "")


def time_value(c):
    return c.time.zone + ("" if c.time.utc else " (local clock)")


def ntp_value(c):
    if not c.time.ntp:
        return "off"
    return "on" + (f", {len(c.time.servers)} server(s)" if c.time.servers else "")


def review(c, secrets, probe, env):
    d = disk_obj(c, probe)
    users = f"{c.auth.admin.fullname} ({c.auth.admin.name}) admin"
    for u in c.auth.users:
        users += f"; {u.name}{' admin' if u.admin else ''}"
    users += "; root " + ("locked" if c.auth.root_locked else "password")
    dline = "no disk"
    if d:
        what = "-> ERASED" if c.disk.mode == "erase" else "-> free space only"
        dline = f"{d['name']} {d['model']} {human(d['size'])}  {what}"
    enc = "LUKS2 " if c.disk.encrypt else "UNENCRYPTED "
    layout = f"{enc}{c.disk.fs}" + (" root+home" if c.disk.fs == "btrfs" else "")
    extra = f", {len(c.packages)} extra package(s)" if c.packages else ""
    return [
        ("Computer", f"{c.hostname}  {c.time.zone} ({'UTC' if c.time.utc else 'local'} clock)  NTP {'on' if c.time.ntp else 'off'}"),
        ("Locale", f"{data.locale_name(c.locale.language)}, keyboard {keyboard(c)}, {c.locale.font} console font"),
        ("Accounts", users),
        ("Disk", dline),
        ("", f"{layout}  swap: {SWAP[c.swap]}"),
        ("Software", f"Profile {profile_value(c, env)}{extra}"),
        ("Services", services_value(c) + f", SSH {ssh_value(c)}"),
        ("Network", ("copy connections" if c.network.installed == "copy" else "save nothing") +
         (f", static {c.network.address}" if c.network.wired == "static" else ", DHCP")),
        ("Repos", repos_value(c)),
        ("Boot", boot_value(c) + (f", args: {c.boot.args}" if c.boot.args else "")),
    ]
