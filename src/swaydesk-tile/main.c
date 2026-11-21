// swaydesk-tile: master-stack tiling for Sway. New windows are placed automatically; a layout the
// user changes by hand is kept until it is re-tiled.
#define _GNU_SOURCE
#include <errno.h>
#include <json-c/json.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define IPC_MAGIC "i3-ipc"
#define IPC_HEADER 14
#define IPC_COMMAND 0u
#define IPC_SUBSCRIBE 2u
#define IPC_GET_TREE 4u
#define EV_WORKSPACE 0x80000000u
#define EV_WINDOW 0x80000003u
#define EV_BINDING 0x80000005u
#define EV_SHUTDOWN 0x80000006u
#define EV_TICK 0x80000007u

#define MAX_MESSAGE (64u << 20)
#define MAX_DEPTH 256
#define MAX_COORD (1 << 24)
#define MAX_MRU 64
#define MFACT_DEFAULT 0.5
#define TAIL "_swaydesk_tail"
#define FIT_DELAY_MS 60
#define LOOK_MS 1000
#define NONE SIZE_MAX
#define MARK "_swaydesk_tile"
#define PREFIX_BINDING "nop tile "
#define PREFIX_TICK "tile "

enum layout { L_NONE, L_SPLITH, L_SPLITV, L_TABBED, L_STACKED };
enum kind { K_WS = 1, K_CON, K_VIEW };
enum shape { S_EMPTY, S_SINGLE, S_MASTER, S_MONOCLE, S_MANUAL };
enum action { A_NONE, A_RETILE, A_MONOCLE, A_ZOOM, A_FOCUS_NEXT, A_FOCUS_PREV, A_SWAP_NEXT, A_SWAP_PREV };

struct rect {
	int x, y, w, h;
};

struct node {
	int64_t id;
	enum kind kind;
	enum layout layout;
	size_t parent, wsi, first, count;
	int fullscreen;
	struct rect rect;
};

struct floater {
	int64_t id;
	size_t wsi;
	int fullscreen;
	bool view;
	struct rect rect, window, geometry;
};

struct ids {
	int64_t *v;
	size_t len, cap;
};

struct workspace {
	size_t node;
	char name[64];
	bool safe, busy;
	struct rect output;
};

struct tree {
	struct node *n;
	size_t nn, ncap;
	size_t *kids;
	size_t nk, kcap;
	struct floater *fl;
	size_t nf, fcap;
	struct workspace *ws;
	size_t nws, wscap;
	int64_t focused, tail;
	bool focus_floating, focus_window, focus_hidden, global_fullscreen;
	size_t focus_wsi;
	struct ids hidden_fullscreen, floating, floating_ws;
};

struct list {
	size_t *v;
	size_t len, cap;
};

struct state {
	int64_t ws;
	bool live, automatic, tainted, stale;
	double mfact;
	struct ids known, floating;
};

struct buf {
	char *p;
	size_t len, cap;
};

struct msg {
	uint32_t type, len;
	char *data;
};

static int cmd_fd = -1, ev_fd = -1;
static struct state *states;
static size_t nstates, cstates;
static struct ids mru, fit_ids, immune;
static struct timespec fit_at;
static bool fit_pending, quit, debug, again;

static void fail(const char *what)
{
	fprintf(stderr, "swaydesk-tile: %s\n", what);
	exit(EXIT_FAILURE);
}

// Grows an array to hold at least need items; every size computation is overflow checked.
static void *grow(void *p, size_t *cap, size_t need, size_t size)
{
	if (need <= *cap)
		return p;
	size_t c = *cap ? *cap : 16;
	while (c < need) {
		if (c > SIZE_MAX / 2)
			fail("out of memory");
		c *= 2;
	}
	if (c > SIZE_MAX / size)
		fail("out of memory");
	void *q = realloc(p, c * size);
	if (!q)
		fail("out of memory");
	*cap = c;
	return q;
}

static size_t add_size(size_t a, size_t b)
{
	if (a > SIZE_MAX - b)
		fail("out of memory");
	return a + b;
}

static void list_push(struct list *l, size_t v)
{
	l->v = grow(l->v, &l->cap, add_size(l->len, 1), sizeof *l->v);
	l->v[l->len++] = v;
}

static void ids_push(struct ids *s, int64_t v)
{
	s->v = grow(s->v, &s->cap, add_size(s->len, 1), sizeof *s->v);
	s->v[s->len++] = v;
}

static bool ids_has(const struct ids *s, int64_t v)
{
	for (size_t i = 0; i < s->len; i++)
		if (s->v[i] == v)
			return true;
	return false;
}

static void ids_remove(struct ids *s, int64_t v)
{
	size_t k = 0;
	for (size_t i = 0; i < s->len; i++)
		if (s->v[i] != v)
			s->v[k++] = s->v[i];
	s->len = k;
}

static void buf_vadd(struct buf *b, const char *fmt, va_list ap)
{
	va_list cp;
	va_copy(cp, ap);
	int n = vsnprintf(NULL, 0, fmt, cp);
	va_end(cp);
	if (n < 0)
		fail("format error");
	size_t need = add_size(add_size(b->len, (size_t)n), 1);
	b->p = grow(b->p, &b->cap, need, 1);
	if (vsnprintf(b->p + b->len, b->cap - b->len, fmt, ap) != n)
		fail("format error");
	b->len += (size_t)n;
}

__attribute__((format(printf, 2, 3))) static void buf_add(struct buf *b, const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);
	buf_vadd(b, fmt, ap);
	va_end(ap);
}

static void sep(struct buf *b)
{
	if (b->len)
		buf_add(b, "; ");
}

static void raw(struct buf *b, const char *command)
{
	sep(b);
	buf_add(b, "%s", command);
}

// IPC

static bool read_full(int fd, void *p, size_t n)
{
	char *c = p;
	while (n) {
		ssize_t r = read(fd, c, n);
		if (r < 0 && errno == EINTR)
			continue;
		if (r <= 0)
			return false;
		c += r;
		n -= (size_t)r;
	}
	return true;
}

static bool write_full(int fd, const void *p, size_t n)
{
	const char *c = p;
	while (n) {
		ssize_t r = send(fd, c, n, MSG_NOSIGNAL);
		if (r < 0 && errno == EINTR)
			continue;
		if (r <= 0)
			return false;
		c += r;
		n -= (size_t)r;
	}
	return true;
}

static int ipc_connect(const char *path)
{
	struct sockaddr_un a = { .sun_family = AF_UNIX };
	size_t n = strlen(path);
	if (n == 0 || n >= sizeof a.sun_path)
		return -1;
	memcpy(a.sun_path, path, n + 1);
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0)
		return -1;
	if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) {
		close(fd);
		return -1;
	}
	return fd;
}

