import sys

from . import data, model, summary as S, validate as V
from .menus import default_disk
from .probe import GIB, human
from .secret import Secret, WEAK, hash_password, strength

try:
    import termios
except ImportError:
    termios = None


class Abort(Exception):
    pass


class TextUI:
    def __init__(self, config, secrets, probe, env, defaults, inp=None, out=None):
        self.c = config
        self.s = secrets
        self.p = probe
        self.env = env
        self.defaults = defaults
        self.inp = inp or sys.stdin
        self.o = out or sys.stdout
        self._setup_tty()

    def _setup_tty(self):
        if termios is None or not hasattr(self.inp, "fileno"):
            return
        try:
            fd = self.inp.fileno()
            if not self.inp.isatty():
                return
            a = termios.tcgetattr(fd)
            a[0] |= termios.ICRNL
            a[3] |= termios.ICANON | termios.ECHO
            termios.tcsetattr(fd, termios.TCSANOW, a)
        except (OSError, ValueError, termios.error):
            pass

    def say(self, text=""):
        self.o.write(text + "\n")
        self.o.flush()

    def _read(self, hidden=False):
        fd, old = None, None
        if hidden and termios is not None:
            try:
                if self.inp.isatty():
                    fd = self.inp.fileno()
                    old = termios.tcgetattr(fd)
                    new = termios.tcgetattr(fd)
                    new[3] &= ~termios.ECHO
                    termios.tcsetattr(fd, termios.TCSANOW, new)
            except (OSError, ValueError, AttributeError, termios.error):
                fd = None
        try:
            line = self.inp.readline()
        finally:
            if fd is not None:
                termios.tcsetattr(fd, termios.TCSANOW, old)
                self.o.write("\n")
        if not line:
            raise Abort("input closed")
        return line.rstrip("\r\n")

    def ask(self, tag, question, default="", validate=None):
        while True:
            d = f" [{default}]" if default != "" else ""
            self.o.write(f"[{tag}] {question}{d}: ")
            self.o.flush()
            a = self._read().strip() or str(default)
            err = validate(a) if validate else ""
            if not err:
                return a
            self.say(f"    {err}")

    def yes(self, tag, question, default=True):
        a = self.ask(tag, question + (" (y/n)"), "y" if default else "n",
                     lambda v: "" if v.lower() in ("y", "yes", "n", "no") else "answer y or n")
        return a.lower().startswith("y")

    def choose(self, tag, question, options, default):
        keys = [str(v) for v, _ in options]
        self.say(f"  {question}:")
        for i, (v, label) in enumerate(options, 1):
            self.say(f"    {i}) {label}")
        dflt = str(keys.index(str(default)) + 1) if str(default) in keys else "1"
        a = self.ask(tag, "Number", dflt, lambda v: "" if v.isdigit() and 1 <= int(v) <= len(options) else "a number from the list")
        return options[int(a) - 1][0]

    def password(self, tag, what, minimum=V.MIN_PASSWORD):
        while True:
            self.o.write(f"[{tag}] {what}: ")
            self.o.flush()
            a = self._read(hidden=True)
            self.o.write(f"[{tag}-again] {what} (again): ")
            self.o.flush()
            b = self._read(hidden=True)
            err = V.password(a, b, minimum)
            if err:
                self.say(f"    {err}")
                continue
            if strength(a) == WEAK:
                r = self.ask("weak", "Weak password. Press Enter to use it anyway, or type no", "",
                             lambda v: "" if v.lower() in ("", "no", "n") else "Enter or no")
                if r.lower() in ("no", "n"):
                    continue
            return a

    # sections

    def sec_hostname(self):
        self.c.hostname = self.ask("hostname", "Computer name", self.c.hostname, V.hostname)

    def sec_timezone(self, initial=False):
        zones = data.zones()
        while True:
            a = self.ask("timezone", "Time zone (type to search)", self.c.time.zone)
            if data.zone_exists(a) or a == "UTC":
                self.c.time.zone = a
                break
            n = a.lower()
            hits = [z for z, country in zones if n in z.lower() or n in country.lower() or n in data.utc_offset(z).lower()]
            if len(hits) == 1:
                self.c.time.zone = hits[0]
                self.say(f"    {hits[0]}")
                break
            if not hits:
                self.say("    no match (examples: Asia/Karachi, Europe/London, UTC)")
                continue
            for i, z in enumerate(hits[:30], 1):
                self.say(f"    {i}) {z}  {data.utc_offset(z)}")
            p = self.ask("timezone-pick", "Number (Enter to search again)", "",
                         lambda v: "" if v == "" or (v.isdigit() and 1 <= int(v) <= min(30, len(hits))) else "a number")
            if p:
                self.c.time.zone = hits[int(p) - 1]
                break
        if initial:
            return
        self.c.time.utc = self.choose("hwclock", "Hardware clock", [("utc", "UTC (recommended)"), ("local", "Local time (Windows)")],
                                      "utc" if self.c.time.utc else "local") == "utc"

    def sec_accounts(self, initial=False):
        a = self.c.auth.admin
        taken = {u.name for u in self.c.auth.users}
        a.fullname = self.ask("fullname", "Full name", a.fullname, V.fullname)
        a.name = self.ask("username", "User name", a.name, lambda v: V.username(v, taken))
        if initial or not self.s.admin or self.yes("change-password", "Change the password?", False):
            pw = self.password("password", "Password")
            model.set_admin_password(self.c, self.s, pw, hash_password(pw))
        if initial:
            return
        if self.choose("root", "Root account", [("lock", "Locked, use sudo"), ("pw", "Set a root password")],
                       "lock" if self.c.auth.root_locked else "pw") == "pw":
            self.s.root = Secret(hash_password(self.password("root-password", "Root password")))
            self.c.auth.root_locked = False
        else:
            self.c.auth.root_locked, self.s.root = True, None
        while self.yes("add-user", "Add another user?", False):
            name = self.ask("user-name", "User name", "", lambda v: V.username(v, taken | {a.name}))
            full = self.ask("user-fullname", "Full name", "", V.fullname)
            pw = self.password("user-password", f"Password for {name}")
            admin = self.yes("user-admin", "Administrator (sudo)?", False)
            self.c.auth.users.append(model.User(name=name, fullname=full, admin=admin))
            self.s.users[name] = Secret(hash_password(pw))
            taken.add(name)

    def sec_disk(self, initial=False):
        d = self.c.disk
        if not initial:
            mode = self.choose("install-type", "Install type", [("erase", "Erase disk and install"),
                                                                ("alongside", "Install alongside (free space)")], d.mode)
            if mode != d.mode:
                d.mode = mode
                d.device = default_disk(self.c, self.p, self.defaults)
        disks = self.p.disks()
        if not disks:
            self.say("  No internal disk found (USB and removable drives are not listed).")
            return
        self.say("  Disks (USB and removable drives are not listed):")
        for i, x in enumerate(disks, 1):
            tag = "  !! WINDOWS !!" if x["windows"] else "  !! WINDOWS BOOT !!" if x["windows_boot"] else ""
            self.say(f"    {i}) {x['name']}  {x['model'] or '-'}  {human(x['size'])}  free {human(x['free'])}  [{x['contents']}]{tag}")
        names = [x["name"] for x in disks]
        dflt = str(names.index(d.device) + 1) if d.device in names else "1"
        a = self.ask("disk", "Install on disk number", dflt,
                     lambda v: "" if v.isdigit() and 1 <= int(v) <= len(disks) else "a number from the list")
        d.device = names[int(a) - 1]
        if initial:
            self.sec_passphrase(initial=True)
            return
        d.fs = self.choose("filesystem", "Filesystem", [("btrfs", "btrfs (recommended)"), ("ext4", "ext4"), ("xfs", "xfs")], d.fs)
        if d.fs != "btrfs" and d.mode == "erase":
            r = self.choose("layout", "Layout", [("lvm:1", "LVM, separate /home"), ("lvm:0", "LVM, no /home"),
                                                 ("plain:1", "Plain, separate /home"), ("plain:0", "Plain, no /home")],
                            f"{d.scheme}:{int(d.home)}")
            d.scheme, d.home = r.split(":")[0], r.endswith("1")
        if d.mode == "alongside":
            x = disks[int(a) - 1]
            v = self.ask("size", f"Linux size in GiB (0 = all {x['free'] // GIB} GiB free)", str(d.size_gib),
                         lambda v: "" if v == "0" else V.size_gib(v, x["free"]))
            d.size_gib = int(v)
        d.encrypt = self.yes("encrypt", "Encrypt the disk (LUKS2)?", d.encrypt)
        if d.encrypt:
            self.sec_passphrase()
            d.unlock_ms = int(self.choose("unlock-time", "Unlock time", [(0, "default (about 2 s)"), (1000, "1 s"), (5000, "5 s"),
                                                                           (10000, "10 s")], d.unlock_ms))

    def sec_passphrase(self, initial=False):
        d = self.c.disk
        same = self.yes("luks-same", "Use the same password for disk encryption?", not d.separate_pass)
        if same:
            if d.separate_pass or not self.s.luks:
                d.separate_pass = False
                self.say("    Enter the administrator password again for the disk.")
                pw = self.password("password", "Password")
                model.set_admin_password(self.c, self.s, pw, hash_password(pw))
        else:
            d.separate_pass = True
            pw = self.password("luks", "Disk passphrase")
            for note in V.passphrase_notes(pw):
                self.say(f"    ! {note}")
            self.s.luks = Secret(pw)

    def sec_locales(self):
        loc = self.c.locale

        def layout_ok(v):
            l, _, var = v.partition(":")
            return "" if data.layout_exists(l, var) else "unknown layout (examples: us, de, de:nodeadkeys, gb)"
        k = self.ask("keyboard", "Keyboard layout (layout or layout:variant)",
                     loc.layout + (f":{loc.variant}" if loc.variant else ""), layout_ok)
        l, _, var = k.partition(":")
        if (l, var) != (loc.layout, loc.variant):
            loc.layout, loc.variant = l, var
            self.p.apply_keymap(data.console_keymap(l, var))
            if self.s.admin:
                self.say("    The keyboard changed: enter the passwords again.")
                self.sec_accounts(initial=True)
                if self.c.disk.separate_pass:
                    self.sec_passphrase()
        k2 = self.ask("keyboard2", "Second layout (none to skip)", (loc.layout2 + (f":{loc.variant2}" if loc.variant2 else "")) or "none",
                      lambda v: "" if v == "none" else layout_ok(v))
        loc.layout2, _, loc.variant2 = ("", "", "") if k2 == "none" else k2.partition(":")
        codes = [c for c, _ in data.LOCALES]
        loc.language = self.ask("language", "Language (e.g. en_US.UTF-8, ur_PK.UTF-8)", loc.language,
                                lambda v: "" if v in codes else "unknown locale")
        ex = self.ask("extra-languages", "Extra languages (space separated, none)", " ".join(loc.extra) or "none",
                      lambda v: "" if v == "none" or all(x in codes for x in v.split()) else "unknown locale")
        loc.extra = [] if ex == "none" else ex.split()
        loc.font = self.choose("font", "Console font", [("large", "large (16x32)"), ("normal", "normal (8x16)")], loc.font)

    def sec_repos(self):
        r = self.c.repos
        r.fedora = self.ask("fedora-mirror", "Fedora mirror URL (none = mirror list)", r.fedora or "none",
                            lambda v: "" if v == "none" else V.mirror_url(v))
        r.fedora = "" if r.fedora == "none" else r.fedora.rstrip("/")
        r.testing = self.yes("testing", "Enable updates-testing?", r.testing)

    def sec_swap(self):
        self.c.swap = self.choose("swap", "Swap", list(S.SWAP.items()), self.c.swap)

    def sec_boot(self):
        b = self.c.boot
        b.timeout = int(self.choose("boot-timeout", "Boot menu timeout", [(t, f"{t} s") for t in (0, 3, 5, 10)], b.timeout))
        b.os_prober = self.yes("os-prober", "List other systems in the boot menu?", b.os_prober)
        a = self.ask("kernel-args", "Extra kernel arguments (none)", b.args or "none",
                     lambda v: "" if v == "none" else V.kernel_args(v))
        b.args = "" if a == "none" else a

    def sec_ssh(self):
        sh = self.c.ssh
        sh.enabled = self.yes("ssh", "Enable the SSH server (key-only)?", sh.enabled)
        if not sh.enabled:
            return
        for k in sh.keys:
            info = V.ssh_key(k)[1]
            self.say(f"    key: {info['type'] if info else '?'} {info['fingerprint'] if info else ''}")
        if sh.keys and self.yes("ssh-clear", "Remove the keys above?", False):
            sh.keys = []
        while True:
            k = self.ask("ssh-key", "Paste a public key (Enter to finish)", "", lambda v: "" if not v else V.ssh_key(v)[0])
            if not k:
                break
            info = V.ssh_key(k)[1]
            self.say(f"    added {info['type']} {info['fingerprint']}")
            sh.keys.append(info["line"])

    def sec_profile(self):
        pr = self.c.profile
        pr.lean = self.choose("profile", "Profile", [(True, "1 Lean (native apps only)"), (False, "3 Full (developer tools)")],
                              pr.lean) in (True, "True")
        pr.nvidia = self.choose("nvidia", "Graphics", [("auto", "Auto" + (" (NVIDIA found)" if self.env.get("nvidia") else "")),
                                                       ("1", "Always NVIDIA"), ("0", "Never NVIDIA")], pr.nvidia)

    def sec_services(self):
        sv = self.c.services
        sv.bluetooth = self.yes("bluetooth", "Bluetooth service on?", sv.bluetooth)
        sv.printing = self.yes("printing", "Printing service on?", sv.printing)

    def sec_network(self):
        n = self.c.network
        while not self.p.online():
            self.wifi()
        n.installed = self.choose("installed-network", "Network on the installed system",
                                  [("copy", "Copy the installer's connections"), ("none", "Save nothing")], n.installed)
        n.wired = self.choose("wired", "Wired", [("dhcp", "DHCP (automatic)"), ("static", "Static address")], n.wired)
        if n.wired == "static":
            devs = self.p.wired_devices()
            n.device = self.ask("device", f"Device ({', '.join(devs)})", n.device or (devs[0] if devs else ""),
                                lambda v: "" if v and (not devs or v in devs) else "one of the devices")
            n.address = self.ask("address", "Address/prefix", n.address, V.ipv4_cidr)
            n.gateway = self.ask("gateway", "Gateway", n.gateway, lambda v: V.gateway(v, n.address))
            n.dns = self.ask("dns", "DNS servers", n.dns, V.dns_list)

    def wifi(self):
        self.say("  No internet. Connect to Wi-Fi (or plug in a cable and press Enter).")
        nets = self.p.wifi_scan()
        for i, x in enumerate(nets[:15], 1):
            self.say(f"    {i}) {x['ssid']}  {x['signal']}%  {x['security']}")
        self.say("    h) hidden network      Enter) check again")
        a = self.ask("wifi", "Wi-Fi network", "", lambda v: "" if v in ("", "h") or (v.isdigit() and 1 <= int(v) <= len(nets[:15])) else "a number, h or Enter")
        if not a:
            self.p.forget_online()
            return
        if a == "h":
            ssid, sec, hidden = self.ask("ssid", "Network name", "", lambda v: "" if v else "required"), "WPA2", True
        else:
            x = nets[int(a) - 1]
            ssid, sec, hidden = x["ssid"], x["security"], False
        pw = ""
        if sec and sec not in ("open", "--"):
            self.o.write(f"[wifi-password] Wi-Fi password for {ssid}: ")
            self.o.flush()
            pw = self._read(hidden=True)
        if self.p.wifi_connect(ssid, pw, sec, hidden):
            self.say(f"  Connected to {ssid}.")
        else:
            self.say(f"  Could not connect to {ssid} (wrong password?).")

    def sec_packages(self):
        idx = data.pkgindex()
        a = self.ask("packages", "Extra packages (space separated, none)", " ".join(self.c.packages) or "none",
                     lambda v: "" if v == "none" else next((V.package(x) for x in v.split() if V.package(x)), ""))
        self.c.packages = [] if a == "none" else sorted(set(a.split()))
        unknown = [p for p in self.c.packages if idx and p not in idx]
        if unknown:
            self.say(f"    ! not in the index (installed after setup, best effort): {' '.join(unknown)}")

    def sec_ntp(self):
        t = self.c.time
        t.ntp = self.yes("ntp", "Automatic time sync (NTP)?", t.ntp)
        if t.ntp:
            a = self.ask("ntp-servers", "NTP servers (space separated, default = Fedora pool)", " ".join(t.servers) or "default",
                         lambda v: "" if v == "default" else next((V.ntp_server(x) for x in v.split() if V.ntp_server(x)), ""))
            t.servers = [] if a == "default" else a.split()

    SECTIONS = [
        ("Locales", "sec_locales", lambda s: S.locale_value(s.c)),
        ("Mirrors", "sec_repos", lambda s: S.repos_value(s.c)),
        ("Disk", "sec_disk", lambda s: S.disk_value(s.c, s.p)),
        ("Swap", "sec_swap", lambda s: S.SWAP[s.c.swap]),
        ("Bootloader", "sec_boot", lambda s: S.boot_value(s.c)),
        ("Hostname", "sec_hostname", lambda s: s.c.hostname),
        ("Accounts", "sec_accounts", lambda s: f"{s.c.auth.admin.fullname} ({s.c.auth.admin.name})" +
         (f" +{len(s.c.auth.users)}" if s.c.auth.users else "") + ("" if s.c.auth.root_locked else ", root password")),
        ("SSH", "sec_ssh", lambda s: S.ssh_value(s.c)),
        ("Profile", "sec_profile", lambda s: S.profile_value(s.c, s.env)),
        ("Services", "sec_services", lambda s: S.services_value(s.c)),
        ("Network", "sec_network", lambda s: S.network_value(s.c, s.p, s.p.online())),
        ("Packages", "sec_packages", lambda s: S.packages_value(s.c)),
        ("Timezone", "sec_timezone", lambda s: S.time_value(s.c)),
        ("Time sync", "sec_ntp", lambda s: S.ntp_value(s.c)),
    ]

    def run(self):
        try:
            return self._run()
        except Abort:
            return "abort:stop"

    def _run(self):
        self.say("")
        self.say("=== SwayDesk installer (text mode) ===")
        self.say("Fedora 45 + Sway + DMS Shell")
        if not self.p.online():
            self.sec_network()
        self.sec_hostname()
        self.sec_timezone(initial=True)
        self.sec_accounts(initial=True)
        self.sec_disk(initial=True)
        while True:
            self.say("")
            self.say("Review:")
            for i, (name, _, value) in enumerate(self.SECTIONS, 1):
                self.say(f"  {i:>2} {name:<11} {value(self)}")
            missing, warnings = V.check(self.c, self.s, self.p)
            for w in warnings:
                self.say(f"  ! {w}")
            for m in missing:
                self.say(f"  * missing: {m}")
            a = self.ask("review", "Number to change, install, or abort", "",
                         lambda v: "" if v in ("install", "abort") or (v.isdigit() and 1 <= int(v) <= len(self.SECTIONS))
                         else "a number, install or abort")
            if a == "abort":
                r = self.choose("abort", "Nothing was written to any disk. Then", [("poweroff", "Power off"), ("reboot", "Reboot"),
                                                                                   ("shell", "Shell"), ("cancel", "Back to the review")],
                                "cancel")
                if r != "cancel":
                    self.say("INSTALL STOPPED: aborted. Nothing was written to any disk.")
                    return f"abort:{r}"
                continue
            if a != "install":
                getattr(self, self.SECTIONS[int(a) - 1][1])()
                continue
            if missing:
                self.say("  Cannot install yet: fix the items marked missing.")
                continue
            word = S.confirm_word(self.c, self.p)
            d = S.disk_obj(self.c, self.p)
            what = f"erase {d['name']}" if word.startswith("WIPE") else f"install on {d['name']}"
            if self.ask("confirm", f"Type {word} to {what}", "") == word:
                return "install"
            self.say(f"  You did not type {word}.")
