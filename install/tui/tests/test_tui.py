import io
import unittest

from helpers import ED25519, tui, type_keys
from sdsetup import model
from sdsetup.secret import hash_password
from sdsetup.tui.canvas import Headless
from sdsetup.tui.widgets import UI

ADMIN_PW = ["7", "enter", "enter", "enter", "enter"] + type_keys("test") + ["enter"] + type_keys("test") + ["enter", "enter"]


def with_password(c, s, p):
    model.set_admin_password(c, s, "test", hash_password("test"))


class MainMenuTest(unittest.TestCase):
    def test_renders_items_values_and_missing(self):
        res, cv, c, s, p = tui([])
        self.assertEqual(res, "exhausted")
        text = cv.text()
        for label in ("Locales", "Mirrors and repos", "Disk configuration", "Swap", "Bootloader", "Hostname",
                      "Authentication", "SSH server", "Profile", "Services", "Network", "Additional packages",
                      "Timezone", "Time sync (NTP)", "Save configuration", "Install", "Abort"):
            self.assertIn(label, text)
        self.assertIn("SwayDesk installer", text)
        self.assertIn("USAY-Linux", text)
        self.assertIn("vda, erase, btrfs, LUKS2", text)
        self.assertIn("2 missing", text)
        self.assertIn("LOCALES", text)

    def test_install_preview_lists_missing(self):
        res, cv, c, s, p = tui(["end", "up"])
        text = cv.text()
        self.assertIn("CANNOT INSTALL YET", text)
        self.assertIn("Administrator password", text)

    def test_admin_password_flow(self):
        res, cv, c, s, p = tui(ADMIN_PW)
        self.assertTrue(s.admin and s.admin.reveal().startswith("$"))
        self.assertEqual(s.luks.reveal(), "test")
        self.assertIn("Authentication", cv.text())

    def test_weak_password_needs_second_enter(self):
        keys = ["7", "enter", "enter", "enter", "enter"] + type_keys("test") + ["enter"] + type_keys("test") + ["enter"]
        res, cv, c, s, p = tui(keys)
        self.assertIsNone(s.admin)
        self.assertIn("Weak password: press Enter again", cv.text())

    def test_mismatch_shows_error(self):
        keys = ["7", "enter", "enter", "enter", "enter"] + type_keys("test") + ["enter"] + type_keys("tset") + ["enter"]
        res, cv, c, s, p = tui(keys)
        self.assertIn("do not match", cv.text())

    def test_install_review_and_countdown(self):
        res, cv, c, s, p = tui(["f10"] + type_keys("WIPE") + ["enter"], setup=with_password)
        self.assertEqual(res, "install")
        joined = "\n".join("\n".join(f) for f in cv.frames)
        self.assertIn("Type WIPE to erase vda", joined)
        self.assertIn("Starting in 5", joined)

    def test_wrong_confirm_word(self):
        res, cv, c, s, p = tui(["f10"] + type_keys("wipe") + ["enter"], setup=with_password)
        self.assertEqual(res, "exhausted")
        self.assertIn("Type WIPE exactly", cv.text())

    def test_review_kickstart_view_hides_secrets(self):
        res, cv, c, s, p = tui(["f10", "f2"], setup=with_password)
        text = cv.text()
        self.assertIn("ks-machine.cfg", text)
        self.assertIn("********", text)
        self.assertNotIn("passphrase=test", text)

    def test_abort(self):
        res, cv, c, s, p = tui(["ctrl-q", "enter"])
        self.assertEqual(res, "exhausted")
        res, cv, c, s, p = tui(["ctrl-q", "p"])
        self.assertEqual(res, "abort:poweroff")


