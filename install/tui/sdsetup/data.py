import datetime
import gzip
import os

XKB_LISTS = ("/usr/share/X11/xkb/rules/evdev.lst", "/usr/share/xkeyboard-config-2/rules/evdev.lst")
KBD_MODEL_MAP = "/usr/share/systemd/kbd-model-map"
XKB_KEYMAPS = "/usr/lib/kbd/keymaps/xkb"
ZONEINFO = "/usr/share/zoneinfo"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FALLBACK_LAYOUTS = [
    ("us", "", "English (US)"), ("us", "intl", "English (US, intl., with dead keys)"),
    ("gb", "", "English (UK)"), ("de", "", "German"), ("de", "nodeadkeys", "German (no dead keys)"),
    ("fr", "", "French"), ("es", "", "Spanish"), ("it", "", "Italian"), ("pk", "urd-phonetic", "Urdu (phonetic)"),
    ("ara", "", "Arabic"), ("in", "", "Indian"), ("ru", "", "Russian"), ("tr", "", "Turkish"),
]

LOCALES = [
    ("en_US.UTF-8", "English (US)"), ("en_GB.UTF-8", "English (UK)"), ("en_CA.UTF-8", "English (Canada)"),
    ("en_AU.UTF-8", "English (Australia)"), ("en_IN.UTF-8", "English (India)"), ("en_IE.UTF-8", "English (Ireland)"),
    ("en_NZ.UTF-8", "English (New Zealand)"), ("en_ZA.UTF-8", "English (South Africa)"),
    ("en_DK.UTF-8", "English (Denmark)"), ("ur_PK.UTF-8", "Urdu (Pakistan)"), ("ur_IN.UTF-8", "Urdu (India)"),
    ("ar_SA.UTF-8", "Arabic (Saudi Arabia)"), ("ar_EG.UTF-8", "Arabic (Egypt)"), ("ar_AE.UTF-8", "Arabic (UAE)"),
    ("fa_IR.UTF-8", "Persian (Iran)"), ("hi_IN.UTF-8", "Hindi (India)"), ("bn_BD.UTF-8", "Bengali (Bangladesh)"),
    ("bn_IN.UTF-8", "Bengali (India)"), ("pa_IN.UTF-8", "Punjabi (India)"), ("pa_PK.UTF-8", "Punjabi (Pakistan)"),
    ("ta_IN.UTF-8", "Tamil (India)"), ("te_IN.UTF-8", "Telugu (India)"), ("de_DE.UTF-8", "German (Germany)"),
    ("de_AT.UTF-8", "German (Austria)"), ("de_CH.UTF-8", "German (Switzerland)"), ("fr_FR.UTF-8", "French (France)"),
    ("fr_CA.UTF-8", "French (Canada)"), ("fr_BE.UTF-8", "French (Belgium)"), ("fr_CH.UTF-8", "French (Switzerland)"),
    ("es_ES.UTF-8", "Spanish (Spain)"), ("es_MX.UTF-8", "Spanish (Mexico)"), ("es_AR.UTF-8", "Spanish (Argentina)"),
    ("pt_BR.UTF-8", "Portuguese (Brazil)"), ("pt_PT.UTF-8", "Portuguese (Portugal)"), ("it_IT.UTF-8", "Italian"),
    ("nl_NL.UTF-8", "Dutch"), ("nl_BE.UTF-8", "Dutch (Belgium)"), ("sv_SE.UTF-8", "Swedish"),
    ("nb_NO.UTF-8", "Norwegian Bokmal"), ("da_DK.UTF-8", "Danish"), ("fi_FI.UTF-8", "Finnish"),
    ("pl_PL.UTF-8", "Polish"), ("cs_CZ.UTF-8", "Czech"), ("sk_SK.UTF-8", "Slovak"), ("hu_HU.UTF-8", "Hungarian"),
    ("ro_RO.UTF-8", "Romanian"), ("bg_BG.UTF-8", "Bulgarian"), ("el_GR.UTF-8", "Greek"),
    ("ru_RU.UTF-8", "Russian"), ("uk_UA.UTF-8", "Ukrainian"), ("tr_TR.UTF-8", "Turkish"),
    ("he_IL.UTF-8", "Hebrew"), ("zh_CN.UTF-8", "Chinese (Simplified)"), ("zh_TW.UTF-8", "Chinese (Traditional)"),
    ("ja_JP.UTF-8", "Japanese"), ("ko_KR.UTF-8", "Korean"), ("th_TH.UTF-8", "Thai"),
    ("vi_VN.UTF-8", "Vietnamese"), ("id_ID.UTF-8", "Indonesian"), ("ms_MY.UTF-8", "Malay"),
]


