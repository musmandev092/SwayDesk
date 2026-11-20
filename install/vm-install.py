#!/usr/bin/env python3
"""Install swaydesk-fedora45-vm.iso into a fresh UEFI VM through the SwayDesk installer.
Test answers: computer vmtest, user test / test, disk passphrase = account password (test).

Runs in the `iso` toolbox or WSL:  python3 vm-install.py [MODE] [--setup-only]
  (default)         answer the text-mode prompts on the second serial port, like a person
  --answers         pass an answers file through QEMU fw_cfg: no prompts at all
  --tui-smoke       run the full-screen installer, press keys over QMP, save screenshots, abort
  --questions-only  answer the prompts, then abort at the review: installs nothing
  --setup-only      stop the VM once the installer has written its settings
VM_DIR (default ~/VMs/test), VM_ISO, VM_CPUS, VM_MEM; VM_SHOTS for --tui-smoke screenshots.
"""
import json, os, re, shutil, socket, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vmkeys  # noqa: E402

ISO = os.environ.get("VM_ISO") or os.path.expanduser("~/VMs/fedora-iso/swaydesk-fedora45-vm.iso")
VM = os.path.expanduser(os.environ.get("VM_DIR", "~/VMs/test"))
SHOTS = os.path.expanduser(os.environ.get("VM_SHOTS", VM))
OVMF = "/usr/share/edk2/ovmf"
CPUS, MEM = os.environ.get("VM_CPUS", "8"), os.environ.get("VM_MEM", "16384")
SER, MON, QMP = f"{VM}/questions.sock", f"{VM}/monitor.sock", f"{VM}/qmp.sock"
CON = f"{VM}/install-serial.log"
ANSI = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]")

ANSWERS = [
    ("hostname", "vmtest"),
    ("timezone", ""),
    ("fullname", "Test User"),
    ("username", "test"),
    ("password", "test"),
    ("password-again", "test"),
    ("weak", ""),
    ("disk", "1"),
    ("luks-same", "y"),
    ("review", "install"),
    ("confirm", "WIPE"),
]
ANSWERS_FILE = {
    "silent": True,
    "config": {"hostname": "vmtest", "auth": {"admin": {"name": "test", "fullname": "Test User"}}},
    "secrets": {"admin_password": "test"},
}

MODE = next((a for a in sys.argv[1:] if a in ("--answers", "--tui-smoke", "--questions-only")), "text")
SETUP_ONLY = "--setup-only" in sys.argv or MODE in ("--tui-smoke", "--questions-only")
if MODE == "--questions-only":
    ANSWERS[-2:] = [("review", "abort"), ("abort", "1")]

if not os.path.exists(ISO):
    sys.exit(f"missing {ISO} (run build-iso.sh)")
shutil.rmtree(VM, ignore_errors=True)
os.makedirs(VM)
if MODE == "--tui-smoke":
    os.makedirs(SHOTS, exist_ok=True)
subprocess.run(["qemu-img", "create", "-q", "-f", "qcow2", f"{VM}/disk.qcow2", "60G"], check=True)
shutil.copy(f"{OVMF}/OVMF_VARS.fd", f"{VM}/vars.fd")
log = open(f"{VM}/questions.log", "wb")

extra = []
if MODE == "--answers":
    with open(f"{VM}/answers.json", "w") as f:
        json.dump(ANSWERS_FILE, f)
    extra = ["-fw_cfg", f"name=opt/swaydesk/answers.json,file={VM}/answers.json"]
elif MODE == "--tui-smoke":
    extra = ["-fw_cfg", "name=opt/swaydesk/ui,string=curses", "-fw_cfg", "name=opt/swaydesk/mirror,string=/dev/ttyS1"]

qemu = subprocess.Popen([
    "qemu-system-x86_64", "-name", "swaydesk-install", "-enable-kvm", "-machine", "q35",
    "-cpu", "host", "-smp", CPUS, "-m", MEM,
    "-drive", f"if=pflash,format=raw,readonly=on,file={OVMF}/OVMF_CODE.fd",
    "-drive", f"if=pflash,format=raw,file={VM}/vars.fd",
    "-drive", f"file={VM}/disk.qcow2,if=virtio,format=qcow2",
    "-cdrom", ISO, "-boot", "once=d",
    "-nic", "user,model=virtio-net-pci", "-device", "virtio-vga", "-display", "none",
    "-serial", f"file:{CON}",
    "-chardev", f"socket,id=s1,path={SER},server=on,wait=off", "-serial", "chardev:s1",
    "-monitor", f"unix:{MON},server,nowait", "-qmp", f"unix:{QMP},server,nowait", "-no-reboot", *extra,
])

for _ in range(60):
    if qemu.poll() is not None:
        sys.exit(f"qemu exited with code {qemu.returncode}")
    try:
        ser = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); ser.connect(SER); break
    except OSError:
        time.sleep(1)
else:
    sys.exit("no serial socket")
ser.settimeout(1)
buf = b""


def read_some():
    global buf
    try:
        chunk = ser.recv(65536)
    except socket.timeout:
        return True
    except OSError:
        return False
    if not chunk:
        return False
    log.write(chunk); log.flush(); buf += chunk
    return True