class SubMenuTest(unittest.TestCase):
    def test_keyboard_filter_and_live_keymap(self):
        res, cv, c, s, p = tui(["1", "enter", "enter"] + type_keys("de") + ["enter"])
        self.assertEqual((c.locale.layout, c.locale.variant), ("de", ""))
        self.assertIn(("loadkeys", "de"), p.calls)

    def test_keyboard_change_clears_passwords(self):
        res, cv, c, s, p = tui(["1", "enter", "enter"] + type_keys("de") + ["enter", "left", "enter"], setup=with_password)
        self.assertEqual(c.locale.layout, "de")
        self.assertIsNone(s.admin)

    def test_hostname_validation(self):
        res, cv, c, s, p = tui(["6", "enter", "ctrl-u"] + type_keys("bad_name") + ["enter"])
        self.assertIn("1-63 letters", cv.text())
        res, cv, c, s, p = tui(["6", "enter", "ctrl-u"] + type_keys("box-1") + ["enter"])
        self.assertEqual(c.hostname, "box-1")

    def test_disk_picker_dualboot(self):
        res, cv, c, s, p = tui(["3", "enter", "down", "enter"], name="dualboot", preset="dualboot")
        text = cv.text()
        self.assertIn("Choose the disk", text)
        self.assertIn("WINDOWS", text)
        self.assertIn("nvme1n1p3", text)
        self.assertIn("BitLocker", text)

    def test_disk_preview_alongside(self):
        res, cv, c, s, p = tui(["3"], name="dualboot", preset="dualboot")
        text = cv.text()
        self.assertIn("EFI, reused", text)
        self.assertIn("Keep the BitLocker recovery key ready", text)

    def test_encryption_off_needs_confirm(self):
        res, cv, c, s, p = tui(["3", "enter", "end", "up", "enter", "enter", "left", "enter"])
        self.assertFalse(c.disk.encrypt)

    def test_timezone_search(self):
        res, cv, c, s, p = tui(["end", "up", "up", "up", "up", "enter", "enter"] + type_keys("london") + ["enter"])
        self.assertEqual(c.time.zone, "Europe/London")

    def test_ssh_paste_key(self):
        res, cv, c, s, p = tui(["8", "enter", "down", "enter"] + type_keys(ED25519) + ["enter", "enter"])
        self.assertTrue(c.ssh.enabled)
        self.assertEqual(len(c.ssh.keys), 1)

    def test_ssh_github_keys_filters_weak(self):
        res, cv, c, s, p = tui(["8", "enter", "down", "down", "enter"] + type_keys("octo") + ["enter", "enter"],
                               name="dell7770")
        self.assertEqual(len(c.ssh.keys), 1)
        self.assertTrue(c.ssh.keys[0].startswith("ssh-ed25519"))

    def test_wifi_connect(self):
        res, cv, c, s, p = tui(["end", "up", "up", "up", "up", "up", "up", "enter", "enter", "enter"]
                               + type_keys("password1") + ["enter", "enter"], name="dualboot", preset="dualboot",
                               setup=lambda c, s, p: p.data.update(online=False))
        self.assertIn(("wifi", "HomeNet"), p.calls)
        self.assertIn("Connected to HomeNet", "\n".join("\n".join(f) for f in cv.frames))

    def test_profile_and_services(self):
        res, cv, c, s, p = tui(["9", "enter", "enter", "down", "enter", "esc", "down", "enter", "space", "esc"])
        self.assertFalse(c.profile.lean)
        self.assertFalse(c.services.bluetooth)

    def test_other_user(self):
        keys = ["7", "enter", "down", "down", "enter", "enter"] + type_keys("sara") + ["enter"] + type_keys("Sara") + \
               ["enter"] + type_keys("Sara-pass-9!") + ["enter"] + type_keys("Sara-pass-9!") + ["enter", "left", "enter"]
        res, cv, c, s, p = tui(keys)
        self.assertEqual([u.name for u in c.auth.users], ["sara"])
        self.assertTrue(c.auth.users[0].admin)
        self.assertIn("sara", s.users)


class EveryScreenTest(unittest.TestCase):
    def test_each_main_item_opens_and_closes(self):
        for i in range(14):
            keys = ["home"] + ["down"] * i + ["enter"]
            res, cv, c, s, p = tui(keys + ["down", "enter", "esc", "esc", "esc"], name="dell7770")
            self.assertEqual(res, "exhausted", f"item {i}")

    def test_repo_check_and_mirror(self):
        res, cv, c, s, p = tui(["2", "enter", "end", "up", "enter"])
        self.assertIn("Checked: 10 of 10 ok", cv.text())
        res, cv, c, s, p = tui(["2", "enter", "enter", "down", "enter", "ctrl-u"] +
                               type_keys("https://mirror.example/fedora/linux") + ["enter"])
        self.assertEqual(c.repos.fedora, "https://mirror.example/fedora/linux")

    def test_root_password_and_static_network(self):
        res, cv, c, s, p = tui(["7", "enter", "down", "enter", "down", "enter"] + type_keys("Root-pass-123!") +
                               ["enter"] + type_keys("Root-pass-123!") + ["enter"])
        self.assertFalse(c.auth.root_locked)
        self.assertTrue(s.root)
        keys = ["end"] + ["up"] * 6 + ["enter", "end", "up", "enter", "down", "enter", "down", "ctrl-u"] + \
            type_keys("192.168.1.20/24") + ["down"] + type_keys("192.168.1.1") + ["down"] + type_keys("1.1.1.1") + ["enter"]
        res, cv, c, s, p = tui(keys)
        self.assertEqual((c.network.wired, c.network.address, c.network.device), ("static", "192.168.1.20/24", "enp0s2"))

    def test_packages_add_unlisted(self):
        keys = ["end"] + ["up"] * 5 + ["enter", "+"] + type_keys("htop") + ["enter", "enter"]
        res, cv, c, s, p = tui(keys)
        self.assertEqual(c.packages, ["htop"])

    def test_save_view_has_no_secrets(self):
        res, cv, c, s, p = tui(["end", "up", "up", "enter", "enter"] + ["pgdn"] * 4, setup=with_password)
        text = "\n".join("\n".join(f) for f in cv.frames)
        self.assertIn('"password": "set"', text)
        self.assertNotIn("$y$", text)


class CanvasTest(unittest.TestCase):
    def test_small_screen(self):
        res, cv, c, s, p = tui([], size=(20, 60))
        self.assertIn("Screen too small", cv.text())

    def test_mirror_writes_screens(self):
        buf = io.StringIO()
        cv = Headless([], (24, 80), mirror=buf)
        ui = UI(cv)
        ui.frame("Test", footer="keys")
        cv.refresh()
        cv.refresh()
        self.assertEqual(buf.getvalue().count("==SCREEN=="), 1)
        self.assertIn("SwayDesk installer > Test", buf.getvalue())

    def test_80x24_layout(self):
        res, cv, c, s, p = tui([], size=(24, 80))
        lines = cv.dump()
        self.assertEqual(len(lines), 24)
        self.assertTrue(all(len(l) <= 80 for l in lines))
        self.assertIn("Abort", cv.text())


if __name__ == "__main__":
    unittest.main()
