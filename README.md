# SwayDesk

A declarative, automated workstation setup for **Fedora 45** featuring official **Sway 1.12** and **DMS** (Dank Material Shell), optimized for high-performance laptop workflows (Dell Precision 7770, NVIDIA/Intel hybrid, encrypted Btrfs).

---

## Highlights

- **Fedora 45 Native**: Uses upstream official Fedora 45 packages for **Sway 1.12** and **wlroots** (no third-party/custom repository required).
- **DMS Shell Integration**: Unified notification center, launcher, system controls, and custom QML plugins:
  - **Switcher (`Alt+Tab`, `Super+Tab`, `Super+/`)**: Windows 11-style window switcher with `grim -T` previews. See [Window switcher](#window-switcher).
  - **OpenHere (`Super+z`)**: Contextual working directory launcher for terminals and tools.
- **Dynamic Theming**: Native Matugen color scheme synchronization between DMS wallpaper palettes and Sway window borders/titlebars.
- **Dialogs**: file choosers, print, Open With, keyring prompts and Archive Manager extract open floating, sized to fit and centred (`55-rules-dialogs.conf`).
- **Reproducible Installation**: Automated Anaconda Kickstarts (`ks.cfg` and `ks-dualboot.cfg`) and unattended VM test harness.
- **Developer Suite**: Containerized toolbox environment and Neovim (LazyVim) with headless verification.

---

## Profiles

SwayDesk provides 3 modular installation profiles:

1. **Profile 1 (`intel-amd` / Baseline Lean)**:
   - ~980 packages (982 on a fresh VM install, including the GNOME apps and their GTK stack, DMS, codecs and printing).
   - Sway 1.12 + DMS + Switcher preview, Starship, Fastfetch, OpenHere.
   - Brave browser, Intel/AMD Mesa hardware acceleration, CUPS printing stack, and core GNOME utilities.
   - Urdu/Nastaliq, Arabic, Indic, Thai and CJK fonts with fontconfig rules.
   - Activated by touching `.lean` in the repository root or setting `LEAN=1`. `./apply.sh` then runs `system home` only.

2. **Profile 2 (`intel-amd-nvidia` / Workstation Hardware)**:
   - Profile 1 or 3 plus the NVIDIA driver packages (not yet counted on hardware).
   - Profile 1 or 3 plus NVIDIA, applied automatically when an NVIDIA display controller is present (PCI class 0300/0302, vendor 10de).
   - Uses pre-compiled binary NVIDIA kernel modules from [musmandev092/fedora-nvidia-kmod](https://github.com/musmandev092/fedora-nvidia-kmod), dropping ~85 local compiler packages (`gcc`, `kernel-devel`, `make`).
   - Configures CUDA runtime, `prime-run` offload helper, and NVIDIA power management services.
   - `swaydesk-nvidia-sync [kernel]` installs the kmod built for the newest installed kernel (or the one given). It aborts without changes when no build for that exact kernel exists, the SHA-256 check fails, or the RPM targets another kernel.

3. **Profile 3 (`mine` / Full Personal Workstation)**:
   - ~1010 packages (Profile 1 plus about 30: Chromium, Toolbox, Edge, PowerShell).
   - Includes containerized Developer Toolbox (`toolbox`) with Neovim (LazyVim) and LSP toolchains.
   - Multi-browser suite (Brave, Chromium with Google sign-in configuration, Microsoft Edge).
   - PowerShell from the Microsoft repository (restricted to the `powershell` package).

---

## Quick Start

### 1. Build the Installer ISO

Build unattended installation media via an isolated container:

```sh
toolbox run -c iso ~/Projects/SwayDesk/install/build-iso.sh
```

Generates bootable ISO images:
- `ks-dualboot.cfg`: Starts the installer in "install alongside" mode (free space only, existing systems such as Windows are kept).
- `ks.cfg`: Starts the installer in "erase disk" mode (re-partitions and, by default, encrypts the target drive).

`build-iso.sh lean` builds the same three ISOs with Profile 1 preselected and a `-lean` suffix. `build-iso.sh check` runs the installer's unit tests, renders sample answers into kickstart fragments and validates both kickstarts with `ksvalidator`; every build does this first. `MIRROR=https://<mirror>/fedora/linux build-iso.sh` makes one fast mirror the installer's default Fedora source instead of the mirror list. DMS packages come from the Dux Labs COPR repositories `duxlabs/dms` and `duxlabs/dux-repo`, during install and for updates. For VM tests, `COPR_CACHE=http://10.0.2.2:8080` points the DMS repos at a local cache served from WSL (`createrepo_c` directories `dms/` and `dux-repo/`). The build also packs a package index (`PKGINDEX=0` skips it) for the installer's package search.

### Installer

Both ISOs boot into the same full-screen installer (`install/tui`, Python standard library and curses only) on the console's tty8. The clean ISO starts in "erase disk" mode, the dual-boot ISO in "install alongside"; either can be switched in the menu. Every setting is listed with its value, the right pane explains the highlighted item, required items are marked `*`, and **Install** stays blocked, with the reasons listed, until nothing is missing.

| Menu item | Choices |
| --- | --- |
| Locales | keyboard layout and variant (applied to the console at once, used at disk unlock and in Sway), second layout, language, extra languages, console font |
| Mirrors and repos | Fedora mirror list or one https mirror, DMS from COPR or a mirror, updates-testing, a reachability check |
| Disk configuration | erase or alongside, the disk (USB and removable drives are never listed), btrfs/ext4/xfs, LVM or plain with or without /home, Linux size (alongside), LUKS2 on or off, passphrase same as the administrator password or separate, unlock time |
| Swap, Bootloader | zram size or none; GRUB timeout, other systems in the menu, extra kernel arguments |
| Hostname, Authentication | computer name; administrator (always in `wheel`), root locked or with a password, other users |
| SSH server | off by default; key-only, with keys pasted or fetched from `github.com/<name>.keys` |
| Profile, Services | Profile 1 (lean) or 3 (full), NVIDIA auto/always/never; Bluetooth and printing services |
| Network | Wi-Fi from the installer (signal, security, hidden networks), copy connections to the installed system or not, DHCP or static wired address |
| Additional packages | searchable index; names not in the index are installed after setup, best effort |
| Timezone, Time sync | searchable by city, country or `UTC+05`; UTC or local hardware clock; NTP on or off and custom servers |
| Save configuration | the settings as JSON without passwords; always copied to `/root/swaydesk-config.json`, optionally to a USB stick |

**Install** shows a review, asks for `WIPE` (or `WIPE-WINDOWS` when the disk holds NTFS, BitLocker or Microsoft partitions; `INSTALL` for alongside), then counts down five seconds; any key goes back. Nothing touches a disk before that.

| Keys | Action |
| --- | --- |
| `Up`/`Down`, `j`/`k`, `Home`/`End`, `1`-`9` | Move, jump |
| `Enter` | Edit or choose; `Space` ticks or toggles |
| `/` or typing in long lists | Filter; `Esc` clears the filter or goes back |
| `Ctrl+C` | Restore the default of the highlighted item |
| `PgUp`/`PgDn` | Scroll the right pane |
| `F1` or `?` | Help |
| `F2` | Show the password being typed; in the review, the kickstart with secrets hidden |
| `F10` | Install; `Ctrl+Q` aborts (power off, reboot or shell) |

Account passwords are hashed with yescrypt as soon as they are entered. The disk passphrase exists only in memory and in the kickstart fragment under `/tmp/swaydesk` (mode 0600, removed in `%post`); Wi-Fi passwords go only into a NetworkManager keyfile. Weak passwords are accepted after a second `Enter`.

Without a usable console (serial, or curses failing) the installer falls back to a text mode with the same settings; every prompt starts with a fixed tag such as `[hostname]`. Inside a VM only, QEMU fw_cfg can pass an answers file (`opt/swaydesk/answers.json`) for an unattended install, force the full-screen UI (`opt/swaydesk/ui=curses`) and mirror its screens as text to a serial port (`opt/swaydesk/mirror`). For development, `python3 install/tui/run.py --dry-run --fixtures dell7770 --out /tmp/sd` runs the menu in any terminal against fake hardware and writes the fragments there.

### 2. Apply System & User Configuration

Run the idempotent configuration orchestrator:

```sh
# System configuration (packages, repositories, drivers, firewall, boot screen)
./apply.sh system

# User configuration (dotfiles, DMS plugins, themes, Neovim, developer toolbox)
./apply.sh home toolbox nvim
```

### Firewall and SSH

- Inbound: LocalSend (`53317/tcp`, `53317/udp`) only. HTTP and HTTPS are closed.
- SSH is off by default: `sshd` is disabled and its port closed. Touch `.sshd` in the repository root and rerun `./apply.sh system` to enable both.
- `sshd` is always key-only (`PasswordAuthentication no`, `PermitRootLogin no`), so add your public key to `~/.ssh/authorized_keys` before enabling it.
- `apply.sh` keeps the original of every system file it replaces under `/var/backups/swaydesk/` (mode 0700), never next to the live file.

### Window switcher

| Keys | Action |
| --- | --- |
| `Alt+Tab` | Windows of the current workspace, most recently used first. Keep `Alt` down, press `Tab` or the arrows to move, release `Alt` to switch. A quick tap switches to the previous window without showing the list. |
| `Alt+Shift+Tab` | Same, moving backwards. |
| `Super+Tab` | Every workspace (and the scratchpad). Type to search, arrows move, `Enter` or a click switches. |
| `Super+/` | Every shortcut, searchable; `Enter` or a click runs it. |
| `Delete`, middle click, `✕` | Close the selected or clicked window. |
| `Esc`, click outside | Cancel. The mouse wheel moves the selection. |

Sway sends the keys to the plugin as `nop switcher ...` binding events (`92-switcher.conf`); while the switcher is open it holds the keyboard, which is how it sees `Alt` being released.

### DMS local patches

Fixes not yet in a DMS release live in `home/.config/dms/patches/` (linked to `~/.config/dms/patches`) as `git diff` output from the upstream repository (`a/quickshell/...` paths). `sway-window-pid.diff` makes the focused-window popout find the PID on Sway, so Kill Process works. `sway-maximize-fullscreen.diff` makes the maximize button of DMS windows (Settings, task manager) toggle Sway fullscreen, since Sway ignores maximize.

Sway starts DMS through `swaydesk-dms`: it copies the packaged UI (`/usr/share/quickshell/dms`, same release as the `dms` binary) to `~/.cache/swaydesk/dms-shell/<version>-<hash>`, applies every `*.diff`/`*.patch` in name order and runs `dms run` on the copy through `DMS_SHELL_DIR`, the supported custom UI setting. The copy is reused until DMS or a patch changes; older copies not in use are removed. If a patch no longer applies (usually because the release changed or already contains the fix), or DMS exits with an error on the copy right after start, it logs one line to the journal (`journalctl -t swaydesk-dms`), shows a notification and runs plain `dms run`. `swaydesk-dms --prepare` builds the copy and prints its path without starting anything. Delete a patch once a release includes it.

### VM Tests

Inside the `iso` toolbox or WSL 2 with `/dev/kvm` (packages: `qemu-system-x86-core qemu-device-display-virtio-vga qemu-img edk2-ovmf lorax pykickstart xorriso cpio`; for 3D on the Intel host also `qemu-device-display-virtio-vga-gl qemu-ui-egl-headless`): `build-iso.sh`, then `vm-install.py` (answers the installer's text-mode prompts over serial), `vm-boot-test.py`, and `vm-run.py vm-firstboot-checks.sh` / `vm-checks.sh`. `vm-run.py vm-apply-test.sh --share ~/Projects/SwayDesk` reruns `apply.sh` to confirm a second run changes nothing.

`vm-install.py --answers` installs unattended through an fw_cfg answers file, `--tui-smoke` drives the full-screen installer with real key presses over QMP, checks each screen through the serial mirror, saves screenshots (`tui-*.png`, into `VM_SHOTS`) and aborts, `--questions-only` answers the prompts and aborts at the review, and `--setup-only` stops once the installer has written its settings. `vm-firstboot-checks.sh` also confirms that no passphrase or password is left in logs or saved kickstarts and that the saved settings hold no secrets. Installer unit tests alone: `cd install/tui && python3 -m unittest discover -s tests`.

Dwindle plugin stress test (packages: `sway gcc wayland-devel wayland-protocols-devel wlr-protocols-devel nodejs`, `quickshell` for `--plugin qml`): `node install/tests/dwindle/run.mjs --scenarios 10000 --jobs 12` runs seeded random window, keyboard and mouse scenarios against headless Sway instances (several resolutions, two outputs) through `DwindleLogic.js` and checks each quiet tree against an independent dwindle model. Failing seeds land in `--out` (default `/tmp/dwindle-test`) and replay with `--replay SEED --verbose`; `--plugin qml` drives the real `DwindleDaemon.qml` in Quickshell, `--bench 30` measures the cost per window.

The test VM uses 8 CPUs and 16 GB RAM in `~/VMs/test`; override with `VM_CPUS`, `VM_MEM` (MiB) and `VM_DIR` (all scripts), e.g. `VM_DIR=~/VMs/tui VM_MEM=8192 VM_CPUS=6` to test beside another VM. Set `VM_ISO` to install another ISO, e.g. `swaydesk-fedora45-vm-lean.iso`. `vm-run.py` uses the Intel GPU render node for 3D when present (or `VM_RENDER`), otherwise plain `virtio-vga`.

---

## Repository Structure

- `apply.sh`: Main idempotent setup orchestrator.
- `home/`: User dotfiles, DMS plugins, Sway configurations, and custom CLI tools linked to `~`.
- `etc/`: System-level configuration files (Wayland session, helper scripts, repository definitions).
- `install/`: Fedora 45 Kickstart definitions, the installer (`install/tui`) and headless VM validation test scripts.
- `nvim-setup/`: Neovim IDE configuration, Mason packages, and test suites.
- `toolbox/`: Package specifications for containerized development environments.
