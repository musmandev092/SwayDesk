import ipaddress
import os
import shlex

from . import data

RELEASE = "45"
EXCLUDE = "quickshell,danksearch,dgop,matugen"
ML_FEDORA = "https://mirrors.fedoraproject.org/mirrorlist?repo={}&arch=x86_64&protocol=https"
ML_FUSION = "https://mirrors.rpmfusion.org/mirrorlist?repo={}&arch=x86_64"
COPR = "https://download.copr.fedorainfracloud.org/results/avengemedia/{}/fedora-" + RELEASE + "-x86_64/"
NVIDIA_ARGS = "rd.driver.blacklist=nouveau,nova_core modprobe.blacklist=nouveau,nova_core nvidia-drm.modeset=1 nvidia-drm.fbdev=1"
SERIAL_ARGS = "console=tty0 console=ttyS0,115200"
HIDDEN = "********"

q = shlex.quote


def opt(name, value):
    return f"--{name}={q(str(value))}"


def wants_nvidia(config, env):
    return config.profile.nvidia == "1" or (config.profile.nvidia == "auto" and env.get("nvidia"))


def repo_lines(r):
    out = []
    if r.fedora:
        m = r.fedora.rstrip("/")
        out.append(f"url {opt('url', f'{m}/releases/{RELEASE}/Everything/x86_64/os/')}")
        out.append(f"repo --name=fedora-updates {opt('baseurl', f'{m}/updates/{RELEASE}/Everything/x86_64/')} --excludepkgs={EXCLUDE}")
        if r.testing:
            out.append(f"repo --name=fedora-updates-testing {opt('baseurl', f'{m}/updates/testing/{RELEASE}/Everything/x86_64/')} --excludepkgs={EXCLUDE}")
    else:
        out.append(f"url {opt('mirrorlist', ML_FEDORA.format('fedora-' + RELEASE))}")
        out.append(f"repo --name=fedora-updates {opt('mirrorlist', ML_FEDORA.format('updates-released-f' + RELEASE))} --excludepkgs={EXCLUDE}")
        if r.testing:
            out.append(f"repo --name=fedora-updates-testing {opt('mirrorlist', ML_FEDORA.format('updates-testing-f' + RELEASE))} --excludepkgs={EXCLUDE}")
    for name, ml in (("rpmfusion-free", "free-fedora-"), ("rpmfusion-free-updates", "free-fedora-updates-released-"),
                     ("rpmfusion-nonfree", "nonfree-fedora-"), ("rpmfusion-nonfree-updates", "nonfree-fedora-updates-released-")):
        out.append(f"repo --name={name} {opt('mirrorlist', ML_FUSION.format(ml + RELEASE))}")
    out.append("repo --name=brave-browser --baseurl=https://brave-browser-rpm-release.s3.brave.com/x86_64")
    for name in ("dms", "danklinux"):
        if r.dms:
            url = r.dms.rstrip("/") + "/"
        elif r.copr_cache:
            url = f"{r.copr_cache.rstrip('/')}/{name}/"
        else:
            url = COPR.format(name)
        out.append(f"repo --name={name} {opt('baseurl', url)}")
    out.append("repo --name=claude-desktop --baseurl=https://musmandev092.github.io/claude-desktop-rpm/repo")
    return out


def encrypt_opts(config, secrets, hide):
    if not config.disk.encrypt:
        return ""
    pw = HIDDEN if hide else (secrets.luks.reveal() if secrets.luks else "")
    s = f" --encrypted --luks-version=luks2 --pbkdf=argon2id {opt('passphrase', pw)}"
    if config.disk.unlock_ms:
        s += f" --pbkdf-time={int(config.disk.unlock_ms)}"
    return s


def disk_lines(config, secrets, probe, hide):
    d = config.disk
    dev = d.device
    enc = encrypt_opts(config, secrets, hide)
    out = [f"ignoredisk --only-use={dev}"]
    if d.mode == "erase":
        out += ["zerombr", f"clearpart --all --initlabel --drives={dev}"]
        if d.fs == "btrfs":
            out.append(f"autopart --type=btrfs --noswap{enc}")
        else:
            home = "" if d.home else " --nohome"
            out.append(f"autopart --type={d.scheme} --fstype={d.fs}{home} --noswap{enc}")
        return out
    disk = next((x for x in probe.disks() if x["name"] == dev), None)
    esp = disk["esp"] if disk else ""
    size = f"--size={d.size_gib * 1024}" if d.size_gib else "--size=1 --grow"
    out += ["clearpart --none",
            f"part /boot/efi --fstype=efi --onpart={esp} --noformat",
            f"part /boot --fstype=ext4 --size=2048 --ondisk={dev}"]
    if d.fs == "btrfs":
        out += [f"part btrfs.01 {size} --ondisk={dev}{enc}",
                "btrfs none --label=fedora btrfs.01",
                "btrfs / --subvol --name=root LABEL=fedora",
                "btrfs /home --subvol --name=home LABEL=fedora"]
    else:
        out.append(f"part / --fstype={d.fs} {size} --ondisk={dev}{enc}")
    return out


def keyboard_line(config):
    loc = config.locale
    items = [f"{loc.layout} ({loc.variant})" if loc.variant else loc.layout]
    if loc.layout2:
        items.append(f"{loc.layout2} ({loc.variant2})" if loc.variant2 else loc.layout2)
    line = f"keyboard --vckeymap={q(data.console_keymap(loc.layout, loc.variant))} {opt('xlayouts', ','.join(items))}"
    if loc.layout2:
        line += " --switch=grp:alt_shift_toggle"
    return line