static bool ipc_send(int fd, uint32_t type, const char *payload, size_t len)
{
	if (len > MAX_MESSAGE)
		return false;
	char h[IPC_HEADER];
	uint32_t l = (uint32_t)len;
	memcpy(h, IPC_MAGIC, 6);
	memcpy(h + 6, &l, 4);
	memcpy(h + 10, &type, 4);
	return write_full(fd, h, sizeof h) && (len == 0 || write_full(fd, payload, len));
}

static bool ipc_recv(int fd, struct msg *m)
{
	char h[IPC_HEADER];
	m->data = NULL;
	if (!read_full(fd, h, sizeof h) || memcmp(h, IPC_MAGIC, 6) != 0)
		return false;
	memcpy(&m->len, h + 6, 4);
	memcpy(&m->type, h + 10, 4);
	if (m->len > MAX_MESSAGE)
		return false;
	m->data = malloc((size_t)m->len + 1);
	if (!m->data)
		fail("out of memory");
	if (!read_full(fd, m->data, m->len)) {
		free(m->data);
		m->data = NULL;
		return false;
	}
	m->data[m->len] = '\0';
	return true;
}

static bool request(uint32_t type, const char *payload, size_t len, struct msg *m)
{
	if (!ipc_send(cmd_fd, type, payload, len) || !ipc_recv(cmd_fd, m))
		return false;
	if (m->type != type) {
		free(m->data);
		m->data = NULL;
		return false;
	}
	return true;
}

// JSON

static json_object *parse_json(const char *s, size_t len)
{
	if (len > INT_MAX)
		return NULL;
	json_tokener *tok = json_tokener_new_ex(MAX_DEPTH);
	if (!tok)
		fail("out of memory");
	json_object *o = json_tokener_parse_ex(tok, s, (int)len);
	if (json_tokener_get_error(tok) != json_tokener_success && o) {
		json_object_put(o);
		o = NULL;
	}
	json_tokener_free(tok);
	return o;
}

static json_object *jget(json_object *o, const char *key)
{
	json_object *v = NULL;
	return o && json_object_object_get_ex(o, key, &v) ? v : NULL;
}

static int64_t jint(json_object *o, const char *key, int64_t def)
{
	json_object *v = jget(o, key);
	return v && json_object_is_type(v, json_type_int) ? json_object_get_int64(v) : def;
}

static const char *jstr(json_object *o, const char *key)
{
	json_object *v = jget(o, key);
	return v && json_object_is_type(v, json_type_string) ? json_object_get_string(v) : NULL;
}

static bool jbool(json_object *o, const char *key)
{
	json_object *v = jget(o, key);
	return v && json_object_is_type(v, json_type_boolean) && json_object_get_boolean(v);
}

static size_t jlen(json_object *a)
{
	return a && json_object_is_type(a, json_type_array) ? json_object_array_length(a) : 0;
}

static int coord(json_object *o, const char *key)
{
	int64_t v = jint(o, key, 0);
	return v < -MAX_COORD ? -MAX_COORD : v > MAX_COORD ? MAX_COORD : (int)v;
}

static struct rect jrect(json_object *o)
{
	struct rect r = { coord(o, "x"), coord(o, "y"), coord(o, "width"), coord(o, "height") };
	return r;
}

// Tree

static enum layout parse_layout(const char *s)
{
	if (!s)
		return L_NONE;
	if (!strcmp(s, "splith"))
		return L_SPLITH;
	if (!strcmp(s, "splitv"))
		return L_SPLITV;
	if (!strcmp(s, "tabbed"))
		return L_TABBED;
	if (!strcmp(s, "stacked"))
		return L_STACKED;
	return L_NONE;
}

// Workspace names go into criteria only when they cannot change the regex or the command.
static bool safe_name(const char *s)
{
	size_t n = strlen(s);
	if (n == 0 || n >= 64)
		return false;
	for (size_t i = 0; i < n; i++) {
		char c = s[i];
		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == ' ' || c == '_' || c == '-' || c == ':'))
			return false;
	}
	return true;
}

static size_t new_node(struct tree *t)
{
	t->n = grow(t->n, &t->ncap, add_size(t->nn, 1), sizeof *t->n);
	memset(&t->n[t->nn], 0, sizeof *t->n);
	t->n[t->nn].parent = t->n[t->nn].wsi = NONE;
	return t->nn++;
}

// The tail mark is read from the tree, so a lost or stale mark is repaired on the next pass.
static void scan_tail(struct tree *t, json_object *o)
{
	json_object *marks = jget(o, "marks");
	for (size_t i = 0; i < jlen(marks); i++) {
		json_object *m = json_object_array_get_idx(marks, i);
		if (json_object_is_type(m, json_type_string) && !strcmp(json_object_get_string(m), TAIL))
			t->tail = jint(o, "id", 0);
	}
}

// Nodes outside the tiled tree: the floating ones of a workspace, or the scratchpad (wsi NONE). A
// fullscreen window hidden there leaves its workspace in a state where a focus aborts Sway 1.12.
static void scan(struct tree *t, json_object *o, size_t wsi, int depth)
{
	if (depth > MAX_DEPTH || !json_object_is_type(o, json_type_object))
		return;
	int64_t id = jint(o, "id", 0);
	bool fullscreen = jint(o, "fullscreen_mode", 0) > 0;
	scan_tail(t, o);
	if (wsi == NONE) {
		t->focus_hidden = t->focus_hidden || jbool(o, "focused");
		if (fullscreen)
			ids_push(&t->hidden_fullscreen, id);
	} else {
		t->ws[wsi].busy = t->ws[wsi].busy || fullscreen;
		ids_push(&t->floating, id);
		ids_push(&t->floating_ws, (int64_t)wsi);
		if (jbool(o, "focused")) {
			t->focused = id;
			t->focus_floating = t->focus_window = true;
			t->focus_wsi = wsi;
		}
	}
	json_object *nodes = jget(o, "nodes");
	for (size_t i = 0; i < jlen(nodes); i++)
		scan(t, json_object_array_get_idx(nodes, i), wsi, depth + 1);
}

static void walk(struct tree *t, json_object *o, size_t parent, size_t wsi, struct rect output, int depth);

static void add_children(struct tree *t, size_t i, json_object *nodes, size_t wsi, struct rect output, int depth)
{
	size_t count = jlen(nodes);
	size_t base = t->nk;
	t->kids = grow(t->kids, &t->kcap, add_size(t->nk, count), sizeof *t->kids);
	t->nk += count;
	size_t used = 0;
	for (size_t c = 0; c < count; c++) {
		size_t before = t->nn;
		walk(t, json_object_array_get_idx(nodes, c), i, wsi, output, depth + 1);
		if (t->nn > before)
			t->kids[base + used++] = before;
	}
	t->n[i].first = base;
	t->n[i].count = used;
}

