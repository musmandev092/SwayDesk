import ctypes
import ctypes.util
import subprocess


class Secret:
    __slots__ = ("_value",)

    def __init__(self, value):
        self._value = value

    def reveal(self):
        return self._value

    def __repr__(self):
        return "***"

    __str__ = __repr__

    def __bool__(self):
        return bool(self._value)

    def __eq__(self, other):
        return isinstance(other, Secret) and other._value == self._value

    def __hash__(self):
        return hash(self._value)


WEAK, MODERATE, STRONG = "weak", "moderate", "strong"

_RULES = [
    (4, 13, 11),
    (3, 14, 11),
    (2, 15, 12),
    (1, 18, 14),
]


def strength(password):
    classes = sum([
        any(c.islower() for c in password),
        any(c.isupper() for c in password),
        any(c.isdigit() for c in password),
        any(not c.isalnum() for c in password),
    ])
    n = len(password)
    for need, strong, moderate in _RULES:
        if classes >= need:
            if n >= strong:
                return STRONG
            if n >= moderate:
                return MODERATE
            return WEAK
    return WEAK


def strength_hint(password):
    if not password:
        return "", None
    level = strength(password)
    n = len(password)
    if level == STRONG:
        return f"strong ({n} chars)", "ok"
    tips = []
    if not any(c.isupper() for c in password) or not any(c.islower() for c in password):
        tips.append("mix case")
    if not any(c.isdigit() for c in password):
        tips.append("add digits")
    if all(c.isalnum() for c in password):
        tips.append("add symbols")
    tip = f", {tips[0]}" if tips else ", make it longer"
    if level == MODERATE:
        return f"moderate ({n} chars{tip})", "warn"
    return f"weak ({n} chars{tip})", "err"


class _CryptData(ctypes.Structure):
    _fields_ = [("buf", ctypes.c_char * 32768)]


def _libcrypt():
    name = ctypes.util.find_library("crypt") or "libcrypt.so.2"
    try:
        return ctypes.CDLL(name)
    except OSError:
        return None


def _yescrypt(password, setting=None):
    lib = _libcrypt()
    if lib is None or not hasattr(lib, "crypt_rn") or not hasattr(lib, "crypt_gensalt_rn"):
        return None
    if setting is None:
        out = ctypes.create_string_buffer(256)
        lib.crypt_gensalt_rn.restype = ctypes.c_char_p
        lib.crypt_gensalt_rn.argtypes = [ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p,
                                         ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        if not lib.crypt_gensalt_rn(b"$y$", 0, None, 0, out, len(out)):
            return None
        setting = out.value
    data = _CryptData()
    lib.crypt_rn.restype = ctypes.c_char_p
    lib.crypt_rn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_int]
    res = lib.crypt_rn(password.encode(), setting if isinstance(setting, bytes) else setting.encode(),
                       ctypes.byref(data), ctypes.sizeof(data))
    if not res or res.startswith(b"*"):
        return None
    return res.decode()


def hash_password(password):
    h = _yescrypt(password)
    if h:
        return h
    res = subprocess.run(["openssl", "passwd", "-6", "-stdin"], input=password.encode(),
                         capture_output=True, check=False)
    h = res.stdout.decode().strip()
    if res.returncode == 0 and h.startswith("$6$"):
        return h
    raise RuntimeError("no password hashing available")


def verify_password(password, hashed):
    return _yescrypt(password, hashed) == hashed
