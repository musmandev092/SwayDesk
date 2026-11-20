import dataclasses
import os

from sdsetup import app, model
from sdsetup.menus import Setup, default_disk
from sdsetup.probe import FixtureProbe
from sdsetup.tui.canvas import Headless, KeysExhausted
from sdsetup.tui.widgets import UI

HERE = os.path.dirname(os.path.abspath(__file__))
ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g laptop@home"


def probe(name="vm"):
    return FixtureProbe(os.path.join(HERE, "fixtures", f"{name}.json"))


def defaults():
    return app.load_json(os.path.join(os.path.dirname(HERE), "defaults.json"))


def config(name="vm", preset="clean", build=None):
    p = probe(name)
    c = app.initial_config(defaults(), build or {}, preset)
    c.disk.device = default_disk(c, p, defaults())
    return c, model.Secrets(), p


def env(p):
    return {"vm": p.is_vm, "nvidia": p.nvidia()}


def tui(keys, name="vm", preset="clean", size=(30, 100), setup=None):
    c, s, p = config(name, preset)
    if setup:
        setup(c, s, p)
    canvas = Headless(keys, size)
    ui = UI(canvas, badge=f"{preset} ISO")
    base = dataclasses.asdict(c)
    base["disk_by_id"] = ""
    result = None
    try:
        result = Setup(ui, c, s, p, env(p), base).run()
    except KeysExhausted:
        result = "exhausted"
    return result, canvas, c, s, p


def type_keys(text):
    return ["space" if ch == " " else ch for ch in text]