static void walk(struct tree *t, json_object *o, size_t parent, size_t wsi, struct rect output, int depth)
{
	if (depth > MAX_DEPTH || !json_object_is_type(o, json_type_object))
		return;
	const char *type = jstr(o, "type");
	json_object *nodes = jget(o, "nodes");
	if (!type)
		return;
	if (!strcmp(type, "root") || !strcmp(type, "output")) {
		if (!strcmp(type, "output")) {
			// The output "__i3" only holds the scratchpad.
			const char *name = jstr(o, "name");
			if (!name)
				return;
			if (strcmp(name, "__i3"))
				output = jrect(jget(o, "rect"));
		}
		for (size_t i = 0; i < jlen(nodes); i++)
			walk(t, json_object_array_get_idx(nodes, i), NONE, NONE, output, depth + 1);
		return;
	}
	if (!strcmp(type, "workspace")) {
		const char *name = jstr(o, "name");
		if (!name)
			return;
		if (!strcmp(name, "__i3_scratch")) {
			json_object *fl = jget(o, "floating_nodes");
			for (size_t k = 0; k < jlen(fl); k++)
				scan(t, json_object_array_get_idx(fl, k), NONE, depth + 1);
			return;
		}
		size_t i = new_node(t);
		size_t w = t->nws;
		t->ws = grow(t->ws, &t->wscap, add_size(t->nws, 1), sizeof *t->ws);
		t->nws++;
		memset(&t->ws[w], 0, sizeof t->ws[w]);
		t->ws[w].node = i;
		t->ws[w].output = output;
		t->ws[w].safe = safe_name(name);
		if (t->ws[w].safe)
			memcpy(t->ws[w].name, name, strlen(name) + 1);
		t->n[i].id = jint(o, "id", 0);
		t->n[i].kind = K_WS;
		t->n[i].layout = parse_layout(jstr(o, "layout"));
		t->n[i].wsi = w;
		t->n[i].rect = jrect(jget(o, "rect"));
		if (jbool(o, "focused")) {
			t->focused = t->n[i].id;
			t->focus_floating = false;
			t->focus_window = false;
			t->focus_wsi = w;
		}
		add_children(t, i, nodes, w, output, depth);
		json_object *fl = jget(o, "floating_nodes");
		for (size_t k = 0; k < jlen(fl); k++) {
			json_object *f = json_object_array_get_idx(fl, k);
			if (!json_object_is_type(f, json_type_object))
				continue;
			t->fl = grow(t->fl, &t->fcap, add_size(t->nf, 1), sizeof *t->fl);
			struct floater *x = &t->fl[t->nf++];
			memset(x, 0, sizeof *x);
			x->id = jint(f, "id", 0);
			x->wsi = w;
			x->fullscreen = (int)jint(f, "fullscreen_mode", 0);
			x->view = jget(f, "pid") != NULL;
			x->rect = jrect(jget(f, "rect"));
			x->window = jrect(jget(f, "window_rect"));
			x->geometry = jrect(jget(f, "geometry"));
			scan(t, f, w, depth + 1);
		}
		return;
	}
	if (!strcmp(type, "con") && parent != NONE && wsi != NONE) {
		size_t i = new_node(t);
		t->n[i].id = jint(o, "id", 0);
		t->n[i].kind = jget(o, "pid") && jlen(nodes) == 0 ? K_VIEW : K_CON;
		t->n[i].layout = parse_layout(jstr(o, "layout"));
		t->n[i].parent = parent;
		t->n[i].wsi = wsi;
		t->n[i].fullscreen = (int)jint(o, "fullscreen_mode", 0);
		t->n[i].rect = jrect(jget(o, "rect"));
		scan_tail(t, o);
		if (t->n[i].fullscreen > 0)
			t->ws[wsi].busy = true;
		if (t->n[i].fullscreen > 1)
			t->global_fullscreen = true;
		if (jbool(o, "focused")) {
			t->focused = t->n[i].id;
			t->focus_floating = false;
			t->focus_window = t->n[i].kind == K_VIEW;
			t->focus_wsi = wsi;
		}
		add_children(t, i, nodes, wsi, output, depth);
	}
}

static void tree_free(struct tree *t)
{
	free(t->n);
	free(t->kids);
	free(t->fl);
	free(t->ws);
	free(t->hidden_fullscreen.v);
	free(t->floating.v);
	free(t->floating_ws.v);
	memset(t, 0, sizeof *t);
}

static bool load_tree(struct tree *t)
{
	memset(t, 0, sizeof *t);
	t->focus_wsi = NONE;
	struct msg m;
	if (!request(IPC_GET_TREE, "", 0, &m))
		return false;
	json_object *root = parse_json(m.data, m.len);
	free(m.data);
	if (!root)
		return false;
	walk(t, root, NONE, NONE, (struct rect){ 0, 0, 0, 0 }, 0);
	json_object_put(root);
	return true;
}

static size_t child(const struct tree *t, size_t i, size_t k)
{
	return t->kids[t->n[i].first + k];
}

// The bottom of a chain of one-child containers.
static size_t collapse(const struct tree *t, size_t i)
{
	while (t->n[i].kind == K_CON && t->n[i].count == 1)
		i = child(t, i, 0);
	return i;
}

// Tiled windows in reading order.
static void collect(const struct tree *t, size_t i, struct list *out)
{
	if (t->n[i].kind == K_VIEW) {
		list_push(out, i);
		return;
	}
	for (size_t k = 0; k < t->n[i].count; k++)
		collect(t, child(t, i, k), out);
}

static bool all_views(const struct tree *t, size_t i)
{
	for (size_t k = 0; k < t->n[i].count; k++)
		if (t->n[collapse(t, child(t, i, k))].kind != K_VIEW)
			return false;
	return true;
}

// Automatic shapes: [master | stack] (sizes do not matter), one tab group, or one window.
static enum shape classify(const struct tree *t, size_t ws, const struct list *v, size_t *root)
{
	*root = ws;
	if (v->len == 0)
		return S_EMPTY;
	if (v->len == 1)
		return S_SINGLE;
	size_t r = ws;
	while (t->n[r].count == 1 && t->n[child(t, r, 0)].kind == K_CON)
		r = child(t, r, 0);
	*root = r;
	enum layout l = t->n[r].layout;
	if (l == L_TABBED || l == L_STACKED)
		return all_views(t, r) ? S_MONOCLE : S_MANUAL;
	if (l != L_SPLITH || t->n[r].count != 2)
		return S_MANUAL;
	size_t m = collapse(t, child(t, r, 0)), s = collapse(t, child(t, r, 1));
	if (t->n[m].kind != K_VIEW)
		return S_MANUAL;
	if (t->n[s].kind == K_VIEW)
		return S_MASTER;
	return t->n[s].layout == L_SPLITV && all_views(t, s) ? S_MASTER : S_MANUAL;
}

