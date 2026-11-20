import time

from .widgets import ListView, TextField, draw_preview, split_body, wrap

HELP = [
    ("Move", "Up/Down  k/j   Home/End   1-9 jump"),
    ("Choose", "Enter          Tick: Space"),
    ("Search", "/ or type in long lists   Esc ends"),
    ("Back", "Esc            Default: Ctrl+C"),
    ("Preview", "PgUp/PgDn"),
    ("Install", "F10            Abort: Ctrl+Q"),
    ("Password", "F2 shows it while typing"),
    ("Fields", "Tab/Down next, Up previous, Enter OK"),
]


class Extra:
    def __init__(self, key, value):
        self.key = key
        self.value = value


def _box(ui, title, width, height):
    c = ui.c
    h, w = c.size()
    width = min(width, w - 2)
    height = min(height, h - 2)
    y, x = max(1, (h - height) // 2), max(0, (w - width) // 2)
    c.box(y, x, height, width)
    if title:
        c.put(y, x + 2, f" {title} ", "bold")
    return y, x, height, width


def help_screen(ui):
    ui.redraw_under()
    y, x, h, w = _box(ui, "Help (F1)", 62, len(HELP) + 4)
    for i, (k, v) in enumerate(HELP):
        ui.c.put(y + 2 + i, x + 3, f"{k:<10}", "help")
        ui.c.put(y + 2 + i, x + 14, v)
    ui.c.refresh()
    ui.c.getkey()


def notify(ui, title, lines, attr="normal"):
    lines = [(l, attr) if isinstance(l, str) else l for l in lines]
    body = wrap(lines, 64)
    while True:
        ui.redraw_under()
        y, x, h, w = _box(ui, title, 70, len(body) + 5)
        for i, (t, a) in enumerate(body[:h - 4]):
            ui.c.put(y + 2 + i, x + 3, t, a)
        ui.c.put(y + h - 2, x + w // 2 - 3, "< OK >", "sel")
        ui.c.hide_cursor()
        ui.c.refresh()
        k = ui.c.getkey()
        if k in ("enter", "esc", "space"):
            return


def choose(ui, title, lines, buttons, default=0):
    body = wrap([(l, "normal") if isinstance(l, str) else l for l in lines], 64)
    sel = default
    while True:
        ui.redraw_under()
        y, x, h, w = _box(ui, title, 70, len(body) + 5)
        for i, (t, a) in enumerate(body[:h - 4]):
            ui.c.put(y + 2 + i, x + 3, t, a)
        labels = [f"< {b} >" for b in buttons]
        total = sum(len(l) for l in labels) + 3 * (len(labels) - 1)
        bx = x + max(2, (w - total) // 2)
        for i, l in enumerate(labels):
            ui.c.put(y + h - 2, bx, l, "sel" if i == sel else "normal")
            bx += len(l) + 3
        ui.c.hide_cursor()
        ui.c.refresh()
        k = ui.c.getkey()
        if k in ("left", "btab", "h", "up"):
            sel = (sel - 1) % len(buttons)
        elif k in ("right", "tab", "l", "down"):
            sel = (sel + 1) % len(buttons)
        elif k in ("enter", "space"):
            return sel
        elif k == "esc":
            return None
        else:
            for i, b in enumerate(buttons):
                if len(k) == 1 and b.lower().startswith(k.lower()):
                    return i


def confirm(ui, title, lines, yes="Yes", no="No", default_yes=False):
    return choose(ui, title, lines, [yes, no], 0 if default_yes else 1) == 0


def loading(ui, text, fn):
    ui.redraw_under()
    y, x, h, w = _box(ui, "", max(30, len(text) + 8), 5)
    ui.c.put(y + 2, x + 3, text, "bold")
    ui.c.hide_cursor()
    ui.c.refresh()
    return fn()


def text_view(ui, title, lines, footer="PgUp/PgDn scroll  Esc back"):
    scroll = 0
    while True:
        top, bottom = ui.frame(title, footer=footer)
        c = ui.c
        c.hline(top, 0, c.w)
        c.hline(bottom, 0, c.w)
        hgt = bottom - top - 1
        rows = wrap(lines, c.w - 4)
        scroll = draw_preview(c, top + 1, 2, hgt, c.w - 4, lines, scroll)
        c.refresh()
        k = c.getkey()
        if k in ("pgdn", "space"):
            scroll += hgt - 1
        elif k in ("pgup",):
            scroll -= hgt - 1
        elif k in ("down", "j"):
            scroll += 1
        elif k in ("up", "k"):
            scroll -= 1
        elif k == "home":
            scroll = 0
        elif k == "end":
            scroll = len(rows)
        elif k in ("esc", "enter", "q"):
            return
        scroll = max(0, scroll)


def _rank(rows, needle):
    if not needle:
        return rows
    n = needle.lower()
    exact, first, second = [], [], []
    for r in rows:
        s = r.get("search") or " ".join(r["cols"])
        s = s.lower()
        if n not in s:
            continue
        words = s.replace("/", " ").replace("_", " ").replace("(", " ").split()
        if r["cols"] and r["cols"][0].lower() == n:
            exact.append(r)
        elif s.startswith(n) or any(w.startswith(n) for w in words):
            first.append(r)
        else:
            second.append(r)
    return exact + first + second


def pick(ui, title, rows, current=None, header=None, preview=None, preview_pos="right", typing=False,
         extra_keys=(), footer="", note="", multi=None, add=None):
    """Full-screen list. Returns the chosen value, an Extra, a set (multi) or None."""
    flt, filtering, scroll = "", False, 0
    selected = set(multi) if multi is not None else None
    view = ListView([], 0)
    first = True
    while True:
        shown = _rank(rows, flt)
        old = view.rows[view.sel]["value"] if view.rows and view.sel < len(view.rows) else None
        view.rows = shown
        if first:
            first = False
            for i, r in enumerate(shown):
                if r["value"] == current and r.get("selectable", True):
                    view.sel = i
        elif old is not None:
            idx = next((i for i, r in enumerate(shown) if r["value"] == old), None)
            view.sel = idx if idx is not None else 0
        view.fix()
        c = ui.c
        count = f"{len(shown)} of {len(rows)}" if flt else f"{len(rows)} item{'' if len(rows) == 1 else 's'}"
        keys = footer or ("Space tick  Enter done  Esc cancel" if multi is not None else "Enter choose  Esc cancel")
        if add:
            keys += "  + add name"
        foot = (f"/{flt}_   " if filtering or flt else "/ search   ") + keys + "  F1 help"
        top, bottom = ui.frame(title, right=count, footer=foot)
        cur = shown[view.sel] if shown and view.selectable(view.sel) else None
        plines = preview(cur["value"]) if (preview and cur) else []
        if preview and preview_pos == "right":
            split = split_body(c, top, bottom)
            lx, lw = 1, split - 2
            scroll = draw_preview(c, top + 1, split + 2, bottom - top - 1, c.w - split - 4, plines, scroll)
            ly, lh = top + 1, bottom - top - 1
        else:
            c.hline(top, 0, c.w)
            c.hline(bottom, 0, c.w)
            lx, lw, ly = 1, c.w - 3, top + 1
            lh = bottom - top - 1
            if preview:
                ph = max(4, min(len(plines) + 1, lh // 2))
                lh -= ph
                c.hline(ly + lh, 0, c.w)
                draw_preview(c, ly + lh + 1, 2, ph - 1, c.w - 4, plines, 0)
        if header:
            c.put(ly, lx + (6 if multi is not None else 2), _cols(header, widths(rows, header, lw)), "bold")
            ly, lh = ly + 1, lh - 1
        if note:
            lh -= 1
            c.put(ly + lh, lx + 2, note, "dim")
        w = widths(rows, header, lw)

        def render(cv, y, x, width, row, sel):
            mark = ""
            if selected is not None:
                mark = "[x] " if row["value"] in selected else "[ ] "
            attr = "sel" if sel else row.get("attr") or ("dim" if not row.get("selectable", True) else "normal")
            text = f"{'>' if sel else ' '} {mark}{_cols(row['cols'], w)}"
            cv.put(y, x, text.ljust(width)[:width], attr)
            if sel:
                cv.put(y, x, ">", "sel")
        if not shown:
            c.put(ly, lx + 2, "No match." if flt else "Nothing to show.", "dim")
        view.draw(c, ly, lx, lh, lw, render)
        c.hide_cursor()
        c.refresh()
        k = c.getkey()
        if k == "resize":
            continue
        if filtering or typing:
            if k == "esc" and flt:
                flt, filtering = "", False
                continue
            if k == "backspace" and flt:
                flt = flt[:-1]
                filtering = bool(flt) or not typing and filtering
                continue
            if len(k) == 1 and k.isprintable() and k != "/" and not (k == "+" and add):
                flt += k
                filtering = True
                continue
        if k == "/":
            filtering = True
            continue
        if view.nav(k, lh, letters=not typing and not filtering):
            scroll = 0
            continue
        if k in ("f1", "?"):
            help_screen(ui)
        elif k == "esc":
            return None
        elif k == "space" and selected is not None and cur:
            selected.symmetric_difference_update({cur["value"]})
        elif k == "enter":
            if selected is not None:
                if not selected and cur:
                    selected.add(cur["value"])
                return selected
            if cur:
                return cur["value"]
        elif k == "+" and add:
            res = form(ui, "Add a name", [{"key": "name", "label": "Name", "value": flt, "validate": add}])
            if res:
                name = res["name"].strip()
                if not any(r["value"] == name for r in rows):
                    rows.append({"cols": [name, "(not in the index)"], "value": name})
                if selected is not None:
                    selected.add(name)
                flt = ""
        elif k in extra_keys:
            return Extra(k, cur["value"] if cur else None)
        elif k.isdigit() and k != "0" and not typing:
            view.jump(int(k))


def widths(rows, header, total):
    n = max([len(r["cols"]) for r in rows] + [len(header or [])] + [1])
    ws = [0] * n
    for r in rows[:2000]:
        for i, col in enumerate(r["cols"]):
            ws[i] = max(ws[i], len(col))
    for i, col in enumerate(header or []):
        ws[i] = max(ws[i], len(col))
    avail = total - 8 - 2 * (n - 1)
    while sum(ws) > avail and max(ws) > 8:
        i = ws.index(max(ws))
        ws[i] -= 1
    return ws


def _cols(cols, ws):
    out = []
    for i, col in enumerate(cols):
        w = ws[i] if i < len(ws) else len(col)
        col = col if len(col) <= w else col[:max(1, w - 1)] + "~"
        out.append(col.ljust(w) if i < len(cols) - 1 else col)
    return "  ".join(out)


def form(ui, title, fields, check=None, warn=None, note=None, ok="OK"):
    """Fields: dicts with key, label, value, mask, validate(v)->err, hint(v)->(text, attr)."""
    tf = [TextField(f.get("value", ""), f.get("mask", False), 34) for f in fields]
    focus, err, err_field, warned = 0, "", None, None
    label_w = max(len(f["label"]) for f in fields) + 2
    while True:
        ui.redraw_under()
        rows = 2 * len(fields) + 6 + (1 if note else 0)
        y, x, h, w = _box(ui, title, label_w + 34 + 10, rows)
        r = y + 2
        if note:
            ui.c.put(r - 1, x + 3, note[:w - 6], "dim")
            r += 1
        cursor = None
        for i, (f, t) in enumerate(zip(fields, tf)):
            ui.c.put(r, x + 3, f["label"], "bold" if i == focus else "normal")
            t.draw(ui.c, r, x + 3 + label_w, i == focus)
            if i == focus:
                cursor = (r, x + 3 + label_w + min(t.pos, t.width - 1))
            msg, attr = "", "normal"
            if err and err_field == i:
                msg, attr = err, "err"
            elif f.get("hint"):
                msg, attr = f["hint"](t.value, [x.value for x in tf])
                attr = attr or "normal"
            ui.c.put(r + 1, x + 3 + label_w, (msg or "")[:w - label_w - 6], attr)
            r += 2
        if err and err_field is None:
            ui.c.put(r, x + 3, err[:w - 6], "err")
        if warned:
            ui.c.put(r, x + 3, warned[:w - 6], "warn")
        btn = len(fields)
        has_mask = any(f.get("mask") for f in fields)
        line = f"< {ok} >     < Cancel >" + ("     F2 show" if has_mask else "")
        ui.c.put(y + h - 2, x + max(2, (w - len(line)) // 2), line, "sel" if focus == btn else "normal")
        if focus < btn and cursor:
            tf[focus].draw(ui.c, cursor[0], x + 3 + label_w, True)
        else:
            ui.c.hide_cursor()
        ui.c.refresh()
        k = ui.c.getkey()
        if k == "esc":
            ui.c.hide_cursor()
            return None
        if k == "f2":
            for t in tf:
                t.show = not t.show
            continue
        if k in ("tab", "down"):
            focus = (focus + 1) % (btn + 1)
            continue
        if k in ("btab", "up"):
            focus = (focus - 1) % (btn + 1)
            continue
        if k == "enter":
            if focus < btn - 1 and not fields[focus].get("last_submits"):
                focus += 1
                continue
            vals = {f["key"]: t.value for f, t in zip(fields, tf)}
            err, err_field = "", None
            for i, f in enumerate(fields):
                e = f.get("validate", lambda v: "")(tf[i].value)
                if e:
                    err, err_field, focus = e, i, i
                    break
            if not err and check:
                e, key = check(vals)
                if e:
                    err = e
                    err_field = next((i for i, f in enumerate(fields) if f["key"] == key), None)
                    if err_field is not None:
                        focus = err_field
            if err:
                warned = None
                continue
            if warn:
                msg = warn(vals)
                if msg and warned != msg:
                    warned = msg
                    continue
            ui.c.hide_cursor()
            return vals
        if focus < btn:
            if tf[focus].key(k):
                err, warned = "", None


def countdown(ui, seconds=5):
    for n in range(seconds, 0, -1):
        ui.redraw_under()
        y, x, h, w = _box(ui, "Starting the installation", 56, 7)
        ui.c.put(y + 2, x + 3, "Starting in " + " ... ".join(str(i) for i in range(seconds, n - 1, -1)), "bold")
        ui.c.put(y + 3, x + 3, "Nothing has been written yet.")
        ui.c.put(y + 4, x + 3, "Press any key to go back.", "warn")
        ui.c.hide_cursor()
        ui.c.refresh()
        if _key_within(ui.c, 1.0):
            return False
    return True


def _key_within(canvas, secs):
    scr = getattr(canvas, "scr", None)
    if scr is None:
        return bool(getattr(canvas, "keys", None)) and canvas.getkey() is not None
    scr.timeout(int(secs * 1000))
    try:
        ch = scr.getch()
    finally:
        scr.timeout(-1)
    if ch == -1:
        return False
    return True
