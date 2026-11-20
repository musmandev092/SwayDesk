import dataclasses
import json
import typing
from dataclasses import dataclass, field

from .secret import Secret


@dataclass
class Locale:
    layout: str = "us"
    variant: str = ""
    layout2: str = ""
    variant2: str = ""
    language: str = "en_US.UTF-8"
    extra: list = field(default_factory=list)
    font: str = "large"


@dataclass
class Repos:
    fedora: str = ""
    dms: str = ""
    copr_cache: str = ""
    testing: bool = False


@dataclass
class Disk:
    mode: str = "erase"
    device: str = ""
    fs: str = "btrfs"
    scheme: str = "lvm"
    home: bool = True
    size_gib: int = 0
    encrypt: bool = True
    separate_pass: bool = False
    unlock_ms: int = 0


@dataclass
class Boot:
    timeout: int = 5
    os_prober: bool = True
    args: str = ""


@dataclass
class User:
    name: str = ""
    fullname: str = ""
    admin: bool = False


@dataclass
class Auth:
    admin: User = field(default_factory=lambda: User(admin=True))
    root_locked: bool = True
    users: typing.List[User] = field(default_factory=list)


@dataclass
class Ssh:
    enabled: bool = False
    keys: list = field(default_factory=list)


@dataclass
class Profile:
    lean: bool = True
    nvidia: str = "auto"


@dataclass
class Services:
    bluetooth: bool = True
    printing: bool = True


@dataclass
class Network:
    installed: str = "copy"
    wired: str = "dhcp"
    device: str = ""
    address: str = ""
    gateway: str = ""
    dns: str = ""


@dataclass
class Time:
    zone: str = "Asia/Karachi"
    utc: bool = True
    ntp: bool = True
    servers: list = field(default_factory=list)


@dataclass
class Config:
    preset: str = "clean"
    locale: Locale = field(default_factory=Locale)
    repos: Repos = field(default_factory=Repos)
    disk: Disk = field(default_factory=Disk)
    swap: str = "zram"
    boot: Boot = field(default_factory=Boot)
    hostname: str = "fedora"
    auth: Auth = field(default_factory=Auth)
    ssh: Ssh = field(default_factory=Ssh)
    profile: Profile = field(default_factory=Profile)
    services: Services = field(default_factory=Services)
    network: Network = field(default_factory=Network)
    packages: list = field(default_factory=list)
    time: Time = field(default_factory=Time)


class Secrets:
    def __init__(self):
        self.admin = None
        self.root = None
        self.users = {}
        self.luks = None

    def __repr__(self):
        return "Secrets(***)"


def _build(cls, data):
    hints = typing.get_type_hints(cls)
    kwargs = {}
    for f in dataclasses.fields(cls):
        if f.name not in data:
            continue
        val, hint = data[f.name], hints[f.name]
        if dataclasses.is_dataclass(hint):
            val = _build(hint, val or {})
        elif typing.get_origin(hint) in (list, typing.List) and typing.get_args(hint) \
                and dataclasses.is_dataclass(typing.get_args(hint)[0]):
            val = [_build(typing.get_args(hint)[0], v) for v in val or []]
        elif isinstance(f.default, bool):
            val = bool(val)
        elif isinstance(f.default, int) and not isinstance(f.default, bool):
            val = int(val)
        elif isinstance(f.default, str):
            val = str(val)
        elif f.default_factory is list:
            val = list(val or [])
        kwargs[f.name] = val
    return cls(**kwargs)


def merge(config, data):
    base = dataclasses.asdict(config)
    _deep_update(base, data)
    return _build(Config, base)


def _deep_update(dst, src):
    for k, v in src.items():
        if k in dst and isinstance(dst[k], dict) and isinstance(v, dict):
            _deep_update(dst[k], v)
        elif k in dst:
            dst[k] = v


def from_dict(data):
    return _build(Config, data)


def public_dict(config, secrets):
    d = dataclasses.asdict(config)
    d["auth"]["admin"]["password"] = "set" if secrets.admin else "not set"
    d["auth"]["root_password"] = "set" if secrets.root else ("locked" if config.auth.root_locked else "not set")
    for u in d["auth"]["users"]:
        u["password"] = "set" if secrets.users.get(u["name"]) else "not set"
    if config.disk.encrypt:
        d["disk"]["passphrase"] = "set" if secrets.luks else "not set"
    return d


def public_json(config, secrets):
    return json.dumps(public_dict(config, secrets), indent=2, ensure_ascii=False)


def set_admin_password(config, secrets, plain, hashed):
    secrets.admin = Secret(hashed)
    if not config.disk.separate_pass:
        secrets.luks = Secret(plain)