// Commands. Only container ids, numbers and fixed words are written into them; window titles and
// app ids never are.

__attribute__((format(printf, 5, 6))) static void op(struct buf *b, const struct tree *t, size_t i, const char *extra, const char *fmt, ...)
{
	const struct workspace *w = t->n[i].wsi < t->nws ? &t->ws[t->n[i].wsi] : NULL;
	sep(b);
	if (w && w->safe)
		buf_add(b, "[con_id=%lld%s workspace=\"^%s$\"] ", (long long)t->n[i].id, extra, w->name);
	else
		buf_add(b, "[con_id=%lld%s] ", (long long)t->n[i].id, extra);
	va_list ap;
	va_start(ap, fmt);
	buf_vadd(b, fmt, ap);
	va_end(ap);
}

static int percent(double f)
{
	int p = (int)(f * 100.0 + 0.5);
	return p < 10 ? 10 : p > 90 ? 90 : p;
}

static void sizes(struct buf *b, const struct tree *t, const struct list *o, double mfact)
{
	if (o->len < 2)
		return;
	op(b, t, o->v[0], " tiling", "resize set width %d ppt", percent(mfact));
	size_t k = o->len - 1;
	if (k < 2 || k > 50)
		return;
	for (size_t i = 1; i + 1 < o->len; i++)
		op(b, t, o->v[i], " tiling", "resize set height %d ppt", (int)(100 / k));
}

// The master's share of the width in a master-stack, or 0.
static double share(const struct tree *t, size_t root)
{
	if (t->n[root].count != 2 || t->n[root].rect.w <= 0)
		return 0;
	return (double)t->n[collapse(t, child(t, root, 0))].rect.w / (double)t->n[root].rect.w;
}

// Whether the master width or the stack heights are off; resizing to what is already there would
// only make every window redraw.
static bool sizes_off(const struct tree *t, size_t root, const struct list *v, double mfact)
{
	double f = share(t, root);
	if (v->len < 2 || f <= 0)
		return false;
	if (f - mfact > 0.02 || f - mfact < -0.02)
		return true;
	size_t s = child(t, root, 1);
	// Title bars and gaps differ per output, so the stack windows are compared with each other.
	int low = INT_MAX, high = 0;
	for (size_t i = 1; i < v->len; i++) {
		int h = t->n[v->v[i]].rect.h;
		low = h < low ? h : low;
		high = h > high ? h : high;
	}
	return (double)(high - low) > (double)t->n[s].rect.h * 0.04;
}

// One-child containers around windows go ("split none" flattens a window's one-child parents).
static void unwrap(struct buf *b, const struct tree *t, const struct list *v, size_t skip)
{
	for (size_t i = 0; i < v->len; i++) {
		size_t p = t->n[v->v[i]].parent;
		if (v->v[i] != skip && p != NONE && t->n[p].kind == K_CON && t->n[p].count == 1)
			op(b, t, v->v[i], " tiling", "split none");
	}
}

// A lone window loses old wrappers once the window set changed, and a vertical parent turns
// horizontal ("split h" on an only child sets the parent's layout) so the next window opens beside it.
static void single(struct buf *b, const struct tree *t, size_t ws, const struct list *v, bool changed)
{
	size_t w = v->v[0], p = t->n[w].parent;
	if (v->len != 1 || p == NONE)
		return;
	bool flat = changed && p != ws && t->n[p].count == 1;
	enum layout l = flat ? t->n[ws].layout : t->n[p].layout;
	if (flat || l == L_SPLITV)
		op(b, t, w, " tiling", "%s%s%s", flat ? "split none" : "", flat && l == L_SPLITV ? ", " : "", l == L_SPLITV ? "split h" : "");
}

// A single stack window keeps a vertical container, where the next window goes before it is first
// drawn. Sway gives a new one half the width; returns whether another master width has to be set.
static bool stack_wrap(struct buf *b, const struct tree *t, size_t root, const struct list *v, double mfact)
{
	size_t w = v->len == 2 ? v->v[1] : NONE, p = w == NONE ? NONE : t->n[w].parent;
	if (p == NONE || (t->n[p].parent == root && t->n[p].layout == L_SPLITV && t->n[p].count == 1))
		return false;
	op(b, t, w, " tiling", p == root || t->n[p].count > 1 ? "split v" : "split none, split v");
	return percent(mfact) != 50;
}

// The lone stack window keeps its container; other one-child wrappers go.
static bool tidy_master(struct buf *b, const struct tree *t, size_t root, const struct list *v, double mfact)
{
	bool wrapped = stack_wrap(b, t, root, v, mfact);
	unwrap(b, t, v, v->len == 2 ? v->v[1] : NONE);
	return wrapped;
}

static bool in_order(const struct tree *t, size_t p, const struct list *o)
{
	if (t->n[p].count != o->len)
		return false;
	for (size_t i = 0; i < o->len; i++)
		if (child(t, p, i) != o->v[i])
			return false;
	return true;
}

// Moves the windows o[from..], in order, into the container dest or behind the window dest.
static void move_to(struct buf *b, const struct tree *t, size_t dest, const struct list *o, size_t from)
{
	bool into = t->n[dest].kind != K_VIEW;
	if (from >= o->len)
		return;
	op(b, t, dest, into ? "" : " tiling", "mark --add " MARK);
	for (size_t i = from; i < o->len; i++) {
		op(b, t, o->v[i], " tiling", "move container to mark " MARK);
		if (!into)
			op(b, t, o->v[i], " tiling", "mark --add " MARK);
	}
	raw(b, "unmark " MARK);
}

// Moves every window, in order, into one parent unless they are there already: the workspace when
// the first window is a direct child of it, else the workspace's direct child holding that window.
static size_t gather(struct buf *b, const struct tree *t, size_t ws, const struct list *o)
{
	size_t top = o->v[0];
	while (t->n[top].parent != ws && t->n[top].parent != NONE)
		top = t->n[top].parent;
	bool direct = top == o->v[0];
	if (!in_order(t, direct ? ws : top, o))
		move_to(b, t, top, o, direct);
	return direct ? ws : top;
}

