import base64
import io
import json
import os
import shutil
import struct
import tempfile
import unittest

from helpers import ED25519, config, env, probe
from sdsetup import answers, data, kickstart, model, validate as V
from sdsetup.probe import classify, write_wifi_keyfile, _split_nm
from sdsetup.secret import MODERATE, STRONG, WEAK, Secret, hash_password, strength, verify_password
from sdsetup.ui_text import TextUI


class SecretTest(unittest.TestCase):
    def test_repr_hides_value(self):
        s = Secret("hunter2")
        self.assertEqual(repr(s), "***")
        self.assertEqual(str(s), "***")
        self.assertNotIn("hunter2", repr(model.Secrets()))
        self.assertEqual(s.reveal(), "hunter2")

    def test_strength_table(self):
        self.assertEqual(strength("test"), WEAK)
        self.assertEqual(strength("Abcdefgh1!xyz"), STRONG)
        self.assertEqual(strength("Abcdefgh1!x"), MODERATE)
        self.assertEqual(strength("abcdefghijklmnopqr"), STRONG)
        self.assertEqual(strength("abcdefghijklmn"), MODERATE)
        self.assertEqual(strength("abcdefghijklm"), WEAK)

    def test_hash_is_yescrypt_and_verifies(self):
        h = hash_password("p'a\"ss $word")
        self.assertTrue(h.startswith("$y$") or h.startswith("$6$"))
        self.assertNotIn("word", h)
        if h.startswith("$y$"):
            self.assertTrue(verify_password("p'a\"ss $word", h))
            self.assertFalse(verify_password("other", h))


class ValidateTest(unittest.TestCase):
    def test_hostname(self):
        self.assertEqual(V.hostname("USAY-Linux"), "")
        for bad in ("", "-a", "a-", "a" * 64, "a_b", "a.b"):
            self.assertTrue(V.hostname(bad), bad)

    def test_username(self):
        self.assertEqual(V.username("musmandev092"), "")
        self.assertTrue(V.username("root"))
        self.assertTrue(V.username("Bad"))
        self.assertTrue(V.username("a" * 33))
        self.assertTrue(V.username("sara", taken={"sara"}))

    def test_fullname_allows_unicode_and_quotes(self):
        self.assertEqual(V.fullname('Muhammad "Usman" O\'Neil \\ محمد'), "")
        self.assertTrue(V.fullname("a:b"))
        self.assertTrue(V.fullname("a\nb"))

    def test_password(self):
        self.assertEqual(V.password("test", "test"), "")
        self.assertTrue(V.password("abc", "abc"))
        self.assertTrue(V.password("abcd", "abce"))
        self.assertEqual(V.password('a"b\\c', 'a"b\\c'), "")

    def test_urls_and_args(self):
        self.assertEqual(V.mirror_url("https://ix-denver.mm.fcix.net/fedora/linux"), "")
        self.assertTrue(V.mirror_url("http://x"))
        self.assertTrue(V.mirror_url("https://x/$(id)"))
        self.assertEqual(V.kernel_args("quiet splash i915.enable_psr=0"), "")
        self.assertTrue(V.kernel_args('a="b"'))
        self.assertTrue(V.kernel_args("a;reboot"))

    def test_network(self):
        self.assertEqual(V.ipv4_cidr("192.168.1.20/24"), "")
        self.assertTrue(V.ipv4_cidr("192.168.1.20"))
        self.assertEqual(V.gateway("192.168.1.1", "192.168.1.20/24"), "")
        self.assertTrue(V.gateway("10.0.0.1", "192.168.1.20/24"))
        self.assertEqual(V.dns_list("1.1.1.1, 9.9.9.9"), "")
        self.assertTrue(V.dns_list("dns.example"))

    def test_ssh_keys(self):
        err, info = V.ssh_key(ED25519)
        self.assertEqual(err, "")
        self.assertEqual(info["type"], "ed25519")
        self.assertTrue(info["fingerprint"].startswith("SHA256:"))
        self.assertEqual(info["comment"], "laptop@home")
        def blob(*parts):
            return b"".join(struct.pack(">I", len(x)) + x for x in parts)
        n = ((1 << 1023) | 1).to_bytes(128, "big")
        rsa1024 = "ssh-rsa " + base64.b64encode(blob(b"ssh-rsa", b"\x01\x00\x01", b"\x00" + n)).decode()
        self.assertIn("3072", V.ssh_key(rsa1024)[0])
        n = ((1 << 4095) | 1).to_bytes(512, "big")
        rsa4096 = "ssh-rsa " + base64.b64encode(blob(b"ssh-rsa", b"\x01\x00\x01", b"\x00" + n)).decode()
        self.assertEqual(V.ssh_key(rsa4096)[1]["bits"], 4096)
        self.assertTrue(V.ssh_key("ssh-dss AAAA")[0])
        self.assertTrue(V.ssh_key("ssh-ed25519 !!!")[0])

    def test_check_reports_missing(self):
        c, s, p = config()
        missing, _ = V.check(c, s, p)
        self.assertIn("Administrator password", missing)
        self.assertTrue(any(m.startswith("Disk passphrase") for m in missing))
        model.set_admin_password(c, s, "test", hash_password("test"))
        missing, _ = V.check(c, s, p)
        self.assertEqual(missing, [])

    def test_alongside_checks(self):
        c, s, p = config("dualboot", "dualboot")
        model.set_admin_password(c, s, "test", hash_password("test"))
        p.data["online"] = False
        missing, warnings = V.check(c, s, p)
        self.assertEqual(c.disk.device, "nvme1n1")
        self.assertIn("Internet connection (Network configuration)", missing)
        self.assertTrue(any("BitLocker" in w for w in warnings))
        self.assertTrue(any("EFI partition is small" in w for w in warnings))
        c.disk.size_gib = 500
        self.assertTrue(any("more than the free space" in m for m in V.check(c, s, p)[0]))

    def test_windows_detection(self):
        d = classify(dict(probe("dualboot").data["disks"][0]))
        self.assertTrue(d["windows"])
        self.assertTrue(d["bitlocker"])
        self.assertEqual(d["esp"], "nvme1n1p1")


