"""Press keys in a QEMU guest over QMP.

A spec is a space-separated list of tokens: down:KEY, up:KEY, tap:KEY or
sleep:MS, where KEY is a QEMU qcode (a, ret, esc, shift, ctrl, alt, f10, ...).
"""
import json
import socket
import time

SHIFTED = {"_": "minus", ":": "semicolon", "@": "2", "!": "1", "?": "slash", "+": "equal", '"': "apostrophe",
           "#": "3", "$": "4", "%": "5", "&": "7", "*": "8", "(": "9", ")": "0", "<": "comma", ">": "dot"}
PLAIN = {" ": "spc", "-": "minus", ".": "dot", "/": "slash", ",": "comma", "=": "equal", ";": "semicolon",
         "'": "apostrophe", "\n": "ret", "\t": "tab"}


def text_spec(text):
    out = []
    for ch in text:
        if ch.isascii() and ch.isalnum():
            out.append(f"down:shift tap:{ch.lower()} up:shift" if ch.isupper() else f"tap:{ch}")
        elif ch in PLAIN:
            out.append(f"tap:{PLAIN[ch]}")
        elif ch in SHIFTED:
            out.append(f"down:shift tap:{SHIFTED[ch]} up:shift")
        else:
            raise ValueError(f"cannot type {ch!r}")
    return " ".join(out)


def send(qmp_path, spec, tries=10):
    for _ in range(tries):
        try:
            q = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            q.connect(qmp_path)
            break
        except OSError:
            time.sleep(1)
    else:
        raise RuntimeError(f"cannot connect to {qmp_path}")
    f = q.makefile("rwb")
    f.readline()

    def qmp(cmd, **arguments):
        f.write(json.dumps({"execute": cmd, "arguments": arguments}).encode() + b"\n")
        f.flush()
        while True:
            r = json.loads(f.readline())
            if "return" in r or "error" in r:
                return r

    def key(code, down):
        qmp("input-send-event", events=[{"type": "key", "data": {"down": down, "key": {"type": "qcode", "data": code}}}])

    qmp("qmp_capabilities")
    for tok in spec.split():
        act, _, val = tok.partition(":")
        if act == "sleep":
            time.sleep(int(val) / 1000)
            continue
        if act in ("down", "tap"):
            key(val, True)
        if act == "tap":
            time.sleep(0.04)
        if act in ("up", "tap"):
            key(val, False)
        time.sleep(0.06)
    q.close()