// "layout" on a direct child of the workspace wraps its windows in a container with that layout. A
// tabbed workspace (a second tab bar) is changed itself, through focus; returns whether focus moved.
static bool set_layout(struct buf *b, const struct tree *t, size_t wsi, size_t top, size_t w0, enum layout target)
{
	size_t ws = t->ws[wsi].node;
	enum layout wl = t->n[ws].layout;
	const char *name = target == L_TABBED ? "tabbed" : "splith";
	bool back = !t->focused || t->focus_window || t->focus_wsi == wsi || (t->focus_wsi < t->nws && t->ws[t->focus_wsi].safe);
	bool detour = (wl == L_TABBED || wl == L_STACKED) && back;
	if (top == ws && wl == target)
		return false;
	if (top != ws || !detour)
		op(b, t, w0, " tiling", "layout %s", name);
	if (!detour)
		return false;
	op(b, t, top == ws ? w0 : top, top == ws ? " tiling" : "", "focus");
	raw(b, "focus parent");
	sep(b);
	buf_add(b, "layout %s", top == ws ? name : "splith");
	return true;
}

static size_t current(const struct tree *t, const struct list *v);

// Focus ends on a window: the one that had it, or the workspace's last focused window when a
// container of this workspace had it. A detour from another workspace goes back there.
static void refocus(struct buf *b, const struct tree *t, size_t wsi, const struct list *v, bool moved)
{
	if (!t->focused || (t->focus_wsi != wsi && !moved))
		return;
	if (t->focus_window) {
		sep(b);
		buf_add(b, "[con_id=%lld] focus", (long long)t->focused);
	} else if (t->focus_wsi == wsi && v->len) {
		op(b, t, v->v[current(t, v)], " tiling", "focus");
	} else if (t->focus_wsi < t->nws && t->ws[t->focus_wsi].safe) {
		sep(b);
		buf_add(b, "workspace --no-auto-back-and-forth \"%s\"", t->ws[t->focus_wsi].name);
	}
}

static void build_master(struct buf *b, struct buf *z, const struct tree *t, size_t wsi, const struct list *o, double mfact)
{
	size_t ws = t->ws[wsi].node;
	if (o->len < 2) {
		if (o->len)
			single(b, t, ws, o, true);
		return;
	}
	size_t top = gather(b, t, ws, o);
	bool moved = set_layout(b, t, wsi, top, o->v[0], L_SPLITH);
	op(b, t, o->v[1], " tiling", "fullscreen disable, split v");
	move_to(b, t, o->v[1], o, 2);
	refocus(b, t, wsi, o, moved);
	sizes(z, t, o, mfact);
}

static void build_monocle(struct buf *b, const struct tree *t, size_t wsi, const struct list *o)
{
	size_t ws = t->ws[wsi].node;
	size_t top = gather(b, t, ws, o);
	bool moved = set_layout(b, t, wsi, top, o->v[0], L_TABBED);
	refocus(b, t, wsi, o, moved);
}

// A floating window back from the scratchpad, floated or out of fullscreen that is larger than 90%
// of its output, or larger than its client draws, shrinks to fit; one reaching off the output is
// centred. Nothing grows.
static void fit(struct buf *b, const struct tree *t)
{
	for (size_t k = 0; k < t->nf; k++) {
		const struct floater *f = &t->fl[k];
		if (!ids_has(&fit_ids, f->id) || f->fullscreen > 0 || f->wsi >= t->nws)
			continue;
		struct rect o = t->ws[f->wsi].output, r = f->rect;
		if (o.w <= 0 || o.h <= 0)
			continue;
		struct rect c = f->view && f->window.w > 0 && f->window.h > 0 ? f->window : r;
		int dx = r.w - c.w, dy = r.h - c.h, w = c.w, h = c.h;
		if (f->view && f->geometry.w > 0 && f->geometry.w < w - 32)
			w = f->geometry.w;
		if (f->view && f->geometry.h > 0 && f->geometry.h < h - 32)
			h = f->geometry.h;
		w += dx;
		h += dy;
		if (w > o.w * 9 / 10)
			w = o.w * 9 / 10;
		if (h > o.h * 9 / 10)
			h = o.h * 9 / 10;
		bool off = r.x < o.x || r.y < o.y || r.x + r.w > o.x + o.w || r.y + r.h > o.y + o.h;
		if (w < 1 || h < 1)
			continue;
		if (w < r.w - 2 || h < r.h - 2) {
			sep(b);
			buf_add(b, "[con_id=%lld floating] resize set width %d px height %d px, move position center", (long long)f->id, w, h);
		} else if (off) {
			sep(b);
			buf_add(b, "[con_id=%lld floating] move position center", (long long)f->id);
		}
	}
}

// State

static struct state *state_for(int64_t ws, bool *fresh)
{
	for (size_t i = 0; i < nstates; i++)
		if (states[i].ws == ws) {
			states[i].live = true;
			*fresh = false;
			return &states[i];
		}
	states = grow(states, &cstates, add_size(nstates, 1), sizeof *states);
	struct state *s = &states[nstates++];
	memset(s, 0, sizeof *s);
	s->ws = ws;
	s->live = true;
	s->automatic = true;
	s->mfact = MFACT_DEFAULT;
	*fresh = true;
	return s;
}

static void states_prune(void)
{
	size_t k = 0;
	for (size_t i = 0; i < nstates; i++) {
		if (states[i].live) {
			states[i].live = false;
			states[k++] = states[i];
		} else {
			free(states[i].known.v);
			free(states[i].floating.v);
		}
	}
	nstates = k;
}

static bool same_set(const struct ids *a, const struct tree *t, const struct list *v)
{
	if (a->len != v->len)
		return false;
	for (size_t i = 0; i < v->len; i++)
		if (!ids_has(a, t->n[v->v[i]].id))
			return false;
	return true;
}

// Windows already known keep their reading order; new ones go to the end of the stack.
static void desired(const struct tree *t, const struct list *v, const struct ids *known, struct list *out)
{
	for (size_t i = 0; i < v->len; i++)
		if (ids_has(known, t->n[v->v[i]].id))
			list_push(out, v->v[i]);
	for (size_t i = 0; i < v->len; i++)
		if (!ids_has(known, t->n[v->v[i]].id))
			list_push(out, v->v[i]);
}

static bool same_order(const struct list *a, const struct list *b)
{
	return a->len == b->len && (a->len == 0 || !memcmp(a->v, b->v, a->len * sizeof *a->v));
}

static void capture_mfact(struct state *s, const struct tree *t, size_t root)
{
	double f = share(t, root);
	if (f >= 0.1 && f <= 0.9)
		s->mfact = f;
}

// The focused tiled window of the list, else the most recently focused one, else the first.
static size_t current(const struct tree *t, const struct list *v)
{
	for (size_t i = 0; i < v->len; i++)
		if (!t->focus_floating && t->n[v->v[i]].id == t->focused)
			return i;
	for (size_t m = mru.len; m-- > 0;)
		for (size_t i = 0; i < v->len; i++)
			if (t->n[v->v[i]].id == mru.v[m])
				return i;
	return 0;
}

