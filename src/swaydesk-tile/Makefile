CC ?= cc
PKG_CONFIG ?= pkg-config
PREFIX ?= $(HOME)/.local
CFLAGS ?= -O2 -g

# Warnings and hardening follow the OpenSSF Compiler Options Hardening Guide for C.
WARN = -std=c11 -Wall -Wextra -Wpedantic -Wformat=2 -Wconversion -Wsign-conversion -Wshadow \
	-Wnull-dereference -Wvla -Wimplicit-fallthrough -Wcast-qual -Wstrict-prototypes -Wmissing-prototypes \
	-Wtrampolines -Wbidi-chars=any -Werror=format-security -Werror=implicit \
	-Werror=incompatible-pointer-types -Werror=int-conversion -Werror
HARDEN = -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=3 -fstrict-flex-arrays=3 -fstack-protector-strong \
	-fstack-clash-protection -fcf-protection=full -fzero-call-used-regs=used-gpr -fPIE \
	-fno-delete-null-pointer-checks -fno-strict-overflow -fno-strict-aliasing \
	-ftrivial-auto-var-init=zero -fzero-init-padding-bits=all \
	-fsanitize=bounds,undefined -fsanitize-trap=all
LDHARDEN = -pie -Wl,-z,relro,-z,now -Wl,-z,noexecstack -Wl,-z,nodlopen -Wl,--as-needed \
	-Wl,--no-copy-dt-needed-entries
JSON_CFLAGS := $(shell $(PKG_CONFIG) --cflags json-c)
JSON_LIBS := $(shell $(PKG_CONFIG) --libs json-c)

swaydesk-tile: main.c
	$(CC) $(WARN) $(HARDEN) $(CFLAGS) $(JSON_CFLAGS) -o $@ main.c $(LDHARDEN) $(LDFLAGS) $(JSON_LIBS)

# Address and undefined-behaviour checks for the test runs.
swaydesk-tile-asan: main.c
	$(CC) $(WARN) -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer \
		$(JSON_CFLAGS) -o $@ main.c $(JSON_LIBS)

analyze: main.c
	$(CC) $(WARN) -O1 -fanalyzer $(JSON_CFLAGS) -c main.c -o /dev/null

install: swaydesk-tile
	install -Dm755 swaydesk-tile $(DESTDIR)$(PREFIX)/bin/swaydesk-tile

clean:
	rm -f swaydesk-tile swaydesk-tile-asan

.PHONY: analyze install clean
