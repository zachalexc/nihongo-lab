# Kanji Match data tools

Rebuild the data after changing the kanji list, the vocab lists or the gloss corrections:

```
cd "C:\Development\projects\Nihongo Lab"
python match\tools\build_match_data.py          # writes match\data\*.json, tools\out\build_report.txt, tools\out\gloss_review_N5_N4.tsv
python match\tools\build_match_data.py --check  # only checks, writes nothing to match\data
node --test match\tests\core.test.js match\tests\store.test.js match\tests\sim.test.js
```

Needs Python 3 with `openpyxl`. The first run downloads KANJIDIC2 (≈ 1.3 MB) from GitHub into
`tools\cache\` (not committed).

| File | What it is |
|---|---|
| `gloss_overrides.tsv` | hand-picked card text: `kanji<TAB>card text<TAB>second meaning (optional)` |
| `synonyms.tsv` | English words that mean nearly the same; such cards never share a board |
| `names_extras.txt` | N1-sheet kanji that aren't on the usual N1 list → the "Extras" level |
| `out\gloss_review_N5_N4.tsv` | every N5–N4 card text with the alternatives, for review (open in Excel) |
| `out\build_report.txt` | what the build changed, skipped or added |

When the data changes, the page picks it up automatically (`data/meta.json` carries a build id).
Tuning numbers for the game (how late is "late", review intervals, board mix) are in `TUNING` at the top
of `match_core.js`; run `node --test match\tests\sim.test.js` after changing them.

## Inputs
The build reads `kanji_list.xlsx`, `n1.txt` … `n5.txt` and `JMdict_e.gz` from the repo root. They are
untracked: a fresh clone can't rebuild `data/`, but the site only needs the generated `data/` files, which
are committed. `JMdict_e.gz` (≈ 10 MB) stays out of git. Whether to commit the xlsx and txt lists is a later,
separate decision, never part of a Match commit.