// Takes the windows not yet known, and containers left empty by that, out of their parents (cut
// gets node and position pairs).
static void prune(struct tree *t, const struct list *v, const struct ids *known, struct list *cut)
{
	for (size_t i = 0; i < v->len; i++) {
		size_t x = v->v[i];
		if (ids_has(known, t->n[x].id))
			continue;
		for (size_t p = t->n[x].parent; p != NONE; x = p, p = t->n[x].parent) {
			size_t *k = t->kids + t->n[p].first, n = t->n[p].count, at = 0;
			while (at < n && k[at] != x)
				at++;
			if (at == n)
				break;
			memmove(k + at, k + at + 1, (n - at - 1) * sizeof *k);
			t->n[p].count--;
			list_push(cut, x);
			list_push(cut, at);
			if (t->n[p].count || t->n[p].kind != K_CON)
				break;
		}
	}
}

static void restore(struct tree *t, const struct list *cut)
{
	for (size_t i = cut->len; i >= 2; i -= 2) {
		size_t x = cut->v[i - 2], at = cut->v[i - 1], p = t->n[x].parent;
		size_t *k = t->kids + t->n[p].first;
		memmove(k + at + 1, k + at, (t->n[p].count - at) * sizeof *k);
		k[at] = x;
		t->n[p].count++;
	}
}

// The windows changed and the workspace is untidy. Those that were there before tell why: tidy, so
// new ones go to the end; a closed master's stack, so its first window moves out; else by hand (false).
static bool place(struct buf *b, struct buf *z, struct tree *t, size_t wsi, const struct list *v, const struct list *want, const struct state *s, size_t *last)
{
	size_t ws = t->ws[wsi].node, r;
	struct list cut = { 0 }, was = { 0 };
	prune(t, v, &s->known, &cut);
	collect(t, ws, &was);
	enum shape sh = classify(t, ws, &was, &r);
	size_t p = t->n[r].parent, n = was.len;
	bool orphan = sh == S_MANUAL && r != ws && t->n[r].layout == L_SPLITV && all_views(t, r);
	bool promote = orphan && !cut.len && p == ws && t->n[p].layout == L_SPLITH && in_order(t, r, v);
	// New windows go into the stack container or the tab group, else behind the lone stack window
	// or, in a tabbed workspace, a tab that is its direct child.
	size_t into = sh == S_MASTER ? (n > 2 ? collapse(t, child(t, r, 1)) : NONE) : r != ws ? r : NONE;
	size_t after = n ? was.v[n - 1] : NONE;
	for (size_t i = n; sh == S_MONOCLE && i-- > 0 && t->n[after].parent != r;)
		after = was.v[i];
	restore(t, &cut);
	bool ok = true;
	if (s->stale || n < 2 || (orphan && !promote)) {
		build_master(b, z, t, wsi, want, s->mfact);
	} else if (sh == S_MASTER || sh == S_MONOCLE) {
		if (sh == S_MASTER && stack_wrap(b, t, r, &was, s->mfact))
			sizes(z, t, &was, s->mfact);
		move_to(b, t, into != NONE ? into : after, want, n);
		if (sh == S_MONOCLE)
			*last = NONE;
		refocus(b, t, wsi, v, false);
	} else if (promote) {
		op(b, t, v->v[0], " tiling", "move left");
		refocus(b, t, wsi, v, false);
		sizes(z, t, v, s->mfact);
	} else {
		ok = false;
	}
	free(cut.v);
	free(was.v);
	return ok;
}

// Keeps a tidy workspace ready for the next window.
static void tidy(struct buf *b, struct buf *z, const struct tree *t, size_t ws, size_t root, const struct list *v, enum shape sh, struct state *s, bool changed)
{
	if (sh == S_SINGLE) {
		single(b, t, ws, v, changed);
	} else if (sh == S_MONOCLE) {
		unwrap(b, t, v, NONE);
	} else if (sh == S_MASTER) {
		capture_mfact(s, t, root);
		if (tidy_master(b, t, root, v, s->mfact))
			sizes(z, t, v, s->mfact);
	}
}

static void run_action(struct buf *b, struct buf *z, const struct tree *t, size_t wsi, enum action act, const struct list *v, enum shape sh, size_t root, struct state *s)
{
	size_t n = v->len;
	size_t f = current(t, v);
	switch (act) {
	case A_RETILE:
		if (sh == S_MASTER) {
			capture_mfact(s, t, root);
			if (tidy_master(b, t, root, v, s->mfact) || sizes_off(t, root, v, s->mfact))
				sizes(z, t, v, s->mfact);
		} else {
			build_master(b, z, t, wsi, v, s->mfact);
		}
		s->automatic = true;
		break;
	case A_MONOCLE:
		if (sh == S_MONOCLE)
			build_master(b, z, t, wsi, v, s->mfact);
		else if (n >= 2)
			build_monocle(b, t, wsi, v);
		s->automatic = true;
		break;
	case A_ZOOM:
		if (n < 2)
			break;
		op(b, t, v->v[f ? f : 1], " tiling", "swap container with con_id %lld, focus", (long long)t->n[v->v[0]].id);
		break;
	case A_FOCUS_NEXT:
	case A_FOCUS_PREV:
	case A_SWAP_NEXT:
	case A_SWAP_PREV: {
		if (n < 2)
			break;
		bool next = act == A_FOCUS_NEXT || act == A_SWAP_NEXT;
		size_t target = next ? (f + 1) % n : (f + n - 1) % n;
		if (act == A_FOCUS_NEXT || act == A_FOCUS_PREV)
			op(b, t, v->v[target], " tiling", "focus");
		else
			op(b, t, v->v[f], " tiling", "swap container with con_id %lld, focus", (long long)t->n[v->v[target]].id);
		break;
	}
	case A_NONE:
		break;
	}
}

static bool run_commands(struct buf *b)
{
	if (!b->len)
		return true;
	if (debug)
		fprintf(stderr, "swaydesk-tile: run: %s\n", b->p);
	struct msg m;
	if (!request(IPC_COMMAND, b->p, b->len, &m))
		return false;
	json_object *r = parse_json(m.data, m.len);
	const char *c = b->p;
	// Sway answers once per command; commands are separated by ";" or ",".
	for (size_t i = 0; i < jlen(r); i++) {
		json_object *e = json_object_array_get_idx(r, i);
		size_t len = strcspn(c, ";,");
		if (!jbool(e, "success")) {
			const char *err = jstr(e, "error");
			fprintf(stderr, "swaydesk-tile: command failed: %s (%.*s)\n", err ? err : "unknown error", (int)len, c);
			again = true;
		}
		c += len;
		c += strspn(c, ";, ");
	}
	if (r)
		json_object_put(r);
	free(m.data);
	return true;
}

