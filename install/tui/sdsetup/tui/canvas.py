import os
import unicodedata

ATTRS = ("normal", "title", "sel", "cursor", "err", "warn", "ok", "dim", "help", "frame", "bold", "field")
MIN_H, MIN_W = 24, 80


class KeysExhausted(Exception):
    pass


def clean(text):
    return "".join(c if c.isprintable() and unicodedata.category(c) != "Cf" else "?" for c in str(text))


class Canvas:
    def __init__(self, mirror=None):
        self.mirror = mirror
        self._last = None
        self.h, self.w = 0, 0
        self.buf = []

    def size(self):
        return self.h, self.w

    def clear(self):
        self.h, self.w = self._size()
        self.buf = [[" "] * self.w for _ in range(self.h)]
        self._clear()

    def put(self, y, x, text, attr="normal"):
        if y < 0 or y >= self.h or x >= self.w:
            return
        text = clean(text)
        if x < 0:
            text, x = text[-x:], 0
        text = text[:self.w - x]
        if y == self.h - 1 and x + len(text) >= self.w:
            text = text[:self.w - x - 1]
        if not text:
            return
        self.buf[y][x:x + len(text)] = list(text)
        self._put(y, x, text, attr)

    def fill(self, y, x, h, w, attr="normal"):
        for r in range(y, y + h):
            self.put(r, x, " " * w, attr)

    def hline(self, y, x, n, attr="frame"):
        if 0 <= y < self.h:
            for c in range(max(0, x), min(self.w, x + n)):
                self.buf[y][c] = "-"
            self._hline(y, x, n, attr)

    def vline(self, y, x, n, attr="frame"):
        if 0 <= x < self.w:
            for r in range(max(0, y), min(self.h, y + n)):
                self.buf[r][x] = "|"
            self._vline(y, x, n, attr)

    def box(self, y, x, h, w, attr="frame"):
        self.fill(y, x, h, w)
        self.hline(y, x, w, attr)
        self.hline(y + h - 1, x, w, attr)
        self.vline(y, x, h, attr)
        self.vline(y, x + w - 1, h, attr)
        for (r, c) in ((y, x), (y, x + w - 1), (y + h - 1, x), (y + h - 1, x + w - 1)):
            if 0 <= r < self.h and 0 <= c < self.w:
                self.buf[r][c] = "+"
        self._corners(y, x, h, w, attr)

    def tee(self, y, x, kind, attr="frame"):
        if 0 <= y < self.h and 0 <= x < self.w:
            self.buf[y][x] = "+"
            self._tee(y, x, kind, attr)

    def dump(self):
        return ["".join(r).rstrip() for r in self.buf]

    def refresh(self):
        self._refresh()
        if self.mirror:
            text = "\n".join(self.dump())
            if text != self._last:
                self._last = text
                try:
                    self.mirror.write("\n==SCREEN==\n" + text + "\n==END==\n")
                    self.mirror.flush()
                except OSError:
                    pass

    def show_cursor(self, y, x):
        pass

    def hide_cursor(self):
        pass

    def _size(self):
        return MIN_H, MIN_W

    def _clear(self):
        pass

    def _put(self, y, x, text, attr):
        pass

    def _hline(self, y, x, n, attr):
        pass

    def _vline(self, y, x, n, attr):
        pass

    def _corners(self, y, x, h, w, attr):
        pass

    def _tee(self, y, x, kind, attr):
        pass

    def _refresh(self):
        pass


class Headless(Canvas):
    def __init__(self, keys=(), size=(30, 100), mirror=None):
        super().__init__(mirror)
        self.keys = list(keys)
        self.dims = size
        self.frames = []

    def _size(self):
        return self.dims

    def _refresh(self):
        self.frames.append(self.dump())

    def getkey(self):
        if not self.keys:
            raise KeysExhausted()
        return self.keys.pop(0)

    def text(self):
        return "\n".join(self.dump())


