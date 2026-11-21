from . import data, kickstart, model, summary as S, validate as V
from .probe import GIB, ROLE_TEXT, human
from .secret import Secret, hash_password, strength, strength_hint, WEAK
from .tui import dialogs as D
from .tui.menu import Done, Item, Menu, back, blank
from .tui.widgets import TextField, wrap

FONTS = {"large": "latarcyrheb-sun32", "normal": "eurlatgr"}


def password_hint(v, vals):
    return strength_hint(v)


def match_hint(v, vals):
    if not v:
        return "", None
    return ("ok, they match", "ok") if v == vals[-2] else ("they do not match yet", "warn")


class Setup:
    def __init__(self, ui, config, secrets, probe, env, defaults, advanced=False):
        self.ui = ui
        self.c = config
        self.s = secrets
        self.p = probe
        self.env = env
        self.defaults = defaults
        self.advanced = advanced
        self.online = probe.online(self.online_urls())
        self.repo_status = []
        ui.on_install = self.install
        ui.on_abort = self.abort

    # helpers

    def online_urls(self):
        urls = ["https://mirrors.fedoraproject.org/"]
        if self.c.repos.fedora:
            urls.insert(0, self.c.repos.fedora.rstrip("/") + "/")
        return urls

    def refresh_online(self):
        self.p.forget_online()
        self.online = self.p.online(self.online_urls())

    def check(self):
        return V.check(self.c, self.s, self.p, self.online)

    def missing_for(self, *prefixes):
        return [m for m in self.check()[0] if m.startswith(prefixes)]

    def pick_simple(self, title, options, current, preview=None, note=""):
        rows = [{"cols": [label], "value": value} for value, label in options]
        res = D.pick(self.ui, title, rows, current=current, preview=preview, note=note)
        return res

    def password_dialog(self, title, passphrase=False, note=None):
        fields = [
            {"key": "pw", "label": "Passphrase" if passphrase else "Password", "mask": True, "hint": password_hint},
            {"key": "again", "label": "Confirm", "mask": True, "hint": match_hint},
        ]

        def check(v):
            err = V.password(v["pw"], v["again"])
            return err, "again" if "match" in err else "pw"

        def warn(v):
            notes = V.passphrase_notes(v["pw"]) if passphrase else []
            if strength(v["pw"]) == WEAK:
                notes.append("Weak password: press Enter again to accept it")
            return "; ".join(notes)
        res = D.form(self.ui, title, fields, check=check, warn=warn, note=note)
        return res["pw"] if res else None

    def toggle_item(self, label, get, set_, on="on", off="off", preview=None, missing=None):
        return Item(label, value=lambda: on if get() else off, toggle=lambda: set_(not get()),
                    preview=preview, missing=missing)

    # main menu

    def run(self):
        items = [
            Item("Locales", lambda: S.locale_value(self.c), action=self.locales, preview=self.prev_locales),
            Item("Mirrors and repos", lambda: S.repos_value(self.c), action=self.repos, preview=self.prev_repos),
            Item("Disk configuration", lambda: S.disk_value(self.c, self.p), action=self.disk,
                 preview=self.prev_disk, missing=lambda: bool(self.missing_for("Disk"))),
            Item("Swap", lambda: S.SWAP[self.c.swap].split(" (")[0], action=self.swap, preview=self.prev_swap),
            Item("Bootloader", lambda: S.boot_value(self.c), action=self.boot, preview=self.prev_boot),
            Item("Hostname", lambda: self.c.hostname, action=self.hostname, preview=self.prev_hostname,
                 missing=lambda: bool(self.missing_for("Hostname"))),
            Item("Authentication", lambda: S.auth_value(self.c, self.s), action=self.auth, preview=self.prev_auth,
                 missing=lambda: bool(self.missing_for("Administrator", "Root", "Password for"))),
            Item("SSH server", lambda: S.ssh_value(self.c), action=self.ssh, preview=self.prev_ssh),
            Item("Profile", lambda: S.profile_value(self.c, self.env), action=self.profile, preview=self.prev_profile),
            Item("Services", lambda: S.services_value(self.c), action=self.services, preview=self.prev_services),
            Item("Network", lambda: S.network_value(self.c, self.p, self.online), action=self.network,
                 preview=self.prev_network, missing=lambda: bool(self.missing_for("Internet", "Network"))),
            Item("Additional packages", lambda: S.packages_value(self.c), action=self.packages, preview=self.prev_packages),
            Item("Timezone", lambda: S.time_value(self.c), action=self.timezone, preview=self.prev_time,
                 missing=lambda: bool(self.missing_for("Timezone"))),
            Item("Time sync (NTP)", lambda: S.ntp_value(self.c), action=self.ntp, preview=self.prev_ntp),
            blank(),
            Item("Save configuration", action=self.save, preview=self.prev_save),
            Item("Install", self.install_value, action=self.install, preview=self.prev_install),
            Item("Abort", action=self.abort, preview=lambda: ["Leave the installer. Nothing is written to any disk."]),
        ]
        menu = Menu(self.ui, "", items, main=True)
        try:
            menu.run()
        except Done as d:
            return d.result
        return "abort"

    def install_value(self):
        n = len(self.check()[0])
        return f"{n} missing" if n else "ready"

    # previews

    def prev_locales(self):
        loc = self.c.locale
        return [("LOCALES", "bold"), f"Keyboard  {S.keyboard(self.c)}", f"Console   {data.console_keymap(loc.layout, loc.variant)}",
                f"Language  {data.locale_name(loc.language)}", f"Extra     {', '.join(loc.extra) or 'none'}",
                f"Font      {loc.font}", "", "The keyboard is used at the disk unlock prompt, the login screen and in Sway."]

    def prev_repos(self):
        r = self.c.repos
        out = [("MIRRORS AND REPOSITORIES", "bold"), f"Fedora  {r.fedora or 'mirror list (automatic)'}",
               f"DMS     {r.copr_cache + ' (cache)' if r.copr_cache else 'COPR duxlabs/dms, duxlabs/dux-repo'}",
               f"Testing {'on' if r.testing else 'off'}", "RPM Fusion, Brave, personal repo: on (required)"]
        if self.repo_status:
            out.append("")
            ok = sum(1 for _, good, _ in self.repo_status if good)
            out.append((f"Checked: {ok} of {len(self.repo_status)} ok", "ok" if ok == len(self.repo_status) else "warn"))
            for name, good, secs in self.repo_status:
                if not good:
                    out.append((f"! {name}: not reachable", "warn"))
                elif secs > 3:
                    out.append((f"! {name}: slow ({secs:.1f} s)", "warn"))
        return out

    def prev_disk(self):
        out = S.disk_plan(self.c, self.p, self.p.ram())
        miss = self.missing_for("Disk")
        if miss:
            out += [""] + [(f"* {m}", "err") for m in miss]
        return out

    def prev_swap(self):
        ram = self.p.ram()
        return [("SWAP", "bold"), f"{human(ram)} RAM found", f"Choice: {S.SWAP[self.c.swap]}",
                f"zram size: {human(S.zram_size(self.c, ram))}" if self.c.swap != "none" else "No swap.",
                "", "zram is compressed swap in RAM; nothing is written to disk."]

    def prev_boot(self):
        return [("BOOTLOADER", "bold"), "Loader   GRUB 2 (shim, UEFI)", f"Timeout  {self.c.boot.timeout} s",
                f"Other systems  {'listed (os-prober)' if self.c.boot.os_prober else 'not listed'}",
                f"Kernel args    {kickstart.boot_args(self.c, self.env)}"]

    def prev_hostname(self):
        return [("HOSTNAME", "bold"), self.c.hostname, "", f"Your prompt: {self.c.auth.admin.name or 'user'}@{self.c.hostname}"]

    def prev_auth(self):
        a = self.c.auth
        out = [("AUTHENTICATION", "bold"), f"Full name  {a.admin.fullname}", f"User name  {a.admin.name}",
               (f"Password   {'set' if self.s.admin else 'not set *'}", "normal" if self.s.admin else "err"),
               "Groups     wheel (sudo)", f"Root       {'locked, use sudo' if a.root_locked else 'password'}"]
        for u in a.users:
            out.append(f"User       {u.name} ({'admin' if u.admin else 'standard'})")
        return out

    def prev_ssh(self):
        out = [("SSH SERVER", "bold"), f"SSH  {'on (key-only)' if self.c.ssh.enabled else 'off'}",
               f"Keys {len(self.c.ssh.keys)}", "", "Passwords are never accepted over SSH.",
               "Port 22 opens only when SSH is on."]
        if self.c.ssh.enabled and not self.c.ssh.keys:
            out.append(("! SSH on but no keys", "warn"))
        return out

    def prev_profile(self):
        out = [(S.PROFILE[self.c.profile.lean][0], "bold")] + S.PROFILE[self.c.profile.lean][1:]
        found = self.env.get("nvidia")
        out += ["", f"Graphics: {'NVIDIA found' if found else 'Intel/AMD only'}"]
        if kickstart.wants_nvidia(self.c, self.env):
            out.append("+ Profile 2 (NVIDIA kmod, prime-run) ~15 pkgs")
        out.append("Greeter: DMS greeter (fixed)")
        return out

    def prev_services(self):
        return [("SERVICES", "bold"), f"Bluetooth  {'on' if self.c.services.bluetooth else 'off'}",
                f"Printing   {'on' if self.c.services.printing else 'off'}", "Power      tuned-ppd (fixed)",
                "Firewall   firewalld (LocalSend open, SSH per SSH item)", "Firmware   fwupd (fixed)",
                "", "Off: the service is disabled, not removed."]

    def prev_network(self):
        link = self.p.link()
        out = [("NETWORK", "bold")]
        if self.online:
            out.append(("Installer: online", "ok"))
            if link:
                out.append(f"Link: {link['type']} {link['name']} ({link['device']})")
        else:
            out += [("No internet. Packages come from the network, so Install needs a connection.", "err"),
                    "", "Open this item to connect to Wi-Fi."]
        n = self.c.network
        out += ["", f"Installed system: {'copy connections' if n.installed == 'copy' else 'save nothing'}",
                f"Wired: {'static ' + n.address if n.wired == 'static' else 'DHCP'}"]
        return out

    def prev_packages(self):
        idx = data.pkgindex()
        out = [("ADDITIONAL PACKAGES", "bold"), f"Index: {len(idx)} names" if idx else "No package index on this ISO."]
        for p in self.c.packages:
            out.append(f"  {p}" + ("" if not idx or p in idx else "  (not in index)"))
        if not self.c.packages:
            out.append("None selected.")
        return out

    def prev_time(self):
        z = self.c.time.zone
        out = [("TIMEZONE", "bold"), z, f"{data.utc_offset(z)}   local time now {data.local_time(z)}",
               f"Hardware clock: {'UTC' if self.c.time.utc else 'local time'}"]
        if any(d["windows"] for d in self.p.disks()) and self.c.time.utc and self.c.disk.mode == "alongside":
            out += ["", ("! Windows found: choose local time, or set RealTimeIsUniversal in Windows", "warn")]
        return out

    def prev_ntp(self):
        return [("TIME SYNC", "bold"), f"NTP {'on' if self.c.time.ntp else 'off'}",
                f"Servers: {', '.join(self.c.time.servers) or 'Fedora pool (default)'}"]

    def prev_save(self):
        return [("SAVE CONFIGURATION", "bold"), "Always copied to /root/swaydesk-config.json (mode 0600).",
                "No passwords are saved.", ""] + model.public_json(self.c, self.s).splitlines()

    def prev_install(self):
        missing, warnings = self.check()
        if missing:
            out = [("CANNOT INSTALL YET", "err")] + [(f"- {m}", "err") for m in missing]
        else:
            out = [("READY TO INSTALL", "ok")]
        if warnings:
            out += ["", ("Warnings:", "warn")] + [(f"- {w}", "warn") for w in warnings]
        if not missing:
            out += [""] + [f"{k:<9} {v}" for k, v in S.review(self.c, self.s, self.p, self.env)]
        return out

    # locales

    def locales(self):
        loc = self.c.locale
        Menu(self.ui, "Locales", [
            Item("Keyboard", lambda: loc.layout + (f" ({loc.variant})" if loc.variant else ""), action=self.keyboard,
                 preview=self.prev_locales, reset=lambda: self.set_layout("us", "")),
            Item("Second layout", lambda: loc.layout2 or "none", action=self.keyboard2, preview=lambda: [
                "Optional second layout.", "Switch with Alt+Shift in Sway."], reset=lambda: self.set_layout2("", "")),
            Item("Language", lambda: data.locale_name(loc.language), action=self.language, preview=self.prev_locales,
                 reset=lambda: setattr(loc, "language", "en_US.UTF-8")),
            Item("Extra languages", lambda: ", ".join(loc.extra) or "none", action=self.extra_languages,
                 preview=lambda: ["Installs language packs for these locales too."]),
            Item("Console font", lambda: loc.font, action=self.font, preview=lambda: [
                "Text console font of the installed system.", "large: 16x32 for HiDPI screens", "normal: 8x16"]),
            back(),
        ]).run()

    def layout_rows(self):
        return [{"cols": [l, d], "value": (l, v), "search": f"{l} {v} {d}"} for l, v, d in data.keymaps()]

    def keyboard(self):
        loc = self.c.locale
        res = D.pick(self.ui, "Keyboard layout", self.layout_rows(), current=(loc.layout, loc.variant), typing=True,
                     preview=lambda v: [f"{v[0]}" + (f" ({v[1]})" if v[1] else ""), data.layout_name(*v), "",
                                        "Console keymap:", f"  {data.console_keymap(*v)}", "Applied to this screen now."])
        if res:
            self.set_layout(*res)

    def set_layout(self, layout, variant):
        loc = self.c.locale
        if (layout, variant) == (loc.layout, loc.variant):
            return
        if self.s.admin or self.s.luks or self.s.root or self.s.users:
            if not D.confirm(self.ui, "Keyboard changed", [
                    "Passwords typed with the old layout must be entered again,",
                    "so they work at the unlock prompt with the new layout."], yes="Change", no="Keep old"):
                return
            self.s.admin = self.s.luks = self.s.root = None
            self.s.users = {}
        loc.layout, loc.variant = layout, variant
        self.p.apply_keymap(data.console_keymap(layout, variant))

    def keyboard2(self):
        loc = self.c.locale
        rows = [{"cols": ["none", "no second layout"], "value": ("", "")}] + self.layout_rows()
        res = D.pick(self.ui, "Second keyboard layout", rows, current=(loc.layout2, loc.variant2), typing=True)
        if res:
            self.set_layout2(*res)

    def set_layout2(self, layout, variant):
        self.c.locale.layout2, self.c.locale.variant2 = layout, variant

    def locale_rows(self):
        return [{"cols": [code, name], "value": code} for code, name in data.LOCALES]

    def language(self):
        res = D.pick(self.ui, "Language", self.locale_rows(), current=self.c.locale.language, typing=True,
                     preview=lambda v: [v, data.locale_name(v), "", f"Package {data.langpack(v)}"])
        if res:
            self.c.locale.language = res

    def extra_languages(self):
        res = D.pick(self.ui, "Extra languages", self.locale_rows(), typing=True, multi=self.c.locale.extra)
        if res is not None:
            self.c.locale.extra = sorted(x for x in res if x != self.c.locale.language)

    def font(self):
        res = self.pick_simple("Console font", [("large", "large (16x32, HiDPI)"), ("normal", "normal (8x16)")],
                               self.c.locale.font)
        if res:
            self.c.locale.font = res

    # repos

    def repos(self):
        r = self.c.repos
        Menu(self.ui, "Mirrors and repositories", [
            Item("Fedora source", lambda: "one mirror" if r.fedora else "mirror list", action=self.fedora_source,
                 preview=self.prev_repos, reset=lambda: setattr(r, "fedora", self.defaults["repos"]["fedora"])),
            Item("DMS packages", lambda: "cache" if r.copr_cache else "COPR (duxlabs)", readonly=True,
                 preview=self.prev_repos),
            self.toggle_item("updates-testing", lambda: r.testing, lambda v: setattr(r, "testing", v),
                             preview=lambda: ["Fedora's testing updates. Off unless you test packages."]),
            Item("RPM Fusion", lambda: "on (required)", readonly=True),
            Item("Brave", lambda: "on (required)", readonly=True),
            Item("Personal repo", lambda: "on (required)", readonly=True),
            Item("Check now", action=self.check_repos, preview=self.prev_repos),
            back(),
        ]).run()

    def fedora_source(self):
        r = self.c.repos
        res = self.pick_simple("Fedora source", [("", "Mirror list (automatic)"), ("custom", "One mirror...")],
                               "custom" if r.fedora else "")
        if res == "":
            r.fedora = ""
        elif res == "custom":
            f = D.form(self.ui, "Fedora mirror", [{"key": "url", "label": "URL", "value": r.fedora or "https://",
                                                   "validate": V.mirror_url}],
                       note="Base of releases/ and updates/, e.g. https://host/fedora/linux")
            if f:
                r.fedora = f["url"].rstrip("/")

    def check_repos(self):
        r = self.c.repos
        lines = kickstart.repo_lines(r)
        targets = []
        for line in lines:
            parts = line.split()
            name = "fedora" if parts[0] == "url" else next((p.split("=", 1)[1] for p in parts if p.startswith("--name=")), "?")
            url = next((p.split("=", 1)[1].strip("'") for p in parts if p.startswith(("--url=", "--baseurl=", "--mirrorlist="))), "")
            if "--mirrorlist=" in line:
                targets.append((name, url))
            else:
                targets.append((name, url.rstrip("/") + "/repodata/repomd.xml"))
        self.repo_status = D.loading(self.ui, "Checking repositories...",
                                     lambda: [(n, *self.p.check_url(u)) for n, u in targets])

    # disk

    def disk(self):
        d = self.c.disk
        Menu(self.ui, "Disk configuration", [
            Item("Install type", lambda: "erase disk" if d.mode == "erase" else "alongside", action=self.install_type,
                 preview=self.prev_disk),
            Item("Disk", lambda: S.disk_obj(self.c, self.p) and f"{d.device}  {human(S.disk_obj(self.c, self.p)['size'])}" or "choose",
                 action=self.choose_disk, preview=self.prev_disk, missing=lambda: bool(self.missing_for("Disk"))),
            Item("Filesystem", lambda: d.fs, action=self.filesystem, preview=lambda: [S.FS_NOTE[d.fs]],
                 reset=lambda: setattr(d, "fs", "btrfs")),
            Item("Layout", self.layout_value, action=self.layout, preview=self.prev_disk),
            Item("Linux size", lambda: f"{d.size_gib} GiB" if d.size_gib else "all free space", action=self.linux_size,
                 preview=self.prev_disk, visible=lambda: d.mode == "alongside"),
            Item("Encryption", lambda: ("LUKS2" if d.encrypt else "none") + "  >", action=self.encryption,
                 preview=self.prev_encryption, missing=lambda: bool(self.missing_for("Disk passphrase"))),
            back(),
        ]).run()

    def layout_value(self):
        d = self.c.disk
        if d.fs == "btrfs":
            return "root + home"
        if d.mode == "alongside":
            return "single /"
        return ("LVM" if d.scheme == "lvm" else "plain") + (", /home" if d.home else "")

    def install_type(self):
        res = self.pick_simple("Install type", [("erase", "Erase disk and install"), ("alongside", "Install alongside (free space)")],
                               self.c.disk.mode, preview=lambda v: [
                                   "Erase: the whole disk is wiped." if v == "erase" else
                                   "Alongside: needs 30 GiB free and an EFI partition; other systems are never changed."])
        if res and res != self.c.disk.mode:
            self.c.disk.mode = res
            self.c.disk.device = default_disk(self.c, self.p, self.defaults)

    def disk_rows(self):
        rows = []
        for d in self.p.disks():
            tag = "WINDOWS" if d["windows"] else "WINDOWS BOOT" if d["windows_boot"] else ""
            rows.append({"cols": [d["name"], d["model"] or "-", human(d["size"]), human(d["free"]) if d["free"] else "0",
                                  d["contents"] + (f"  {tag}" if tag else "")], "value": d["name"],
                         "attr": "warn" if d["windows"] else None})
        return rows

    def disk_parts(self, name):
        d = next((x for x in self.p.disks() if x["name"] == name), None)
        if not d:
            return []
        out = [(f"Partitions on {name}  ({d['pttype'] or 'no table'})", "bold")]
        for p in d["parts"]:
            what = ROLE_TEXT.get(p.get("role"), "")
            out.append(f"{p['name']:<12} {human(p['size']):>9}  {p['fstype'] or '-':<10} {what:<18} {p['label'] or p['partlabel']}")
        if not d["parts"]:
            out.append("empty")
        return out

    def choose_disk(self):
        while True:
            rows = self.disk_rows()
            if not rows:
                res = D.choose(self.ui, "No internal disk found", ["Only USB or removable drives were seen."],
                               ["Rescan", "Back"])
                if res == 0:
                    self.p.disks(refresh=True)
                    continue
                return
            res = D.pick(self.ui, "Choose the disk", rows, current=self.c.disk.device,
                         header=["Device", "Model", "Size", "Free", "Contents"], preview=self.disk_parts,
                         preview_pos="bottom", extra_keys=("r",), note="USB and removable drives are not listed.",
                         footer="Enter choose  r rescan  Esc cancel")
            if isinstance(res, D.Extra):
                D.loading(self.ui, "Scanning disks...", lambda: self.p.disks(refresh=True))
                continue
            if res:
                self.c.disk.device = res
            return

    def filesystem(self):
        res = self.pick_simple("Filesystem", [("btrfs", "btrfs (recommended)"), ("ext4", "ext4"), ("xfs", "xfs")],
                               self.c.disk.fs, preview=lambda v: [S.FS_NOTE[v]])
        if res:
            self.c.disk.fs = res

    def layout(self):
        d = self.c.disk
        if d.fs == "btrfs" or d.mode == "alongside":
            D.notify(self.ui, "Layout", ["btrfs uses Fedora's layout: subvolumes root and home, zstd:1 compression."
                                         if d.fs == "btrfs" else "Alongside installs use one / partition."])
            return
        opts = [("lvm:1", "LVM, separate /home"), ("lvm:0", "LVM, no /home"), ("plain:1", "Plain partitions, separate /home"),
                ("plain:0", "Plain partitions, no /home")]
        res = self.pick_simple("Layout", opts, f"{d.scheme}:{int(d.home)}")
        if res:
            scheme, home = res.split(":")
            d.scheme, d.home = scheme, home == "1"

    def linux_size(self):
        d = S.disk_obj(self.c, self.p)
        free = d["free"] if d else 0
        res = self.pick_simple("Linux size", [(0, f"All free space ({free // GIB} GiB)"), (-1, "Custom size...")],
                               0 if not self.c.disk.size_gib else -1)
        if res == 0:
            self.c.disk.size_gib = 0
        elif res == -1:
            f = D.form(self.ui, "Linux size", [{"key": "gib", "label": "Size in GiB",
                                                "value": str(self.c.disk.size_gib or max(V.MIN_LINUX_GIB, free // GIB // 2)),
                                                "validate": lambda v: V.size_gib(v, free)}])
            if f:
                self.c.disk.size_gib = int(f["gib"])

    def prev_encryption(self):
        d = self.c.disk
        out = [("ENCRYPTION", "bold"), "Asked at every power-on, before the system starts.", "",
               f"Keyboard at the prompt: {S.keyboard(self.c)}"]
        if d.encrypt:
            out.append(f"Passphrase: {'separate' if d.separate_pass else 'same as the administrator password'}"
                       f" ({'set' if self.s.luks else 'not set'})")
        else:
            out += ["", ("Off: anyone with the computer can read your files.", "err")]
        return out

    def encryption(self):
        d = self.c.disk
        unlock = {0: "default (about 2 s)", 1000: "1 s", 2000: "2 s", 5000: "5 s", 10000: "10 s"}
        Menu(self.ui, "Disk configuration > Encryption", [
            Item("Encryption", lambda: "LUKS2" if d.encrypt else "none", toggle=self.toggle_encrypt,
                 preview=self.prev_encryption),
            Item("Passphrase", lambda: "separate" if d.separate_pass else "same as admin password",
                 action=self.passphrase, preview=self.prev_encryption, missing=lambda: bool(self.missing_for("Disk passphrase")),
                 visible=lambda: d.encrypt),
            Item("Unlock time", lambda: unlock.get(d.unlock_ms, f"{d.unlock_ms} ms"), action=self.unlock_time,
                 preview=lambda: ["How long the key derivation takes at unlock.", "Longer is harder to brute-force."],
                 visible=lambda: d.encrypt, reset=lambda: setattr(d, "unlock_ms", 0)),
            back(),
        ]).run()

    def toggle_encrypt(self):
        d = self.c.disk
        if d.encrypt:
            if D.confirm(self.ui, "Turn encryption off?", [("Anyone with the computer can read your files.", "err")],
                         yes="Turn off", no="Keep LUKS2"):
                d.encrypt = False
        else:
            d.encrypt = True

    def passphrase(self):
        d = self.c.disk
        res = self.pick_simple("Disk passphrase", [("same", "Same as the administrator password"),
                                                   ("separate", "Separate passphrase...")],
                               "separate" if d.separate_pass else "same")
        if res == "same":
            if d.separate_pass:
                d.separate_pass = False
                self.s.luks = None
                if self.s.admin:
                    D.notify(self.ui, "Disk passphrase", ["Enter the administrator password again to use it for the disk."])
                    self.admin_form()
        elif res == "separate":
            pw = self.password_dialog("Disk passphrase", passphrase=True)
            if pw is not None:
                d.separate_pass = True
                self.s.luks = Secret(pw)

    def unlock_time(self):
        res = self.pick_simple("Unlock time", [(0, "default (about 2 s)"), (1000, "1 s"), (2000, "2 s"),
                                               (5000, "5 s"), (10000, "10 s")], self.c.disk.unlock_ms)
        if res is not None:
            self.c.disk.unlock_ms = res

    # swap, boot, hostname

    def swap(self):
        res = self.pick_simple("Swap", [(k, v) for k, v in S.SWAP.items()], self.c.swap,
                               preview=lambda v: [f"{human(self.p.ram())} RAM found",
                                                  f"zram size: {human(S.zram_size(self._with_swap(v), self.p.ram()))}"
                                                  if v != "none" else "No swap at all.",
                                                  "Nothing is written to disk."])
        if res:
            self.c.swap = res

    def _with_swap(self, v):
        c = model.merge(self.c, {"swap": v})
        return c

    def boot(self):
        b = self.c.boot
        Menu(self.ui, "Bootloader", [
            Item("Loader", lambda: "GRUB 2 (fixed)", readonly=True),
            Item("Menu timeout", lambda: f"{b.timeout} s", action=self.boot_timeout, preview=self.prev_boot,
                 reset=lambda: setattr(b, "timeout", 5)),
            self.toggle_item("Find other systems", lambda: b.os_prober, lambda v: setattr(b, "os_prober", v),
                             preview=lambda: ["os-prober adds Windows and other systems to the GRUB menu."]),
            Item("Extra kernel args", lambda: b.args or "none", action=self.kernel_args, preview=self.prev_boot,
                 reset=lambda: setattr(b, "args", "")),
            back(),
        ]).run()

    def boot_timeout(self):
        res = self.pick_simple("Menu timeout", [(t, f"{t} s") for t in (0, 3, 5, 10)], self.c.boot.timeout)
        if res is not None:
            self.c.boot.timeout = res

    def kernel_args(self):
        f = D.form(self.ui, "Extra kernel arguments", [{"key": "a", "label": "Arguments", "value": self.c.boot.args,
                                                        "validate": V.kernel_args}])
        if f is not None:
            self.c.boot.args = f["a"].strip()

    def hostname(self):
        f = D.form(self.ui, "Hostname", [{"key": "h", "label": "Computer name", "value": self.c.hostname,
                                          "validate": V.hostname}])
        if f:
            self.c.hostname = f["h"]

    # authentication

    def auth(self):
        a = self.c.auth
        Menu(self.ui, "Authentication", [
            Item("Administrator", lambda: a.admin.name or "not set", action=self.admin_form, preview=self.prev_auth,
                 missing=lambda: bool(self.missing_for("Administrator"))),
            Item("Root account", lambda: "locked, use sudo" if a.root_locked else "password", action=self.root,
                 preview=lambda: ["Locked (default): use sudo from the administrator account.",
                                  "A root password allows logging in as root on the console."],
                 missing=lambda: bool(self.missing_for("Root"))),
            Item("Other users", lambda: ", ".join(u.name for u in a.users) or "none", action=self.users,
                 preview=lambda: ["Optional extra accounts.", "They get the system-wide Sway and DMS defaults;",
                                  "the SwayDesk personal setup runs for the administrator."],
                 missing=lambda: bool(self.missing_for("Password for"))),
            back(),
        ]).run()

    def admin_form(self):
        a = self.c.auth.admin
        has = bool(self.s.admin)
        taken = {u.name for u in self.c.auth.users}
        fields = [
            {"key": "full", "label": "Full name", "value": a.fullname, "validate": V.fullname},
            {"key": "name", "label": "User name", "value": a.name, "validate": lambda v: V.username(v, taken)},
            {"key": "pw", "label": "Password", "mask": True, "hint": password_hint},
            {"key": "again", "label": "Confirm", "mask": True, "hint": match_hint},
        ]

        def check(v):
            if has and not v["pw"] and not v["again"]:
                return "", None
            err = V.password(v["pw"], v["again"])
            return err, "again" if "match" in err else "pw"

        def warn(v):
            if v["pw"] and strength(v["pw"]) == WEAK:
                return "Weak password: press Enter again to accept it"
            return ""
        res = D.form(self.ui, "Administrator", fields, check=check, warn=warn,
                     note="Leave the password empty to keep it." if has else None)
        if not res:
            return
        a.fullname, a.name = res["full"], res["name"]
        if res["pw"]:
            h = D.loading(self.ui, "Hashing the password...", lambda: hash_password(res["pw"]))
            model.set_admin_password(self.c, self.s, res["pw"], h)

    def root(self):
        res = self.pick_simple("Root account", [("lock", "Locked, use sudo"), ("pw", "Set a root password...")],
                               "lock" if self.c.auth.root_locked else "pw")
        if res == "lock":
            self.c.auth.root_locked, self.s.root = True, None
        elif res == "pw":
            pw = self.password_dialog("Root password")
            if pw is not None:
                self.s.root = Secret(D.loading(self.ui, "Hashing the password...", lambda: hash_password(pw)))
                self.c.auth.root_locked = False

    def users(self):
        while True:
            us = self.c.auth.users
            rows = [{"cols": [u.name, "admin" if u.admin else "standard", u.fullname], "value": i} for i, u in enumerate(us)]
            rows += [{"cols": ["Add a user"], "value": "add"}, {"cols": ["Done"], "value": "done"}]
            res = D.pick(self.ui, "Other users", rows, current="add")
            if res in (None, "done"):
                return
            if res == "add":
                self.add_user()
                continue
            u = us[res]
            act = D.choose(self.ui, u.name, [f"{u.fullname or u.name}, {'admin' if u.admin else 'standard'}"],
                           ["Change password", "Make standard" if u.admin else "Make admin", "Delete", "Cancel"], 3)
            if act == 0:
                pw = self.password_dialog(f"Password for {u.name}")
                if pw is not None:
                    self.s.users[u.name] = Secret(hash_password(pw))
            elif act == 1:
                u.admin = not u.admin
            elif act == 2:
                self.s.users.pop(u.name, None)
                us.pop(res)

    def add_user(self):
        taken = {u.name for u in self.c.auth.users} | {self.c.auth.admin.name}
        fields = [
            {"key": "name", "label": "User name", "validate": lambda v: V.username(v, taken)},
            {"key": "full", "label": "Full name", "validate": V.fullname},
            {"key": "pw", "label": "Password", "mask": True, "hint": password_hint},
            {"key": "again", "label": "Confirm", "mask": True, "hint": match_hint},
        ]

        def check(v):
            err = V.password(v["pw"], v["again"])
            return err, "again" if "match" in err else "pw"
        res = D.form(self.ui, "Add a user", fields, check=check,
                     warn=lambda v: "Weak password: press Enter again to accept it" if strength(v["pw"]) == WEAK else "")
        if not res:
            return
        admin = D.confirm(self.ui, "Administrator?", [f"May {res['name']} use sudo?"], yes="Admin", no="Standard")
        self.c.auth.users.append(model.User(name=res["name"], fullname=res["full"], admin=admin))
        self.s.users[res["name"]] = Secret(hash_password(res["pw"]))

    # ssh

    def ssh(self):
        Menu(self.ui, "SSH server", self.ssh_items).run()

    def ssh_items(self):
        items = [self.toggle_item("SSH", lambda: self.c.ssh.enabled, lambda v: setattr(self.c.ssh, "enabled", v),
                                  on="on (key-only)", preview=self.prev_ssh)]
        for i, key in enumerate(self.c.ssh.keys):
            info = V.ssh_key(key)[1] or {"type": "?", "comment": "", "fingerprint": "", "bits": 0}
            items.append(Item(info["type"], lambda info=info: info["comment"] or "(no comment)",
                              action=lambda i=i: self.remove_key(i),
                              preview=lambda info=info: ["Fingerprint", info["fingerprint"], "", "Enter removes this key."]))
        return items + [Item("Add: paste a key", action=self.paste_key, preview=lambda: ["Paste one public key line."]),
                        Item("Add: from GitHub", action=self.github_keys,
                             preview=lambda: ["Fetches https://github.com/<name>.keys"]),
                        back()]

    def remove_key(self, i):
        if D.confirm(self.ui, "Remove key", ["Remove this SSH key?"], yes="Remove", no="Keep"):
            self.c.ssh.keys.pop(i)

    def add_key(self, line):
        err, info = V.ssh_key(line)
        if err:
            D.notify(self.ui, "SSH key", [err], "err")
            return False
        if info["line"] in self.c.ssh.keys:
            return False
        if D.confirm(self.ui, "Add this key?", [f"{info['type']} {info['comment']}", info["fingerprint"]],
                     yes="Add", no="Cancel", default_yes=True):
            self.c.ssh.keys.append(info["line"])
            self.c.ssh.enabled = True
            return True
        return False

    def paste_key(self):
        f = D.form(self.ui, "Paste a public key", [{"key": "k", "label": "Key", "validate": lambda v: V.ssh_key(v)[0]}])
        if f:
            self.add_key(f["k"])

    def github_keys(self):
        f = D.form(self.ui, "GitHub user", [{"key": "u", "label": "User name",
                                             "validate": lambda v: "" if v and all(ch.isalnum() or ch == "-" for ch in v) else "a GitHub user name"}])
        if not f:
            return
        text = D.loading(self.ui, "Fetching keys...", lambda: self.p.fetch(f"https://github.com/{f['u']}.keys"))
        keys = [V.ssh_key(l)[1] for l in (text or "").splitlines() if l.strip()]
        keys = [k for k in keys if k and k["line"] not in self.c.ssh.keys]
        if not keys:
            D.notify(self.ui, "GitHub keys", ["No usable keys found (ed25519, ecdsa, sk-*, rsa 3072+)."], "warn")
            return
        rows = [{"cols": [k["type"], k["fingerprint"]], "value": k["line"]} for k in keys]
        res = D.pick(self.ui, f"Keys of {f['u']}", rows, multi=set())
        if res:
            self.c.ssh.keys += [k for k in res if k not in self.c.ssh.keys]
            self.c.ssh.enabled = True

    # profile, services

    def profile(self):
        pr = self.c.profile
        nv = {"auto": "Auto", "1": "always NVIDIA", "0": "never NVIDIA"}
        Menu(self.ui, "Profile", [
            Item("Profile", lambda: "1 Lean" if pr.lean else "3 Full", action=self.choose_profile, preview=self.prev_profile),
            Item("Graphics", lambda: nv[pr.nvidia] + (": NVIDIA found" if pr.nvidia == "auto" and self.env.get("nvidia") else ""),
                 action=self.graphics, preview=self.prev_profile, reset=lambda: setattr(pr, "nvidia", "auto")),
            Item("Greeter", lambda: "DMS greeter (fixed)", readonly=True),
            back(),
        ]).run()

    def choose_profile(self):
        res = self.pick_simple("Profile", [(True, "1 Lean (native apps only)"), (False, "3 Full (developer tools)")],
                               self.c.profile.lean, preview=lambda v: S.PROFILE[v])
        if res is not None:
            self.c.profile.lean = res

    def graphics(self):
        res = self.pick_simple("Graphics", [("auto", "Auto (detect NVIDIA)"), ("1", "Always NVIDIA"), ("0", "Never NVIDIA")],
                               self.c.profile.nvidia, preview=lambda v: [
                                   "NVIDIA found on this computer." if self.env.get("nvidia") else "No NVIDIA GPU found.",
                                   "NVIDIA adds the kmod driver, prime-run and the nouveau blacklist."])
        if res:
            self.c.profile.nvidia = res

    def services(self):
        sv = self.c.services
        Menu(self.ui, "Services", [
            self.toggle_item("Bluetooth", lambda: sv.bluetooth, lambda v: setattr(sv, "bluetooth", v),
                             preview=lambda: ["bluetooth.service", "Off: disabled, not removed."]),
            self.toggle_item("Printing", lambda: sv.printing, lambda v: setattr(sv, "printing", v),
                             preview=lambda: ["cups.service", "Off: disabled, not removed."]),
            Item("Power profiles", lambda: "tuned-ppd (fixed)", readonly=True),
            Item("Firewall", lambda: "on (fixed)", readonly=True),
            Item("Firmware updates", lambda: "fwupd (fixed)", readonly=True),
            back(),
        ]).run()

    # network

    def network(self):
        n = self.c.network
        Menu(self.ui, "Network configuration", [
            Item("Installer link", lambda: S.network_value(self.c, self.p, self.online) + ("" if self.online else "  !"),
                 action=self.connect, preview=self.prev_network, missing=lambda: not self.online),
            Item("Installed system", lambda: "copy connections" if n.installed == "copy" else "save nothing",
                 action=self.net_installed, preview=lambda: ["copy: Wi-Fi and wired settings of the installer are kept.",
                                                             "save nothing: configure the network after the install."]),
            Item("Wired", lambda: "static " + n.address if n.wired == "static" else "DHCP", action=self.wired,
                 preview=self.prev_network, missing=lambda: bool(self.missing_for("Network"))),
            back(),
        ]).run()

    def net_installed(self):
        res = self.pick_simple("Installed system", [("copy", "Copy the installer's connections"), ("none", "Save nothing")],
                               self.c.network.installed)
        if res:
            self.c.network.installed = res

    def connect(self):
        while True:
            nets = D.loading(self.ui, "Scanning for Wi-Fi networks...", self.p.wifi_scan)
            rows = [{"cols": [x["ssid"], "#" * max(1, x["signal"] // 20) + "_" * (5 - max(1, x["signal"] // 20)),
                              x["security"] or "open", "5 GHz" if str(x["freq"]).startswith("5") else "2.4 GHz"],
                     "value": x} for x in nets]
            rows += [{"cols": ["Hidden network..."], "value": "hidden"}, {"cols": ["Scan again"], "value": "scan"},
                     {"cols": ["Check the connection again"], "value": "check"}]
            res = D.pick(self.ui, "Wi-Fi networks", rows, header=["Network", "Signal", "Security", "Band"],
                         note="Wired: plug in the cable, then check again.")
            if res is None:
                return
            if res == "scan":
                continue
            if res == "check":
                D.loading(self.ui, "Checking the connection...", self.refresh_online)
                if self.online:
                    return
                D.notify(self.ui, "Network", ["Still offline."], "warn")
                continue
            hidden = res == "hidden"
            if hidden:
                f = D.form(self.ui, "Hidden network", [{"key": "ssid", "label": "Network name",
                                                        "validate": lambda v: "" if 0 < len(v.encode()) <= 32 else "1-32 bytes"}])
                if not f:
                    continue
                ssid, sec = f["ssid"], "WPA2"
            else:
                ssid, sec = res["ssid"], res["security"]
            pw = ""
            if sec and sec != "open" and sec != "--":
                f = D.form(self.ui, f"Wi-Fi password for {ssid}", [{"key": "pw", "label": "Password", "mask": True,
                                                                     "validate": lambda v: "" if 8 <= len(v) <= 63 else "8-63 characters"}])
                if not f:
                    continue
                pw = f["pw"]
            ok = D.loading(self.ui, f"Connecting to {ssid}...", lambda: self.p.wifi_connect(ssid, pw, sec, hidden))
            D.loading(self.ui, "Checking the connection...", self.refresh_online)
            if ok and self.online:
                D.notify(self.ui, "Network", [f"Connected to {ssid}."], "ok")
                return
            D.notify(self.ui, "Network", [f"Could not connect to {ssid} (wrong password?)."], "err")

    def wired(self):
        n = self.c.network
        res = self.pick_simple("Wired", [("dhcp", "DHCP (automatic)"), ("static", "Static address...")], n.wired)
        if res == "dhcp":
            n.wired = "dhcp"
        elif res == "static":
            devs = self.p.wired_devices()
            f = D.form(self.ui, "Static address", [
                {"key": "device", "label": "Device", "value": n.device or (devs[0] if devs else ""),
                 "validate": lambda v: "" if v and (not devs or v in devs) else "one of: " + ", ".join(devs)},
                {"key": "address", "label": "Address/prefix", "value": n.address, "validate": V.ipv4_cidr},
                {"key": "gateway", "label": "Gateway", "value": n.gateway, "validate": V.ipv4},
                {"key": "dns", "label": "DNS servers", "value": n.dns, "validate": V.dns_list},
            ], check=lambda v: (V.gateway(v["gateway"], v["address"]), "gateway"))
            if f:
                n.wired, n.device, n.address, n.gateway, n.dns = "static", f["device"], f["address"], f["gateway"], f["dns"]

    # packages

    def packages(self):
        idx = data.pkgindex()
        rows = [{"cols": [name, info["summary"]], "value": name} for name, info in sorted(idx.items())]
        for p in self.c.packages:
            if p not in idx:
                rows.append({"cols": [p, "(not in the index)"], "value": p})

        def prev(name):
            info = idx.get(name)
            if not info:
                return [name, "", "Not in the index: installed after setup, best effort."]
            return [f"{name}  ({info['repo']})", "", info["summary"], "", f"Download {human(info['size'])}"]
        res = D.pick(self.ui, "Additional packages", rows, typing=True, multi=self.c.packages, preview=prev,
                     add=V.package)
        if res is not None:
            self.c.packages = sorted(res)

    # time

    def timezone(self):
        t = self.c.time
        Menu(self.ui, "Timezone", [
            Item("Timezone", lambda: t.zone, action=self.choose_zone, preview=self.prev_time,
                 reset=lambda: setattr(t, "zone", self.defaults["time"]["zone"])),
            self.toggle_item("Hardware clock", lambda: t.utc, lambda v: setattr(t, "utc", v), on="UTC", off="local time",
                             preview=self.prev_time),
            back(),
        ]).run()

    def choose_zone(self):
        rows = []
        for z, country in data.zones():
            off = data.utc_offset(z)
            rows.append({"cols": [z, country, off], "value": z, "search": f"{z} {country} {off}"})
        res = D.pick(self.ui, "Timezone", rows, current=self.c.time.zone, typing=True,
                     preview=lambda z: [z, f"Local time now  {data.local_time(z)}", data.utc_offset(z)])
        if res:
            self.c.time.zone = res

    def ntp(self):
        t = self.c.time
        Menu(self.ui, "Time sync", [
            self.toggle_item("NTP", lambda: t.ntp, lambda v: setattr(t, "ntp", v), preview=self.prev_ntp),
            Item("Servers", lambda: ", ".join(t.servers) or "Fedora pool", action=self.ntp_servers, preview=self.prev_ntp,
                 reset=lambda: setattr(t, "servers", [])),
            back(),
        ]).run()

    def ntp_servers(self):
        def check(v):
            for s in v.replace(",", " ").split():
                e = V.ntp_server(s)
                if e:
                    return f"{s}: {e}"
            return ""
        f = D.form(self.ui, "NTP servers", [{"key": "s", "label": "Servers", "value": " ".join(self.c.time.servers),
                                             "validate": check}], note="Space separated; empty for the Fedora pool.")
        if f is not None:
            self.c.time.servers = f["s"].replace(",", " ").split()

    # save, install, abort

    def save(self):
        Menu(self.ui, "Save configuration", [
            Item("Installed system", lambda: "/root (automatic)", readonly=True),
            Item("View", action=lambda: D.text_view(self.ui, "Configuration", model.public_json(self.c, self.s).splitlines()),
                 preview=self.prev_save),
            Item("USB stick", action=self.save_usb, preview=self.prev_save),
            back(),
        ]).run()

    def save_usb(self):
        parts = self.p.removable_partitions()
        if not parts:
            D.notify(self.ui, "USB stick", ["No USB stick with a vfat, exfat or ext4 partition found."], "warn")
            return
        rows = [{"cols": [p["name"], p["label"], p["model"]], "value": p["name"]} for p in parts]
        res = D.pick(self.ui, "Save to", rows, header=["Partition", "Label", "Model"])
        if res:
            ok = D.loading(self.ui, "Saving...", lambda: self.p.save_to(res, "swaydesk-config.json",
                                                                         model.public_json(self.c, self.s)))
            D.notify(self.ui, "USB stick", ["Saved swaydesk-config.json." if ok else "Could not save."], "ok" if ok else "err")

    def install(self):
        D.loading(self.ui, "Checking the connection...", self.refresh_online)
        missing, warnings = self.check()
        if missing:
            D.notify(self.ui, "Cannot install yet", [("Missing:", "err")] + [(f"- {m}", "err") for m in missing])
            return
        if self.review(warnings) and D.countdown(self.ui):
            raise Done("install")

    def review(self, warnings):
        word = S.confirm_word(self.c, self.p)
        d = S.disk_obj(self.c, self.p)
        field = TextField("", width=len(word) + 4)
        focus, err = 0, ""
        lines = S.review(self.c, self.s, self.p, self.env)
        prompt = f"Type {word} to erase {d['name']}:" if word.startswith("WIPE") else f"Type {word} to install on {d['name']}:"

        def draw():
            c = self.ui.c
            top, bottom = self.ui.frame("Review", footer="Enter confirm  Tab move  F2 kickstart (secrets hidden)  Esc back")
            c.hline(top, 0, c.w)
            c.hline(bottom, 0, c.w)
            y = top + 2
            for k, v in lines:
                for i, (t, _) in enumerate(wrap([v], c.w - 16)):
                    c.put(y, 2, k if i == 0 else "", "bold")
                    c.put(y, 14, t, "err" if "ERASED" in t or "UNENCRYPTED" in t else "normal")
                    y += 1
            y += 1
            for w in warnings:
                c.put(y, 2, f"! {w}"[:c.w - 4], "warn")
                y += 1
            y = max(y + 1, bottom - 3)
            c.put(y, 2, prompt, "bold")
            fx = 4 + len(prompt)
            c.put(y, fx + field.width + 4, "< Install >", "sel" if focus == 1 else "normal")
            c.put(y, fx + field.width + 18, "< Back >", "sel" if focus == 2 else "normal")
            if err:
                c.put(y + 1, 2, err, "err")
            field.draw(c, y, fx, focus == 0)
            if focus:
                c.hide_cursor()
            c.refresh()
        self.ui.push(draw)
        try:
            while True:
                draw()
                k = self.ui.c.getkey()
                if k == "esc" or (k == "enter" and focus == 2):
                    return False
                if k == "f2":
                    files = kickstart.render(self.c, self.s, self.p, self.env, hide=True)
                    view = []
                    for name, text in files.items():
                        view += [(f"# {name}", "bold")] + text.splitlines() + [""]
                    D.text_view(self.ui, "Kickstart (secrets hidden)", view)
                elif k in ("tab", "right"):
                    focus = (focus + 1) % 3
                elif k in ("btab", "left") and focus:
                    focus = (focus - 1) % 3
                elif k == "enter":
                    if field.value.strip() == word:
                        return True
                    err, focus = f"Type {word} exactly to continue.", 0
                elif focus == 0 and field.key(k):
                    err = ""
        finally:
            self.ui.pop()

    def abort(self):
        res = D.choose(self.ui, "Abort the installation?", ["Nothing was written to any disk."],
                       ["Power off", "Reboot", "Shell", "Cancel"], 3)
        if res in (0, 1, 2):
            raise Done("abort:" + ("poweroff", "reboot", "shell")[res])


def default_disk(config, probe, defaults):
    disks = probe.disks()
    if not disks:
        return ""
    if config.disk.mode == "alongside":
        return max(disks, key=lambda d: d["free"])["name"]
    pref = probe.preferred_disk(defaults.get("disk_by_id", ""))
    if pref and any(d["name"] == pref for d in disks):
        return pref
    plain = [d for d in disks if not d["windows"]]
    return (plain or disks)[0]["name"]