static bool refresh(enum action act)
{
	struct tree t;
	if (!load_tree(&t)) {
		tree_free(&t);
		return false;
	}
	// Resizes go last: one that Sway rejects ends the batch.
	struct buf b = { 0 }, z = { 0 };
	struct list v = { 0 }, want = { 0 };
	size_t tail = NONE;
	for (size_t wsi = 0; wsi < t.nws; wsi++) {
		size_t ws = t.ws[wsi].node;
		v.len = 0;
		collect(&t, ws, &v);
		size_t root;
		enum shape sh = classify(&t, ws, &v, &root);
		bool clean = sh != S_MANUAL, fresh;
		bool busy = t.global_fullscreen || t.ws[wsi].busy;
		struct state *s = state_for(t.n[ws].id, &fresh);
		for (size_t k = 0; k < t.hidden_fullscreen.len && !s->tainted; k++)
			if (ids_has(&s->known, t.hidden_fullscreen.v[k]) || ids_has(&s->floating, t.hidden_fullscreen.v[k])) {
				s->tainted = true;
				fprintf(stderr, "swaydesk-tile: workspace %lld left alone until emptied (fullscreen window hidden in the scratchpad)\n", (long long)t.n[ws].id);
			}
		s->floating.len = 0;
		for (size_t k = 0; k < t.floating.len; k++)
			if (t.floating_ws.v[k] == (int64_t)wsi)
				ids_push(&s->floating, t.floating.v[k]);
		if (s->tainted || (busy && !fresh))
			continue;
		// The window that ends up last in the stack, when this is the focused automatic workspace.
		size_t last = sh == S_MASTER ? v.v[v.len - 1] : NONE;
		bool focused = wsi == t.focus_wsi;
		bool changed = s->stale || !same_set(&s->known, &t, &v);
		if (act != A_NONE && focused && !busy && !fresh) {
			// A re-tile settles every window; after other keys the plain pass still sees a change.
			run_action(&b, &z, &t, wsi, act, &v, sh, root, s);
			if (act != A_RETILE && act != A_MONOCLE)
				continue;
		} else if (fresh || !s->automatic) {
			if (fresh || clean)
				s->automatic = clean;
			if (s->automatic && !busy)
				tidy(&b, &z, &t, ws, root, &v, sh, s, !fresh);
		} else if (!changed || sh == S_SINGLE || sh == S_MONOCLE || sh == S_EMPTY) {
			// An untidy workspace whose windows are the same was arranged by hand.
			s->automatic = clean;
			tidy(&b, &z, &t, ws, root, &v, sh, s, changed);
		} else {
			want.len = 0;
			desired(&t, &v, &s->known, &want);
			last = want.v[want.len - 1];
			if (sh == S_MASTER && same_order(&v, &want)) {
				// Sway shares the stack out by itself; only a new stack container needs a width.
				if (tidy_master(&b, &t, root, &v, s->mfact))
					sizes(&z, &t, &v, s->mfact);
			} else if (!place(&b, &z, &t, wsi, &v, &want, s, &last)) {
				s->automatic = false;
			}
		}
		s->stale = false;
		if (!s->automatic)
			last = NONE;
		if (focused)
			tail = last;
		s->known.len = 0;
		for (size_t i = 0; i < v.len; i++)
			ids_push(&s->known, t.n[v.v[i]].id);
	}
	states_prune();
	// Sway's for_window rule moves a new window to the mark. It also runs when a window it has not run
	// on yet is marked or renamed: the mark is away during moves, and every window holds it once.
	struct buf out = { 0 };
	// Sway 1.12 can leave focus on a window hidden in the scratchpad and then aborts when a window
	// opens (the rule's "workspace=__focused__"); focus goes to the window that had it last.
	if (t.focus_hidden && !t.hidden_fullscreen.len) {
		struct ids shown = { 0 };
		for (size_t i = 0; i < t.nn; i++)
			if (t.n[i].kind == K_VIEW)
				ids_push(&shown, t.n[i].id);
		for (size_t i = 0; i < t.floating.len; i++)
			ids_push(&shown, t.floating.v[i]);
		int64_t to = shown.len ? shown.v[0] : 0;
		for (size_t m = 0; m < mru.len; m++)
			if (ids_has(&shown, mru.v[m]))
				to = mru.v[m];
		if (to)
			buf_add(&out, "[con_id=%lld] focus", (long long)to);
		free(shown.v);
	}
	if (b.len && t.tail && strstr(b.p, "mark ")) {
		raw(&out, "unmark " TAIL);
		t.tail = 0;
	}
	if (b.len)
		raw(&out, b.p);
	if (act == A_NONE && tail != NONE) {
		bool marked = t.tail == t.n[tail].id;
		v.len = 0;
		collect(&t, t.ws[t.focus_wsi].node, &v);
		for (size_t i = 0; i < v.len && t.focus_window; i++) {
			if (ids_has(&immune, t.n[v.v[i]].id))
				continue;
			ids_push(&immune, t.n[v.v[i]].id);
			if (v.v[i] != tail) {
				op(&out, &t, v.v[i], " tiling", "mark --add " TAIL);
				marked = false;
			}
		}
		if (!marked)
			op(&out, &t, tail, " tiling", "mark --add " TAIL);
	} else if (act == A_NONE && t.tail) {
		raw(&out, "unmark " TAIL);
	}
	if (z.len)
		raw(&out, z.p);
	again = false;
	bool ok = run_commands(&out);
	free(out.p);
	for (size_t i = 0; again && i < nstates; i++)
		states[i].stale = true;
	free(v.v);
	free(want.v);
	free(b.p);
	free(z.p);
	tree_free(&t);
	return ok;
}

static bool run_fit(void)
{
	struct tree t;
	if (!load_tree(&t)) {
		tree_free(&t);
		return false;
	}
	struct buf b = { 0 };
	fit(&b, &t);
	bool ok = run_commands(&b);
	again = false;
	free(b.p);
	tree_free(&t);
	fit_ids.len = 0;
	fit_pending = false;
	return ok;
}

// Events

static void schedule_fit(int64_t id)
{
	if (!ids_has(&fit_ids, id))
		ids_push(&fit_ids, id);
	clock_gettime(CLOCK_MONOTONIC, &fit_at);
	fit_at.tv_nsec += FIT_DELAY_MS * 1000000L;
	if (fit_at.tv_nsec >= 1000000000L) {
		fit_at.tv_sec++;
		fit_at.tv_nsec -= 1000000000L;
	}
	fit_pending = true;
}

