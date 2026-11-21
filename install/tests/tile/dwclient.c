// Minimal xdg-shell client for the tiling stress test.
// Usage: dwclient APP_ID TITLE [fixed]. "fixed" sets min = max size, which Sway floats. Prints
//        "c WIDTH HEIGHT" for every configure; a line on stdin changes the title.
//        dwclient --pointer: adds a virtual pointer to the seat so "seat - cursor" can drag.
#define _GNU_SOURCE
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static struct zwlr_virtual_pointer_manager_v1 *pointer_manager;
static struct wl_surface *surface;
static int running = 1, fixed_size = 0;

static void registry_global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t ver) {
    if (!strcmp(iface, wl_compositor_interface.name))
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
    else if (!strcmp(iface, wl_shm_interface.name))
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (!strcmp(iface, xdg_wm_base_interface.name))
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
    else if (!strcmp(iface, zwlr_virtual_pointer_manager_v1_interface.name))
        pointer_manager = wl_registry_bind(reg, name, &zwlr_virtual_pointer_manager_v1_interface, 1);
}

static void registry_remove(void *data, struct wl_registry *reg, uint32_t name) {}

static const struct wl_registry_listener registry_listener = {registry_global, registry_remove};

static void wm_ping(void *data, struct xdg_wm_base *b, uint32_t serial) { xdg_wm_base_pong(b, serial); }

static const struct xdg_wm_base_listener wm_listener = {wm_ping};

static void buffer_release(void *data, struct wl_buffer *b) { wl_buffer_destroy(b); }

static const struct wl_buffer_listener buffer_listener = {buffer_release};

static struct wl_buffer *make_buffer(int w, int h) {
    int stride = w * 4, size = stride * h;
    int fd = memfd_create("dwclient", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, size) < 0)
        exit(1);
    void *p = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED)
        exit(1);
    memset(p, 0x60, size);
    munmap(p, size);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    struct wl_buffer *b = wl_shm_pool_create_buffer(pool, 0, w, h, stride, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);
    close(fd);
    wl_buffer_add_listener(b, &buffer_listener, NULL);
    return b;
}

static int conf_w, conf_h;

// The buffer fills the configured size so pointer input lands on the window.
static void surface_configure(void *data, struct xdg_surface *xs, uint32_t serial) {
    xdg_surface_ack_configure(xs, serial);
    // One line per configure lets the test count how often a window is resized.
    printf("c %d %d\n", conf_w, conf_h);
    fflush(stdout);
    int w = fixed_size ? 400 : conf_w > 0 ? conf_w : 320, h = fixed_size ? 300 : conf_h > 0 ? conf_h : 240;
    if (w > 4096)
        w = 4096;
    if (h > 4096)
        h = 4096;
    wl_surface_attach(surface, make_buffer(w, h), 0, 0);
    wl_surface_damage_buffer(surface, 0, 0, w, h);
    wl_surface_commit(surface);
}

static const struct xdg_surface_listener surface_listener = {surface_configure};

static void toplevel_configure(void *data, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *states) {
    conf_w = w;
    conf_h = h;
}

static void toplevel_close(void *data, struct xdg_toplevel *t) { running = 0; }

static const struct xdg_toplevel_listener toplevel_listener = {toplevel_configure, toplevel_close};

int main(int argc, char **argv) {
    int pointer = argc == 2 && !strcmp(argv[1], "--pointer");
    if (argc < 3 && !pointer) {
        fprintf(stderr, "usage: %s APP_ID TITLE [fixed] | --pointer\n", argv[0]);
        return 2;
    }
    fixed_size = argc > 3 && !strcmp(argv[3], "fixed");
    struct wl_display *display = wl_display_connect(NULL);
    if (!display)
        return 1;
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    wl_display_roundtrip(display);
    if (pointer) {
        // stdin lines: "a X Y W H" moves to X,Y in a W x H layout, "b BUTTON 1|0" presses or releases.
        if (!pointer_manager)
            return 1;
        struct zwlr_virtual_pointer_v1 *vp = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pointer_manager, NULL);
        wl_display_roundtrip(display);
        char line[128];
        uint32_t t = 0;
        printf("ok\n");
        fflush(stdout);
        while (fgets(line, sizeof line, stdin)) {
            unsigned x, y, w, h, button, down;
            t += 10;
            if (sscanf(line, "a %u %u %u %u", &x, &y, &w, &h) == 4)
                zwlr_virtual_pointer_v1_motion_absolute(vp, t, x, y, w, h);
            else if (sscanf(line, "b %u %u", &button, &down) == 2)
                zwlr_virtual_pointer_v1_button(vp, t, button, down ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
            zwlr_virtual_pointer_v1_frame(vp);
            if (wl_display_roundtrip(display) < 0)
                return 1;
            printf("ok\n");
            fflush(stdout);
        }
        return 0;
    }
    if (!compositor || !shm || !wm_base)
        return 1;
    xdg_wm_base_add_listener(wm_base, &wm_listener, NULL);
    surface = wl_compositor_create_surface(compositor);
    struct xdg_surface *xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &surface_listener, NULL);
    struct xdg_toplevel *top = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(top, &toplevel_listener, NULL);
    xdg_toplevel_set_app_id(top, argv[1]);
    xdg_toplevel_set_title(top, argv[2]);
    if (fixed_size) {
        xdg_toplevel_set_min_size(top, 400, 300);
        xdg_toplevel_set_max_size(top, 400, 300);
    }
    wl_surface_commit(surface);
    // Every line on stdin changes the title, as a terminal does when its directory changes.
    struct pollfd p[2] = {{wl_display_get_fd(display), POLLIN, 0}, {0, POLLIN, 0}};
    int titles = 0;
    while (running) {
        wl_display_flush(display);
        if (poll(p, 2, -1) < 0)
            break;
        if (p[1].revents) {
            char line[64], title[96];
            if (read(0, line, sizeof line) <= 0) {
                p[1].fd = -1;
            } else {
                snprintf(title, sizeof title, "%s #%d", argv[2], ++titles);
                xdg_toplevel_set_title(top, title);
                wl_surface_commit(surface);
            }
        }
        if (p[0].revents && wl_display_dispatch(display) == -1)
            break;
    }
    wl_display_disconnect(display);
    return 0;
}