class ModelTest(unittest.TestCase):
    def test_public_json_has_no_secrets(self):
        c, s, p = config()
        model.set_admin_password(c, s, "s3cret-pass", hash_password("s3cret-pass"))
        text = model.public_json(c, s)
        self.assertNotIn("s3cret-pass", text)
        self.assertNotIn("$y$", text)
        d = json.loads(text)
        self.assertEqual(d["auth"]["admin"]["password"], "set")
        self.assertEqual(d["disk"]["passphrase"], "set")

    def test_roundtrip(self):
        c, s, p = config()
        c.auth.users.append(model.User("sara", "Sara", False))
        c2 = model.from_dict(json.loads(model.public_json(c, s)))
        self.assertEqual(c2.auth.users[0].name, "sara")
        self.assertEqual(c2.hostname, c.hostname)

    def test_defaults_and_presets(self):
        c, s, p = config("dualboot", "dualboot", build={"lean": False, "fedora": "https://m.example/fedora/linux"})
        self.assertEqual(c.disk.mode, "alongside")
        self.assertFalse(c.profile.lean)
        self.assertEqual(c.repos.fedora, "https://m.example/fedora/linux")
        self.assertEqual(c.hostname, "USAY-Linux")


def ready(name="vm", preset="clean"):
    c, s, p = config(name, preset)
    model.set_admin_password(c, s, "test", hash_password("test"))
    return c, s, p


