from .dialogs import help_screen
from .widgets import ListView, draw_preview, split_body


class Done(Exception):
    def __init__(self, result):
        super().__init__(result)
        self.result = result


class Item:
    def __init__(self, label, value=None, action=None, preview=None, missing=None, readonly=False,
                 reset=None, toggle=None, kind="item", visible=None):
        self.label = label
        self.value = value or (lambda: "")
        self.action = action
        self.preview = preview or (lambda: [])
        self.missing = missing or (lambda: False)
        self.readonly = readonly
        self.reset = reset
        self.toggle = toggle
        self.kind = kind
        self.visible = visible or (lambda: True)


def blank():
    return Item("", kind="blank")


def back():
    return Item("<- Back", kind="back", preview=lambda: ["Return to the previous menu."])


class Menu:
    def __init__(self, ui, path, items, main=False, footer=None, right=""):
        self.ui = ui
        self.path = path
        self.items = items
        self.main = main
        self.footer = footer or ("Enter edit  F10 install  F1 help  Ctrl+Q quit       * required" if main
                                 else "Enter edit  Space toggle  Esc back  Ctrl+C default  F1 help")
        self.right = right
        self.view = ListView([])
        self.scroll = 0
        self.lh = 10

    def rows(self):
        items = self.items() if callable(self.items) else self.items
        shown = [i for i in items if i.visible()]
        return [{"item": i, "selectable": i.kind != "blank" and not i.readonly} for i in shown]

    def draw(self):
        ui, c = self.ui, self.ui.c
        if ui.too_small():
            ui.small_screen()
            return
        top, bottom = ui.frame(self.path, self.right, self.footer)
        split = split_body(c, top, bottom)
        self.lh = bottom - top - 1
        label_w = max([len(r["item"].label) for r in self.view.rows] + [10]) + 2
        cur = self.view.rows[self.view.sel]["item"] if self.view.rows else None

        def render(cv, y, x, w, row, sel):
            it = row["item"]
            if it.kind == "blank":
                return
            val = it.value() if it.kind == "item" else ""
            miss = it.missing()
            text = f"  {it.label:<{label_w}}{val}"
            attr = "sel" if sel else ("dim" if it.readonly else "normal")
            cv.put(y, x, text.ljust(w - 2)[:w - 2], attr)
            if sel:
                cv.put(y, x, ">", "sel")
            if miss:
                cv.put(y, x + w - 2, "*", "err")
        self.view.draw(c, top + 1, 1, self.lh, split - 1, render)
        lines = cur.preview() if cur else []
        self.scroll = draw_preview(c, top + 1, split + 2, self.lh, c.w - split - 4, lines, self.scroll)
        c.hide_cursor()
        c.refresh()

    def run(self):
        self.view = ListView(self.rows(), self.view.sel)
        self.ui.push(self.draw)
        try:
            while True:
                old = self.view.sel
                self.view.rows = self.rows()
                self.view.fix()
                self.draw()
                k = self.ui.c.getkey()
                cur = self.view.rows[self.view.sel]["item"] if self.view.rows else None
                if k == "t" and self.ui.too_small():
                    raise Done("text")
                if k in ("pgup", "pgdn"):
                    self.scroll += -3 if k == "pgup" else 3
                    continue
                if self.view.nav(k, self.lh):
                    pass
                elif k.isdigit() and k != "0":
                    self.view.jump(int(k))
                elif k in ("f1", "?"):
                    help_screen(self.ui)
                elif k == "f10" and self.ui.on_install:
                    self.ui.on_install()
                elif k == "ctrl-q" and self.ui.on_abort:
                    self.ui.on_abort()
                elif k == "esc" and not self.main:
                    return None
                elif k == "ctrl-c" and cur and cur.reset:
                    cur.reset()
                elif k == "space" and cur and cur.toggle:
                    cur.toggle()
                elif k == "enter" and cur:
                    if cur.kind == "back":
                        return None
                    if cur.action:
                        cur.action()
                    elif cur.toggle:
                        cur.toggle()
                if self.view.sel != old:
                    self.scroll = 0
        finally:
            self.ui.pop()
