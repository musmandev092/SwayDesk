import json
import os
import subprocess

from . import model
from .secret import Secret, hash_password

FWCFG_DIR = "/sys/firmware/qemu_fw_cfg/by_name/opt/swaydesk"


def fwcfg(name, probe):
    if not probe.is_vm or probe.fixture:
        return None
    path = os.path.join(FWCFG_DIR, name, "raw")
    if not os.path.exists(path):
        subprocess.run(["modprobe", "qemu_fw_cfg"], capture_output=True, check=False)
    try:
        with open(path, "rb") as f:
            return f.read().decode("utf-8", errors="replace").strip()
    except OSError:
        return None


def apply(config, secrets, answers):
    config = model.merge(config, answers.get("config", {}))
    s = answers.get("secrets", {})
    admin = s.get("admin_password")
    if admin:
        model.set_admin_password(config, secrets, admin, hash_password(admin))
    if s.get("luks"):
        secrets.luks = Secret(s["luks"])
    if s.get("root_password"):
        secrets.root = Secret(hash_password(s["root_password"]))
    for name, pw in (s.get("users") or {}).items():
        secrets.users[name] = Secret(hash_password(pw))
    return config, bool(answers.get("silent"))


def load(text):
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("answers must be a JSON object")
    return data