class KickstartTest(unittest.TestCase):
    def test_erase_default(self):
        c, s, p = ready()
        files = kickstart.render(c, s, p, env(p))
        m = files["ks-machine.cfg"]
        self.assertIn("ignoredisk --only-use=vda", m)
        self.assertIn("clearpart --all --initlabel --drives=vda", m)
        self.assertIn("autopart --type=btrfs --noswap --encrypted --luks-version=luks2 --pbkdf=argon2id --passphrase=test", m)
        self.assertIn("rootpw --lock", m)
        self.assertIn("user --name=musmandev092 --gecos='Muhammad Usman' --groups=wheel --iscrypted", m)
        self.assertIn("network --bootproto=dhcp --activate --hostname=USAY-Linux", m)
        self.assertIn("console=ttyS0,115200", m)
        self.assertNotIn("nouveau", m)
        self.assertIn("timezone Asia/Karachi --utc", m)
        self.assertIn("reboot --eject", m)
        self.assertIn("url --mirrorlist='https://mirrors.fedoraproject.org/mirrorlist?repo=fedora-45", m)
        self.assertEqual(kickstart.reparse(kickstart.render(c, s, p, env(p), hide=True)), "")
        self.assertIn("zram-generator-defaults", files["ks-packages.cfg"])
        self.assertIn("LEAN=1", files["choices.env"])

    def test_hidden_render_has_no_secrets(self):
        c, s, p = ready()
        files = kickstart.render(c, s, p, env(p), hide=True)
        text = "".join(files.values())
        self.assertNotIn("passphrase=test", text)
        self.assertNotIn("$y$", text)

    def test_quoting_of_hostile_values(self):
        c, s, p = ready()
        c.auth.admin.fullname = "O'Neil \"#1\" \\ x"
        s.luks = Secret("pa ss'#\"$`x")
        m = kickstart.render(c, s, p, env(p))["ks-machine.cfg"]
        try:
            from pykickstart.parser import KickstartParser
            from pykickstart.version import makeVersion
        except ImportError:
            self.skipTest("pykickstart missing")
        h = makeVersion()
        KickstartParser(h).readKickstartFromString(m)
        self.assertEqual(h.user.userList[0].gecos, "O'Neil \"#1\" \\ x")
        self.assertEqual(h.autopart.passphrase, "pa ss'#\"$`x")

    def test_alongside_btrfs(self):
        c, s, p = ready("dualboot", "dualboot")
        c.disk.size_gib = 120
        m = kickstart.render(c, s, p, env(p))["ks-machine.cfg"]
        self.assertIn("clearpart --none", m)
        self.assertIn("part /boot/efi --fstype=efi --onpart=nvme1n1p1 --noformat", m)
        self.assertIn("part btrfs.01 --size=122880 --ondisk=nvme1n1 --encrypted", m)
        self.assertIn("btrfs /home --subvol --name=home LABEL=fedora", m)
        self.assertNotIn("zerombr", m)

    def test_ext4_plain_unencrypted_static_and_extras(self):
        c, s, p = ready("dell7770")
        c.disk.fs, c.disk.scheme, c.disk.home, c.disk.encrypt = "ext4", "plain", False, False
        c.network.wired, c.network.device = "static", "enp0s31f6"
        c.network.address, c.network.gateway, c.network.dns = "192.168.1.20/24", "192.168.1.1", "1.1.1.1 9.9.9.9"
        c.locale.layout, c.locale.variant, c.locale.layout2 = "de", "nodeadkeys", "us"
        c.locale.extra = ["ur_PK.UTF-8"]
        c.services.printing = False
        c.ssh.enabled, c.ssh.keys = True, [ED25519]
        c.auth.root_locked = False
        s.root = Secret(hash_password("rootpw"))
        c.auth.users.append(model.User("sara", "Sara", True))
        s.users["sara"] = Secret(hash_password("sarapw"))
        c.time.utc, c.time.ntp = False, False
        c.swap = "none"
        files = kickstart.render(c, s, p, env(p))
        m = files["ks-machine.cfg"]
        self.assertIn("autopart --type=plain --fstype=ext4 --nohome --noswap\n", m)
        self.assertIn("--bootproto=static --ip=192.168.1.20 --netmask=255.255.255.0 --gateway=192.168.1.1 --nameserver=1.1.1.1,9.9.9.9", m)
        self.assertIn("--vckeymap=de-nodeadkeys --xlayouts='de (nodeadkeys),us' --switch=grp:alt_shift_toggle", m)
        self.assertIn("lang en_US.UTF-8 --addsupport=ur_PK.UTF-8", m)
        self.assertIn("services --disabled=cups", m)
        self.assertIn("sshkey --username=musmandev092 'ssh-ed25519 ", m)
        self.assertIn("rootpw --iscrypted", m)
        self.assertIn("user --name=sara --gecos=Sara --groups=wheel", m)
        self.assertIn("timezone Asia/Karachi\n", m)
        self.assertIn("timesource --ntp-disable", m)
        self.assertIn("nouveau", m)
        self.assertNotIn("ttyS0", m)
        self.assertIn("-zram-generator-defaults", files["ks-packages.cfg"])
        self.assertIn("glibc-langpack-ur", files["ks-packages.cfg"])
        self.assertIn("SSHD=1", files["choices.env"])
        self.assertIn("XKB_LAYOUT=de,us", files["choices.env"])
        self.assertEqual(kickstart.reparse(kickstart.render(c, s, p, env(p), hide=True)), "")

    def test_mirrors(self):
        c, s, p = ready()
        c.repos.fedora = "https://ix-denver.mm.fcix.net/fedora/linux"
        c.repos.dms = "https://musmandev092.github.io/dux-shell-rpm/repo"
        c.repos.testing = True
        m = kickstart.render(c, s, p, env(p))["ks-machine.cfg"]
        self.assertIn("url --url=https://ix-denver.mm.fcix.net/fedora/linux/releases/45/Everything/x86_64/os/", m)
        self.assertIn("repo --name=fedora-updates-testing --baseurl=https://ix-denver.mm.fcix.net/fedora/linux/updates/testing/45/", m)
        self.assertIn("repo --name=dms --baseurl=https://musmandev092.github.io/dux-shell-rpm/repo/", m)

    def test_write_modes(self):
        c, s, p = ready()
        d = tempfile.mkdtemp()
        try:
            out = os.path.join(d, "sd")
            kickstart.write(kickstart.render(c, s, p, env(p)), out)
            self.assertEqual(os.stat(out).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(os.path.join(out, "ks-machine.cfg")).st_mode & 0o777, 0o600)
        finally:
            shutil.rmtree(d)