class Curses(Canvas):
    def __init__(self, scr, mirror=None):
        import curses
        super().__init__(mirror)
        self.c = curses
        self.scr = scr
        self.attrs = self._init_colors()
        scr.keypad(True)
        curses.raw()
        curses.noecho()
        self.hide_cursor()

    def _init_colors(self):
        c = self.c
        a = {n: c.A_NORMAL for n in ATTRS}
        a.update(bold=c.A_BOLD, dim=c.A_DIM, sel=c.A_REVERSE | c.A_BOLD, title=c.A_REVERSE | c.A_BOLD,
                 err=c.A_BOLD, warn=c.A_BOLD, field=c.A_UNDERLINE)
        try:
            if c.has_colors():
                c.start_color()
                pairs = {
                    "title": (c.COLOR_WHITE, c.COLOR_BLUE, c.A_BOLD), "sel": (c.COLOR_WHITE, c.COLOR_BLUE, c.A_BOLD),
                    "cursor": (c.COLOR_CYAN, c.COLOR_BLACK, c.A_BOLD), "err": (c.COLOR_RED, c.COLOR_BLACK, c.A_BOLD),
                    "warn": (c.COLOR_YELLOW, c.COLOR_BLACK, c.A_BOLD), "ok": (c.COLOR_GREEN, c.COLOR_BLACK, c.A_BOLD),
                    "help": (c.COLOR_GREEN, c.COLOR_BLACK, 0), "frame": (c.COLOR_CYAN, c.COLOR_BLACK, 0),
                    "normal": (c.COLOR_WHITE, c.COLOR_BLACK, 0), "dim": (c.COLOR_BLUE, c.COLOR_BLACK, c.A_BOLD),
                    "bold": (c.COLOR_WHITE, c.COLOR_BLACK, c.A_BOLD), "field": (c.COLOR_WHITE, c.COLOR_BLUE, 0),
                }
                for i, (name, (fg, bg, extra)) in enumerate(pairs.items(), start=1):
                    c.init_pair(i, fg, bg)
                    a[name] = c.color_pair(i) | extra
                self.scr.bkgd(" ", a["normal"])
        except c.error:
            pass
        return a

    def _size(self):
        return self.scr.getmaxyx()

    def _clear(self):
        self.scr.erase()

    def _put(self, y, x, text, attr):
        try:
            self.scr.addstr(y, x, text, self.attrs.get(attr, 0))
        except self.c.error:
            pass

    def _hline(self, y, x, n, attr):
        try:
            self.scr.hline(y, max(0, x), self.c.ACS_HLINE | self.attrs[attr], min(n, self.w - max(0, x)))
        except self.c.error:
            pass

    def _vline(self, y, x, n, attr):
        try:
            self.scr.vline(max(0, y), x, self.c.ACS_VLINE | self.attrs[attr], min(n, self.h - max(0, y)))
        except self.c.error:
            pass

    def _corners(self, y, x, h, w, attr):
        c, a = self.c, self.attrs[attr]
        for (r, col, ch) in ((y, x, c.ACS_ULCORNER), (y, x + w - 1, c.ACS_URCORNER),
                             (y + h - 1, x, c.ACS_LLCORNER), (y + h - 1, x + w - 1, c.ACS_LRCORNER)):
            try:
                self.scr.addch(r, col, ch | a)
            except c.error:
                pass

    def _tee(self, y, x, kind, attr):
        c = self.c
        ch = {"top": c.ACS_TTEE, "bottom": c.ACS_BTEE, "left": c.ACS_LTEE, "right": c.ACS_RTEE}[kind]
        try:
            self.scr.addch(y, x, ch | self.attrs[attr])
        except c.error:
            pass

    def _refresh(self):
        self.scr.refresh()

    def show_cursor(self, y, x):
        try:
            self.c.curs_set(1)
            self.scr.move(y, x)
        except self.c.error:
            pass

    def hide_cursor(self):
        try:
            self.c.curs_set(0)
        except self.c.error:
            pass

    KEYMAP = None

    def getkey(self):
        c = self.c
        if Curses.KEYMAP is None:
            Curses.KEYMAP = {
                c.KEY_UP: "up", c.KEY_DOWN: "down", c.KEY_LEFT: "left", c.KEY_RIGHT: "right",
                c.KEY_HOME: "home", c.KEY_END: "end", c.KEY_PPAGE: "pgup", c.KEY_NPAGE: "pgdn",
                c.KEY_ENTER: "enter", c.KEY_BACKSPACE: "backspace", c.KEY_DC: "delete", c.KEY_BTAB: "btab",
                c.KEY_RESIZE: "resize", c.KEY_F1: "f1", c.KEY_F2: "f2", c.KEY_F10: "f10",
                c.KEY_LL: "end", c.KEY_A1: "home", c.KEY_C1: "end",
            }
        while True:
            try:
                ch = self.scr.get_wch()
            except c.error:
                continue
            except KeyboardInterrupt:
                return "ctrl-c"
            if isinstance(ch, int):
                k = Curses.KEYMAP.get(ch)
                if k:
                    return k
                continue
            o = ord(ch)
            if ch in "\r\n":
                return "enter"
            if o == 27:
                return "esc"
            if ch == "\t":
                return "tab"
            if o in (8, 127):
                return "backspace"
            if o == 3:
                return "ctrl-c"
            if o == 17:
                return "ctrl-q"
            if o == 21:
                return "ctrl-u"
            if ch == " ":
                return "space"
            if o < 32:
                continue
            return ch


def run_curses(fn, mirror=None):
    import curses
    os.environ.setdefault("ESCDELAY", "25")

    def wrapper(scr):
        return fn(Curses(scr, mirror))
    return curses.wrapper(wrapper)