static int ms_until(const struct timespec *at)
{
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	long long ms = (long long)(at->tv_sec - now.tv_sec) * 1000 + (at->tv_nsec - now.tv_nsec + 999999) / 1000000;
	return ms < 0 ? 0 : ms > INT_MAX ? INT_MAX : (int)ms;
}

static enum action parse_action(const char *s)
{
	static const struct {
		const char *name;
		enum action act;
	} map[] = {
		{ "retile", A_RETILE },
		{ "monocle", A_MONOCLE },
		{ "zoom", A_ZOOM },
		{ "focus next", A_FOCUS_NEXT },
		{ "focus prev", A_FOCUS_PREV },
		{ "swap next", A_SWAP_NEXT },
		{ "swap prev", A_SWAP_PREV },
	};
	for (size_t i = 0; i < sizeof map / sizeof map[0]; i++)
		if (!strcmp(s, map[i].name))
			return map[i].act;
	return A_NONE;
}

static void mru_touch(int64_t id)
{
	ids_remove(&mru, id);
	if (mru.len >= MAX_MRU) {
		memmove(mru.v, mru.v + 1, (mru.len - 1) * sizeof *mru.v);
		mru.len--;
	}
	ids_push(&mru, id);
}

static void on_event(const struct msg *m, bool *dirty, enum action *act)
{
	if (m->type == EV_SHUTDOWN) {
		quit = true;
		return;
	}
	json_object *o = parse_json(m->data, m->len);
	if (!o)
		return;
	if (m->type == EV_WORKSPACE) {
		const char *change = jstr(o, "change");
		*dirty = true;
		// A reload makes Sway run the placement rule on every window again.
		if (change && !strcmp(change, "reload"))
			immune.len = 0;
	} else if (m->type == EV_WINDOW) {
		const char *change = jstr(o, "change");
		json_object *c = jget(o, "container");
		int64_t id = jint(c, "id", 0);
		const char *type = jstr(c, "type");
		bool floating = type && !strcmp(type, "floating_con");
		if (!change) {
		} else if (!strcmp(change, "focus")) {
			mru_touch(id);
		} else if (!strcmp(change, "close")) {
			ids_remove(&mru, id);
			ids_remove(&immune, id);
			*dirty = true;
		} else if (!strcmp(change, "new") || !strcmp(change, "move") || !strcmp(change, "floating") || !strcmp(change, "fullscreen_mode")) {
			*dirty = true;
			if (floating && (strcmp(change, "fullscreen_mode") || jint(c, "fullscreen_mode", 1) == 0) && strcmp(change, "new"))
				schedule_fit(id);
		}
	} else if (m->type == EV_BINDING) {
		const char *command = jstr(jget(o, "binding"), "command");
		if (command && !strncmp(command, PREFIX_BINDING, strlen(PREFIX_BINDING)))
			*act = parse_action(command + strlen(PREFIX_BINDING));
		else
			*dirty = true;
	} else if (m->type == EV_TICK) {
		const char *payload = jstr(o, "payload");
		// Any other "tile ..." tick asks for a look at the tree.
		if (!jbool(o, "first") && payload && !strncmp(payload, PREFIX_TICK, strlen(PREFIX_TICK))) {
			*act = parse_action(payload + strlen(PREFIX_TICK));
			if (*act == A_NONE)
				*dirty = true;
		}
	}
	json_object_put(o);
}

static bool subscribe(void)
{
	static const char events[] = "[\"window\",\"binding\",\"tick\",\"shutdown\",\"workspace\"]";
	if (!ipc_send(ev_fd, IPC_SUBSCRIBE, events, sizeof events - 1))
		return false;
	struct msg m;
	if (!ipc_recv(ev_fd, &m))
		return false;
	bool ok = false;
	if (m.type == IPC_SUBSCRIBE) {
		json_object *r = parse_json(m.data, m.len);
		ok = jbool(r, "success");
		if (r)
			json_object_put(r);
	}
	free(m.data);
	return ok;
}

// A plain pass follows a key (it sets the mark) and a pass whose commands failed (a stale tree).
static bool pass(enum action act)
{
	if (!refresh(act))
		return false;
	if (act == A_NONE && !again)
		return true;
	bool ok = refresh(A_NONE);
	again = false;
	return ok;
}

int main(int argc, char **argv)
{
	if (argc > 1) {
		bool help = argc == 2 && (!strcmp(argv[1], "-h") || !strcmp(argv[1], "--help"));
		fprintf(help ? stdout : stderr, "usage: swaydesk-tile\nMaster-stack tiling for Sway; started from the Sway config.\n"
						"Keys: bindsym ... nop tile retile|monocle|zoom|focus next|focus prev|swap next|swap prev\n");
		return help ? EXIT_SUCCESS : 2;
	}
	signal(SIGPIPE, SIG_IGN);
	debug = getenv("SWAYDESK_TILE_DEBUG") != NULL;
	const char *path = getenv("SWAYSOCK");
	if (!path)
		fail("SWAYSOCK is not set");
	cmd_fd = ipc_connect(path);
	ev_fd = ipc_connect(path);
	if (cmd_fd < 0 || ev_fd < 0)
		fail("cannot connect to Sway");
	if (!subscribe())
		fail("cannot subscribe to Sway events");
	if (!pass(A_NONE))
		fail("cannot read the Sway tree");
	while (!quit) {
		struct pollfd p = { .fd = ev_fd, .events = POLLIN };
		// Sway raises no event for a mouse drag and some focus changes: a look once a second.
		int wait = fit_pending ? ms_until(&fit_at) : LOOK_MS;
		int r = poll(&p, 1, wait < LOOK_MS ? wait : LOOK_MS);
		if (r < 0) {
			if (errno == EINTR)
				continue;
			break;
		}
		bool dirty = r == 0;
		enum action act = A_NONE;
		if (r > 0) {
			if (!(p.revents & POLLIN))
				break;
			// Everything already queued is read before the tree is, so a burst costs one pass.
			do {
				struct msg m;
				if (!ipc_recv(ev_fd, &m))
					goto out;
				on_event(&m, &dirty, &act);
				free(m.data);
				if (quit || act != A_NONE)
					break;
				p.revents = 0;
			} while (poll(&p, 1, 0) > 0 && (p.revents & POLLIN));
		}
		if (quit)
			break;
		if ((dirty || act != A_NONE) && !pass(act))
			break;
		if (fit_pending && ms_until(&fit_at) == 0 && !run_fit())
			break;
	}
out:
	for (size_t i = 0; i < nstates; i++) {
		free(states[i].known.v);
		free(states[i].floating.v);
	}
	free(states);
	free(mru.v);
	free(immune.v);
	free(fit_ids.v);
	close(cmd_fd);
	close(ev_fd);
	return EXIT_SUCCESS;
}
