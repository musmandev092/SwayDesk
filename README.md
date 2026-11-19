# SwayDesk

A declarative, automated workstation setup for **Fedora 45** featuring official **Sway 1.12** and **DMS** (Dank Material Shell), optimized for high-performance laptop workflows (Dell Precision 7770, NVIDIA/Intel hybrid, encrypted Btrfs).

---

## Highlights

- **Fedora 45 Native**: Uses upstream official Fedora 45 packages for **Sway 1.12** and **wlroots** (no third-party/custom repository required).
- **DMS Shell Integration**: Unified notification center, launcher, system controls, and custom QML plugins:
  - **Switcher (`Alt+Tab`, `Super+Tab`)**: Windows 11-style window previews and workspace overview powered by `grim -T`.
  - **Doctor (`Super+Alt+d`)**: Live system diagnostic dashboard, journal analyzer, crash logger, and Lynis security scanner.
  - **OpenHere (`Super+z`)**: Contextual working directory launcher for terminals and tools.
- **Dynamic Theming**: Native Matugen color scheme synchronization between DMS wallpaper palettes and Sway window borders/titlebars.
- **Reproducible Installation**: Automated Anaconda Kickstarts (`ks.cfg` and `ks-dualboot.cfg`) and unattended VM test harness.
- **Developer Suite**: Containerized toolbox environment and Neovim (LazyVim) with headless verification.

---

## Profiles

SwayDesk provides 3 modular installation profiles:

1. **Profile 1 (`intel-amd` / Baseline Lean)**:
   - ~690 packages.
   - Sway 1.12 + DMS + Switcher preview.
   - Brave browser, Intel/AMD Mesa hardware acceleration, CUPS printing stack, and core GNOME utilities.
   - Activated by touching `.lean` in the repository root or setting `LEAN=1`.

2. **Profile 2 (`intel-amd-nvidia` / Workstation Hardware)**:
   - ~705 packages.
   - Automatically detected via `lspci`.
   - Uses pre-compiled binary NVIDIA kernel modules from [musmandev092/fedora-nvidia-kmod](https://github.com/musmandev092/fedora-nvidia-kmod), dropping ~85 local compiler packages (`gcc`, `kernel-devel`, `make`).
   - Configures CUDA runtime, `prime-run` offload helper, and NVIDIA power management services.

3. **Profile 3 (`mine` / Full Personal Workstation)**:
   - ~770 packages.
   - Includes containerized Developer Toolbox with Neovim (LazyVim) and LSP toolchains.
   - Multi-browser suite (Brave, Chromium with Google sign-in configuration, Microsoft Edge).
   - Starship prompt, Fastfetch, OpenHere directory context launcher, and Urdu/Nastaliq + CJK typography rules.

---

## Quick Start

### 1. Build the Installer ISO

Build unattended installation media via an isolated container:

```sh
toolbox run -c iso ~/Projects/SwayDesk/install/build-iso.sh
```

Generates bootable ISO images:
- `ks-dualboot.cfg`: Installs to free space, preserving existing OS (e.g. Windows).
- `ks.cfg`: Clean installation (re-partitions and encrypts target drive).

### 2. Apply System & User Configuration

Run the idempotent configuration orchestrator:

```sh
# System configuration (repositories, display manager, system services, udev rules)
./apply.sh system

# User configuration (dotfiles, DMS plugins, themes, Neovim, developer toolbox)
./apply.sh home toolbox nvim
```

---

## Repository Structure

- `apply.sh`: Main idempotent setup orchestrator.
- `home/`: User dotfiles, DMS plugins, Sway configurations, and custom CLI tools linked to `~`.
- `etc/`: System-level configuration files (udev rules, display manager sessions, repository definitions).
- `install/`: Fedora 45 Kickstart definitions and headless VM validation test scripts.
- `nvim-setup/`: Neovim IDE configuration, Mason packages, and test suites.
- `toolbox/`: Package specifications for containerized development environments.