def boot_args(config, env):
    args = ["fbcon=font:TER16x32"]
    if wants_nvidia(config, env):
        args.append(NVIDIA_ARGS)
    if env.get("vm"):
        args.append(SERIAL_ARGS)
    if config.boot.args:
        args.append(config.boot.args)
    return " ".join(args)


def machine(config, secrets, probe, env, hide=False):
    c = config
    lines = []
    lang = f"lang {q(c.locale.language)}"
    extra = [x for x in c.locale.extra if x != c.locale.language]
    if extra:
        lang += f" {opt('addsupport', ','.join(extra))}"
    lines += [lang, keyboard_line(c), f"timezone {q(c.time.zone)}" + (" --utc" if c.time.utc else "")]
    if not c.time.ntp:
        lines.append("timesource --ntp-disable")
    else:
        lines += [f"timesource {opt('ntp-server', s)}" for s in c.time.servers]
    n = c.network
    if n.wired == "static":
        iface = ipaddress.IPv4Interface(n.address)
        dns = ",".join(x for x in n.dns.replace(",", " ").split() if x)
        lines.append(f"network --device={q(n.device)} --bootproto=static --ip={iface.ip} --netmask={iface.netmask} "
                     f"--gateway={n.gateway} --nameserver={dns} --activate --hostname={q(c.hostname)}")
    else:
        lines.append(f"network --bootproto=dhcp --activate --hostname={q(c.hostname)}")
    if c.auth.root_locked or not secrets.root:
        lines.append("rootpw --lock")
    else:
        lines.append(f"rootpw --iscrypted {q(HIDDEN if hide else secrets.root.reveal())}")
    users = [c.auth.admin] + list(c.auth.users)
    for i, u in enumerate(users):
        h = secrets.admin if i == 0 else secrets.users.get(u.name)
        line = f"user {opt('name', u.name)}"
        if u.fullname:
            line += f" {opt('gecos', u.fullname)}"
        if i == 0 or u.admin:
            line += " --groups=wheel"
        line += f" --iscrypted {opt('password', HIDDEN if hide else (h.reveal() if h else ''))}"
        lines.append(line)
    if c.ssh.enabled:
        for key in c.ssh.keys:
            lines.append(f"sshkey {opt('username', c.auth.admin.name)} {q(key)}")
    disabled = [s for s, on in (("bluetooth", c.services.bluetooth), ("cups", c.services.printing)) if not on]
    if disabled:
        lines.append(f"services --disabled={','.join(disabled)}")
    lines += disk_lines(c, secrets, probe, hide)
    lines.append(f"bootloader --timeout={int(c.boot.timeout)} {opt('append', boot_args(c, env))}")
    lines += repo_lines(c.repos)
    lines.append("reboot --eject")
    return "\n".join(lines) + "\n"


def packages(config):
    idx = data.pkgindex()
    out = []
    for loc in [config.locale.language] + list(config.locale.extra):
        p = data.langpack(loc)
        if p != "glibc-langpack-en" and p not in out:
            out.append(p)
    out.append("-zram-generator-defaults" if config.swap == "none" else "zram-generator-defaults")
    out += [p for p in config.packages if not idx or p in idx]
    return "\n".join(out) + "\n"


def unknown_packages(config):
    idx = data.pkgindex()
    return [p for p in config.packages if idx and p not in idx]


def choices(config, env):
    loc = config.locale
    layouts = loc.layout + ("," + loc.layout2 if loc.layout2 else "")
    variants = loc.variant + ("," + loc.variant2 if loc.layout2 else "")
    vals = {
        "PRESET": config.preset,
        "ADMIN": config.auth.admin.name,
        "LEAN": "1" if config.profile.lean else "0",
        "SSHD": "1" if config.ssh.enabled else "0",
        "NVIDIA": config.profile.nvidia,
        "XKB_LAYOUT": layouts,
        "XKB_VARIANT": variants if variants.strip(",") else "",
        "XKB_OPTIONS": "grp:alt_shift_toggle" if loc.layout2 else "",
        "ZRAM": config.swap,
        "OS_PROBER": "1" if config.boot.os_prober else "0",
        "FONT": loc.font,
        "NETCOPY": "1" if config.network.installed == "copy" else "0",
        "TESTING": "1" if config.repos.testing else "0",
        "EXTRA_PKGS": " ".join(unknown_packages(config)),
    }
    return "".join(f"{k}={q(v)}\n" for k, v in vals.items())


def render(config, secrets, probe, env, hide=False):
    return {
        "ks-machine.cfg": machine(config, secrets, probe, env, hide),
        "ks-packages.cfg": packages(config),
        "choices.env": choices(config, env),
    }


def reparse(files):
    try:
        from pykickstart.parser import KickstartParser
        from pykickstart.version import makeVersion
    except ImportError:
        return ""
    try:
        parser = KickstartParser(makeVersion())
        parser.readKickstartFromString(files["ks-machine.cfg"])
        parser = KickstartParser(makeVersion())
        parser.readKickstartFromString("%packages\n" + files["ks-packages.cfg"] + "%end\n")
    except Exception as e:
        return str(e).replace("\n", " ")
    return ""


def write(files, outdir, extra=None):
    os.makedirs(outdir, mode=0o700, exist_ok=True)
    os.chmod(outdir, 0o700)
    for name, text in {**files, **(extra or {})}.items():
        path = os.path.join(outdir, name)
        fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(path + ".tmp", path)