def langpack(locale):
    return "glibc-langpack-" + locale.split("_")[0].split(".")[0]


def locale_name(code):
    return dict(LOCALES).get(code, code)


def keymaps():
    for path in XKB_LISTS:
        if os.path.exists(path):
            return _parse_evdev(path)
    return list(FALLBACK_LAYOUTS)


def _parse_evdev(path):
    layouts, section, out = {}, None, []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("!"):
                section = line[1:].strip()
                continue
            parts = line.strip().split(None, 1)
            if len(parts) != 2:
                continue
            if section == "layout":
                layouts[parts[0]] = parts[1]
                out.append((parts[0], "", parts[1]))
            elif section == "variant":
                base, _, desc = parts[1].partition(": ")
                if base in layouts:
                    out.append((base, parts[0], desc))
    return out


def layout_exists(layout, variant=""):
    return any(l == layout and v == (variant or "") for l, v, _ in keymaps())


def layout_name(layout, variant=""):
    for l, v, d in keymaps():
        if l == layout and v == (variant or ""):
            return d
    return f"{layout} ({variant})" if variant else layout


def console_keymap(layout, variant=""):
    names = [f"{layout}-{variant}", layout] if variant else [layout]
    for n in names:
        if os.path.exists(os.path.join(XKB_KEYMAPS, n + ".map.gz")) or os.path.exists(os.path.join(XKB_KEYMAPS, n + ".map")):
            return n
    if os.path.exists(KBD_MODEL_MAP):
        with open(KBD_MODEL_MAP) as f:
            rows = [l.split() for l in f if l.strip() and not l.startswith("#")]
        for r in rows:
            if len(r) >= 4 and r[1].split(",")[0] == layout and (r[3] == (variant or "-") or (not variant and r[3] == "-")):
                return r[0]
    return layout if not variant else f"{layout}-{variant}"


def zones():
    path = os.path.join(ZONEINFO, "zone1970.tab")
    countries = {}
    try:
        with open(os.path.join(ZONEINFO, "iso3166.tab"), encoding="utf-8") as f:
            for line in f:
                if line.strip() and not line.startswith("#"):
                    code, name = line.rstrip("\n").split("\t", 1)
                    countries[code] = name
    except OSError:
        pass
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if line.startswith("#") or not line.strip():
                    continue
                cols = line.rstrip("\n").split("\t")
                if len(cols) >= 3:
                    codes = cols[0].split(",")
                    out.append((cols[2], countries.get(codes[0], codes[0])))
    except OSError:
        out = [("Asia/Karachi", "Pakistan"), ("Europe/London", "Britain (UK)"), ("America/New_York", "United States")]
    out.append(("UTC", ""))
    out.sort()
    return out


def zone_exists(zone):
    if not zone or ".." in zone or zone.startswith("/"):
        return False
    return os.path.isfile(os.path.join(ZONEINFO, zone))


def utc_offset(zone):
    try:
        from zoneinfo import ZoneInfo
        off = datetime.datetime.now(ZoneInfo(zone)).utcoffset()
    except Exception:
        return ""
    mins = int(off.total_seconds() // 60)
    sign = "+" if mins >= 0 else "-"
    mins = abs(mins)
    return f"UTC{sign}{mins // 60:02d}:{mins % 60:02d}"


def local_time(zone):
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.now(ZoneInfo(zone)).strftime("%H:%M")
    except Exception:
        return ""


_PKG = {}


def pkgindex(path=None):
    path = path or os.path.join(HERE, "pkgindex.tsv.gz")
    if path in _PKG:
        return _PKG[path]
    rows = {}
    try:
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
            for line in f:
                cols = line.rstrip("\n").split("\t")
                if len(cols) >= 4 and cols[0]:
                    rows[cols[0]] = {"summary": cols[1], "repo": cols[2], "size": int(cols[3] or 0)}
    except OSError:
        pass
    _PKG[path] = rows
    return rows
