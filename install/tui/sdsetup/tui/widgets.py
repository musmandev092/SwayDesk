import textwrap

from .canvas import MIN_H, MIN_W


def wrap(lines, width):
    out = []
    for item in lines:
        text, attr = (item, "normal") if isinstance(item, str) else item
        if not text:
            out.append(("", attr))
            continue
        indent = len(text) - len(text.lstrip(" "))
        for i, part in enumerate(textwrap.wrap(text, max(4, width), subsequent_indent=" " * indent,
                                               break_long_words=True, drop_whitespace=True) or [""]):
            out.append((part, attr))
    return out


class UI:
    def __init__(self, canvas, title="SwayDesk installer", badge=""):
        self.c = canvas
        self.title = title
        self.badge = badge
        self.layers = []
        self.on_install = None
        self.on_abort = None

    def too_small(self):
        h, w = self.c._size()
        return h < MIN_H or w < MIN_W

    def small_screen(self):
        c = self.c
        c.clear()
        c.put(0, 0, f"Screen too small: {c.w}x{c.h}, need {MIN_W}x{MIN_H}.", "err")
        c.put(1, 0, "Enlarge the terminal, or press t for text mode.")
        c.refresh()

    def frame(self, path="", right="", footer=""):
        c = self.c
        c.clear()
        h, w = c.size()
        title = f" {self.title}" + (f" > {path}" if path else "")
        c.fill(0, 0, 1, w, "title")
        c.put(0, 0, title[:w], "title")
        right = right or self.badge
        if right and len(title) + len(right) + 3 < w:
            c.put(0, w - len(right) - 2, right, "title")
        c.put(h - 1, 1, footer[:w - 2], "help")
        return 1, h - 2

    def redraw_under(self):
        if self.layers:
            self.layers[-1]()
        else:
            self.c.clear()

    def push(self, draw):
        self.layers.append(draw)

    def pop(self):
        if self.layers:
            self.layers.pop()


class TextField:
    def __init__(self, value="", mask=False, width=30):
        self.value = value
        self.pos = len(value)
        self.mask = mask
        self.show = False
        self.width = width

    def key(self, k):
        v, p = self.value, self.pos
        if k == "left":
            self.pos = max(0, p - 1)
        elif k == "right":
            self.pos = min(len(v), p + 1)
        elif k == "home":
            self.pos = 0
        elif k == "end":
            self.pos = len(v)
        elif k == "backspace":
            if p > 0:
                self.value, self.pos = v[:p - 1] + v[p:], p - 1
        elif k == "delete":
            self.value = v[:p] + v[p + 1:]
        elif k == "ctrl-u":
            self.value, self.pos = "", 0
        elif k == "space":
            self.value, self.pos = v[:p] + " " + v[p:], p + 1
        elif len(k) == 1 and k.isprintable():
            self.value, self.pos = v[:p] + k + v[p:], p + 1
        else:
            return False
        return True

    def display(self):
        return "*" * len(self.value) if self.mask and not self.show else self.value

    def draw(self, c, y, x, focus):
        w = self.width
        text = self.display()
        start = max(0, self.pos - w + 1)
        shown = text[start:start + w]
        c.put(y, x, shown + "_" * (w - len(shown)), "field" if focus else "normal")
        if focus:
            c.show_cursor(y, x + self.pos - start)


class ListView:
    def __init__(self, rows, sel=0):
        self.rows = rows
        self.sel = sel
        self.top = 0
        self.fix()

    def selectable(self, i):
        return 0 <= i < len(self.rows) and self.rows[i].get("selectable", True)

    def fix(self):
        if not self.rows:
            self.sel = 0
            return
        self.sel = max(0, min(self.sel, len(self.rows) - 1))
        if not self.selectable(self.sel):
            self.move(1) or self.move(-1)

    def move(self, d):
        i = self.sel + d
        while 0 <= i < len(self.rows):
            if self.selectable(i):
                self.sel = i
                return True
            i += 1 if d > 0 else -1
        return False

    def home(self):
        self.sel = -1
        self.move(1)

    def end(self):
        self.sel = len(self.rows)
        self.move(-1)

    def page(self, d, h):
        for _ in range(max(1, h - 1)):
            if not self.move(d):
                break

    def jump(self, n):
        count = 0
        for i, r in enumerate(self.rows):
            if self.selectable(i):
                count += 1
                if count == n:
                    self.sel = i
                    return True
        return False

    def nav(self, k, h, letters=True):
        if k in ("up",) or (letters and k == "k"):
            self.move(-1)
        elif k in ("down",) or (letters and k == "j"):
            self.move(1)
        elif k == "home":
            self.home()
        elif k == "end":
            self.end()
        elif k == "pgup":
            self.page(-1, h)
        elif k == "pgdn":
            self.page(1, h)
        else:
            return False
        return True

    def draw(self, c, y, x, h, w, render):
        if self.sel < self.top:
            self.top = self.sel
        if self.sel >= self.top + h:
            self.top = self.sel - h + 1
        self.top = max(0, min(self.top, max(0, len(self.rows) - h)))
        for i in range(h):
            j = self.top + i
            if j >= len(self.rows):
                break
            render(c, y + i, x, w, self.rows[j], j == self.sel)
        if len(self.rows) > h and h > 2:
            c.put(y, x + w, "^" if self.top > 0 else " ", "frame")
            c.put(y + h - 1, x + w, "v" if self.top + h < len(self.rows) else " ", "frame")


def split_body(c, top, bottom, left_ratio=0.56, min_left=42):
    h, w = c.size()
    split = max(min_left, int(w * left_ratio))
    c.hline(top, 0, w)
    c.hline(bottom, 0, w)
    c.vline(top, split, bottom - top + 1)
    c.tee(top, split, "top")
    c.tee(bottom, split, "bottom")
    return split


def draw_preview(c, y, x, h, w, lines, scroll=0):
    rows = wrap(lines, w)
    scroll = max(0, min(scroll, max(0, len(rows) - h)))
    for i, (text, attr) in enumerate(rows[scroll:scroll + h]):
        c.put(y + i, x, text[:w], attr)
    if len(rows) > h:
        c.put(y, x + w, "^" if scroll > 0 else " ", "frame")
        c.put(y + h - 1, x + w, "v" if scroll + h < len(rows) else " ", "frame")
    return scroll
