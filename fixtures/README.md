# Golden-reference fixtures

`pnpm test:golden` runs every CSV here against the study named by its folder (INDICATORS.md §0).

```
fixtures/<study-id>/<SYMBOL>_<interval>.csv    t,o,h,l,c,v,<expected columns…>
fixtures/<study-id>/<SYMBOL>_<interval>.json   optional study config (missing keys → defaults)
```

* `t` is the bar open time in epoch ms (UTC). Lines starting with `#` are comments. Empty expected cells are skipped; `NaN` means "no value".
* Expected column names come from each study's `golden()` mapping:
  * `td-sequential`: `setup` (+sell / −buy count), `countdown` (+sell / −buy), `tdst_res`, `tdst_sup`
  * `td-combo`: `combo` · `td-demarker-1`: `dem1` · `td-demarker-2`: `dem2` · `td-rei`: `rei`
* **Any mismatch** → add a row to `docs/VERIFY_LOG.md` (bar, expected, actual, suspected rule) and ask before changing a default.

## Provenance

| File | Source |
|---|---|
| `HAND-*` | Hand-traced by us; the trace is written out in the test comments (`packages/engine/test/*.test.ts`) and agrees with the independent oracle in `sequential.test.ts`. **Not** vendor data. |
| `<SYMBOL>_<interval>.csv` (to add) | Exports from a platform with licensed DeMark studies, or counts hand-checked against Brian's reference copy. |
| `REF-*` (**local only, git-ignored**) | Public OHLC (Yahoo, Coinbase) with counts and levels read off Brian's vendor reference screenshots. Only the visible values are filled in; open VERIFY_LOG items are left blank. See `docs/VERIFY_LOG.md` note 4. |

Do not commit vendor data whose licence forbids redistribution — keep such files local (they are picked up the same way).
