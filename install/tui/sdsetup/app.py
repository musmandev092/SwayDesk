import argparse
import dataclasses
import json
import logging
import os
import sys
import traceback

from . import answers, kickstart, model, validate
from .menus import Setup, default_disk
from .probe import FixtureProbe, Probe
from .ui_text import TextUI

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RC = {"install": 0, "abort:poweroff": 3, "abort:reboot": 4, "abort:shell": 5, "abort:stop": 6, "abort": 6}
log = logging.getLogger("swaydesk-setup")


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def initial_config(defaults, build, preset):
    config = model.Config(preset=preset)
    config = model.merge(config, defaults.get("config", {}))
    config.disk.mode = "alongside" if preset == "dualboot" else "erase"
    config.profile.lean = bool(build.get("lean", config.profile.lean))
    config.repos.fedora = build.get("fedora", "") or config.repos.fedora
    config.repos.copr_cache = build.get("copr_cache", "") or config.repos.copr_cache
    return config


def fixture_path(name):
    if os.path.exists(name):
        return name
    return os.path.join(HERE, "tests", "fixtures", f"{name}.json")


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="swaydesk-setup")
    ap.add_argument("--preset", choices=("clean", "dualboot"), default="clean")
    ap.add_argument("--text", action="store_true", help="line-mode prompts instead of the full-screen menu")
    ap.add_argument("--dry-run", action="store_true", help="write the kickstart fragments only to --out")
    ap.add_argument("--answers", help="JSON answers file (dry runs only; VMs read QEMU fw_cfg)")
    ap.add_argument("--fixtures", help="fake hardware: a name from tests/fixtures or a JSON path")
    ap.add_argument("--out", default="/tmp/swaydesk")
    ap.add_argument("--advanced", action="store_true")
    ap.add_argument("--mirror", help="also write each screen as text to this file")
    return ap.parse_args(argv)


def run_curses(setup_args, mirror):
    from .tui.canvas import run_curses as start
    from .tui.widgets import UI

    def body(canvas):
        ui = UI(canvas, badge=setup_args["badge"])
        return Setup(ui, *setup_args["args"]).run()
    return start(body, mirror)


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    os.makedirs(args.out, mode=0o700, exist_ok=True)
    logging.basicConfig(filename=os.path.join(args.out, "setup.log"), level=logging.INFO,
                        format="%(asctime)s %(message)s")
    probe = FixtureProbe(fixture_path(args.fixtures)) if args.fixtures else Probe()
    defaults = load_json(os.path.join(HERE, "defaults.json"))
    build = load_json(os.path.join(HERE, "build.json"))
    config = initial_config(defaults, build, args.preset)
    secrets = model.Secrets()
    env = {"vm": probe.is_vm, "nvidia": probe.nvidia()}
    log.info("start preset=%s vm=%s nvidia=%s uefi=%s", args.preset, probe.virt or "no", env["nvidia"], probe.uefi)

    text = None
    if args.answers:
        if not (args.dry_run or probe.is_vm):
            print("--answers is only accepted for dry runs or in a VM", file=sys.stderr)
            return 2
        with open(args.answers) as f:
            text = f.read()
    else:
        text = answers.fwcfg("answers.json", probe)
    silent = False
    if text:
        config, silent = answers.apply(config, secrets, answers.load(text))
        log.info("answers loaded silent=%s", silent)
    if not any(d["name"] == config.disk.device for d in probe.disks()):
        config.disk.device = default_disk(config, probe, defaults)

    base = dataclasses.asdict(config)
    base["disk_by_id"] = defaults.get("disk_by_id", "")
    setup_args = (config, secrets, probe, env, base, args.advanced)
    ui_mode = (answers.fwcfg("ui", probe) or "").strip() or ("text" if args.text else "auto")
    mirror_path = args.mirror or answers.fwcfg("mirror", probe)

    if silent:
        result = "install"
    else:
        result = None
        if ui_mode != "text" and sys.stdout.isatty() and os.environ.get("TERM", "dumb") != "dumb":
            mirror = None
            try:
                if mirror_path:
                    mirror = open(mirror_path, "w", encoding="utf-8", errors="replace")
                result = run_curses({"badge": f"Fedora 45 / Sway / DMS    {args.preset} ISO",
                                     "args": setup_args}, mirror)
                log.info("curses ui result=%s", result)
            except Exception:
                log.info("curses ui failed, using text mode:\n%s", traceback.format_exc())
                result = None
            finally:
                if mirror:
                    mirror.close()
        if result in (None, "text"):
            result = TextUI(*setup_args[:5]).run()
            log.info("text ui result=%s", result)

    if result != "install":
        return RC.get(result, 6)
    missing, _ = validate.check(config, secrets, probe)
    if missing:
        for m in missing:
            print(f"missing: {m}")
            log.info("missing: %s", m)
        print("INSTALL STOPPED: the answers are incomplete. Nothing was written to any disk.")
        return 6
    files = kickstart.render(config, secrets, probe, env)
    err = kickstart.reparse(kickstart.render(config, secrets, probe, env, hide=True))
    if err:
        log.info("kickstart check failed: %s", err)
        print(f"INSTALL STOPPED: the generated kickstart is not valid ({err}).")
        return 6
    kickstart.write(files, args.out, {"swaydesk-config.json": model.public_json(config, secrets) + "\n"})
    log.info("written to %s: disk=%s mode=%s fs=%s encrypt=%s lean=%s", args.out, config.disk.device,
             config.disk.mode, config.disk.fs, config.disk.encrypt, config.profile.lean)
    print(f"Settings written for {config.auth.admin.name} on {config.disk.device}.")
    return 0
