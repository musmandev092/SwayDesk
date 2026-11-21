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
	struct buf b = { 0 }, z = { 0 };
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
			// Known windows: none, the first, every second, all but the first, all.
			for (size_t mode = 0; mode < 5; mode++) {
				known.len = 0;
				if (mode == 3)
					ids_push(&known, -1);
				for (size_t i = 0; i < v.len; i++)
					if (mode == 4 || (mode == 1 && i == 0) || (mode == 2 && i % 2 == 0) || (mode == 3 && i > 0))
						ids_push(&known, t.n[v.v[i]].id);
				want.len = 0;
				desired(&t, &v, &known, &want);
				size_t last = NONE;
				s.known = known;
				place(&b, &z, &t, wsi, &v, &want, &s, &last);
				build_master(&b, &z, &t, wsi, &want, s.mfact);
			}
			s.known = (struct ids){ 0 };
			build_monocle(&b, &t, wsi, &v);
			single(&b, &t, ws, &v, true);
			single(&b, &t, ws, &v, false);
			if (sh == S_MASTER) {
				tidy_master(&b, &t, r, &v, s.mfact);
				sizes_off(&t, r, &v, s.mfact);
			}
			for (enum action a = A_RETILE; a <= A_SWAP_PREV; a++)
				run_action(&b, &z, &t, wsi, a, &v, sh, r, &s);
			b.len = z.len = 0;
		}
		free(s.known.v);
	}
	for (size_t k = 0; k < t.nf; k++)
		ids_push(&fit_ids, t.fl[k].id);
	fit(&b, &t);
	fit_ids.len = 0;
	free(b.p);
	free(z.p);
	free(v.v);
	free(want.v);
	free(known.v);
	tree_free(&t);
	return 0;
}
