// libFuzzer target: random and damaged Sway trees through the parser, the shape check and every
// command builder. clang -g -O1 -fsanitize=fuzzer,address,undefined fuzz.c $(pkg-config --cflags --libs json-c)
#define main tile_main
#include "main.c"
#undef main

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
	json_object *root = parse_json((const char *)data, size);
	if (!root)
		return 0;
	struct tree t;
	memset(&t, 0, sizeof t);
	t.focus_wsi = NONE;
	walk(&t, root, NONE, NONE, (struct rect){ 0, 0, 0, 0 }, 0);
	json_object_put(root);
	struct buf b = { 0 };
	struct list v = { 0 }, want = { 0 };
	struct ids known = { 0 };
	for (size_t wsi = 0; wsi < t.nws; wsi++) {
		size_t ws = t.ws[wsi].node, r;
		v.len = 0;
		collect(&t, ws, &v);
		enum shape sh = classify(&t, ws, &v, &r);
		struct state s = { .automatic = true, .mfact = MFACT_DEFAULT };
		if (sh == S_MASTER)
			capture_mfact(&s, &t, r);
		if (v.len) {
			ids_push(&known, t.n[v.v[0]].id);
			want.len = 0;
			desired(&t, &v, &known, &want);
			build_master(&b, &t, wsi, &want, s.mfact);
			build_monocle(&b, &t, wsi, &v);
			tidy(&b, &t, &v);
			for (enum action a = A_RETILE; a <= A_SWAP_PREV; a++)
				run_action(&b, &t, wsi, a, &v, sh, &s);
		}
		free(s.known.v);
	}
	for (size_t k = 0; k < t.nf; k++)
		ids_push(&fit_ids, t.fl[k].id);
	fit(&b, &t);
	fit_ids.len = 0;
	free(b.p);
	free(v.v);
	free(want.v);
	free(known.v);
	tree_free(&t);
	return 0;
}