def wait_for(pattern, timeout):
    global buf
    rx, end = re.compile(pattern.encode()), time.time() + timeout
    while time.time() < end:
        alive = read_some()
        m = rx.search(buf)
        if m:
            buf = buf[m.end():]
            return
        if b"INSTALL STOPPED" in buf:
            raise RuntimeError("installer stopped: " + ANSI.sub(b"", buf[-600:]).decode(errors="replace"))
        if not alive and qemu.poll() is not None:
            break
    raise TimeoutError(f"timed out waiting for {pattern!r}")


def screen():
    text = ANSI.sub(b"", buf).decode(errors="replace")
    i = text.rfind("==SCREEN==")
    j = text.find("==END==", i)
    return text[i + 10:j] if i >= 0 and j > i else ""


def wait_screen(*needles, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        read_some()
        s = screen()
        if all(n in s for n in needles):
            return s
    raise TimeoutError(f"screen never showed {needles!r}; last screen:\n{screen()}")


def screendump(name):
    m = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    m.connect(MON)
    m.settimeout(5)
    time.sleep(0.5)
    try:
        m.recv(65536)
    except socket.timeout:
        pass
    path = os.path.join(SHOTS, f"{name}.png")
    m.sendall(f"screendump {path} -f png\n".encode())
    time.sleep(2)
    m.close()
    print(f"screenshot: {path}", flush=True)


def keys(spec):
    vmkeys.send(QMP, spec)
    time.sleep(0.8)


def tui_smoke():
    wait_screen("SwayDesk installer", "Install", "Disk configuration", timeout=900)
    time.sleep(2)
    screendump("tui-main")
    keys("tap:7 tap:ret")
    wait_screen("Authentication", "Administrator", "Root account")
    keys("tap:ret")
    wait_screen("Full name", "Confirm")
    keys("tap:down tap:down " + vmkeys.text_spec("test"))
    wait_screen("weak (4 chars")
    keys("tap:down " + vmkeys.text_spec("test"))
    wait_screen("ok, they match")
    screendump("tui-password")
    keys("tap:ret")
    wait_screen("Weak password: press Enter again")
    keys("tap:ret")
    wait_screen("Password   set")
    keys("tap:esc tap:end tap:up tap:up tap:up tap:up tap:ret tap:ret " + vmkeys.text_spec("kar"))
    wait_screen("/kar_", "Asia/Karachi", "UTC+05:00")
    screendump("tui-timezone")
    keys("tap:ret tap:esc tap:3 tap:ret tap:down tap:ret")
    wait_screen("Choose the disk", "vda")
    screendump("tui-disk")
    keys("tap:esc tap:esc tap:f10")
    wait_screen("Review", "Type WIPE to erase vda", timeout=90)
    screendump("tui-review")
    keys("tap:esc")
    wait_screen("ready", "Disk configuration")
    keys("down:ctrl tap:q up:ctrl")
    wait_screen("Abort the installation?")
    screendump("tui-abort")
    keys("tap:p")
    qemu.wait(timeout=120)
    print("TUI smoke test passed: menu, password, timezone, disk, review and abort screens", flush=True)


try:
    if MODE == "--tui-smoke":
        tui_smoke()
        sys.exit(0)
    if MODE != "--answers":
        for i, (tag, answer) in enumerate(ANSWERS):
            wait_for(rf"\[{re.escape(tag)}\] [^\n]*: ", 900 if i == 0 else 90)
            time.sleep(0.3)
            ser.sendall((answer + "\r").encode())
            print(f"answered: [{tag}]".ljust(28) + f"-> {'*' * len(answer) if 'pass' in tag else answer!r}", flush=True)
    if MODE == "--questions-only":
        try:
            qemu.wait(timeout=120)
            print("installer aborted as asked; nothing installed", flush=True)
        except subprocess.TimeoutExpired:
            print("ERROR: installer did not stop", flush=True)
            qemu.kill()
        sys.exit(0)
    wait_for(r"Settings written for test on vda", 900)
    print("installer wrote its settings", flush=True)
    if SETUP_ONLY:
        qemu.kill()
        sys.exit(0)
    print("installing ...", flush=True)
    last_check = 0
    while qemu.poll() is None:
        read_some()
        if time.time() - last_check > 30:
            last_check = time.time()
            with open(CON, "rb") as f:
                f.seek(max(0, os.path.getsize(CON) - 8192))
                tail = ANSI.sub(b"", f.read()).decode(errors="replace")
            if "Press ENTER to exit" in tail:
                msg = tail[tail.rfind("Error"):tail.rfind("Press ENTER")].strip() or tail[-600:]
                raise RuntimeError("installer hit a fatal error: " + " ".join(msg.split()))
    qemu.wait()
except Exception as e:
    print(f"VM INSTALL ERROR: {e}", flush=True)
    try:
        screendump("error-screen")
    except OSError:
        pass
    qemu.kill()
    sys.exit(1)
text = open(CON, "rb").read().decode(errors="replace")
print("finished: reboot seen" if "reboot: Restarting system" in text or "reboot: Power down" in text
      else "finished (check install-serial.log)", flush=True)