class AnswersTest(unittest.TestCase):
    def test_apply(self):
        c, s, p = config()
        c, silent = answers.apply(c, s, {"silent": True, "config": {"hostname": "vmtest", "auth": {"admin": {"name": "test"}}},
                                         "secrets": {"admin_password": "test"}})
        self.assertTrue(silent)
        self.assertEqual(c.hostname, "vmtest")
        self.assertEqual(c.auth.admin.name, "test")
        self.assertEqual(c.auth.admin.fullname, "Muhammad Usman")
        self.assertEqual(s.luks.reveal(), "test")
        self.assertTrue(s.admin.reveal().startswith("$"))

    def test_fwcfg_ignored_on_hardware(self):
        self.assertIsNone(answers.fwcfg("answers.json", probe("dell7770")))


class ProbeTest(unittest.TestCase):
    def test_nmcli_split(self):
        self.assertEqual(_split_nm(r"My\:Net:80:WPA2"), ["My:Net", "80", "WPA2"])

    def test_wifi_keyfile_mode(self):
        d = tempfile.mkdtemp()
        try:
            path = write_wifi_keyfile(d, "Home Net", "pa;ss\\word", "WPA2")
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            with open(path) as f:
                text = f.read()
            self.assertIn("psk=pa;ss\\\\word", text)
            self.assertIn("key-mgmt=wpa-psk", text)
        finally:
            shutil.rmtree(d)

    def test_data_tables(self):
        self.assertTrue(any(z == "Asia/Karachi" for z, _ in data.zones()))
        self.assertEqual(data.langpack("ur_PK.UTF-8"), "glibc-langpack-ur")
        self.assertTrue(data.keymaps())


class TextModeTest(unittest.TestCase):
    def run_text(self, lines, name="vm", preset="clean"):
        c, s, p = config(name, preset)
        out = io.StringIO()
        ui = TextUI(c, s, p, env(p), {"disk_by_id": ""}, inp=io.StringIO("\n".join(lines) + "\n"), out=out)
        return ui.run(), out.getvalue(), c, s

    def test_vm_answers(self):
        res, out, c, s = self.run_text(["vmtest", "", "Test User", "test", "test", "test", "", "1", "y", "install", "WIPE"])
        self.assertEqual(res, "install", out[-600:])
        for tag in ("[hostname]", "[timezone]", "[fullname]", "[username]", "[password]", "[password-again]", "[weak]",
                    "[luks-same]", "[disk]", "[review]", "[confirm]"):
            self.assertIn(tag, out)
        self.assertEqual(c.hostname, "vmtest")
        self.assertEqual(s.luks.reveal(), "test")
        self.assertNotIn("test\n", out.split("[password]")[1][:40])

    def test_abort(self):
        res, out, c, s = self.run_text(["vmtest", "", "Test User", "test", "test", "test", "", "1", "y", "abort", "1"])
        self.assertEqual(res, "abort:poweroff")
        self.assertIn("INSTALL STOPPED", out)

    def test_timezone_search(self):
        res, out, c, s = self.run_text(["vmtest", "karachi"])
        self.assertEqual(c.time.zone, "Asia/Karachi")


if __name__ == "__main__":
    unittest.main()
