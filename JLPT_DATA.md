# JLPT word data (`jlpt_words.json`, `jlpt_beyond.json`)

Used by Endless mode's JLPT tab. Built by `build_jlpt_words.py` from frozen public sources (build `cdfd6a47`).

- `jlpt_words.json`: 6982 words with a kanji spelling from the JLPT N5–N1 lists (N5 503, N4 493, N3 1510, N2 1487, N1 2989).
- `jlpt_beyond.json`: 3620 common words beyond the JLPT lists (JMdict common, wordfreq Zipf ≥ 3.5).
- Row fields: t, r, alt, split, gloss, lv, zipf, common (spelling, reading, other accepted readings, furigana split, short gloss, level, Zipf × 100, JMdict common).

## Sources and licences
- **JMdict** (Electronic Dictionary Research and Development Group, EDRDG): readings, glosses, common markers. CC BY-SA 4.0.
- **JmdictFurigana** (github.com/Doublevil/JmdictFurigana): furigana splits. CC BY-SA 4.0.
- **KANJIDIC2** (EDRDG), via jamdict-data 1.5: kanji readings for the few splits JmdictFurigana lacks. CC BY-SA 4.0.
- **JLPT vocabulary lists** by Jonathan Waller, tanos.co.uk: the level of each word. CC BY.
- **wordfreq** 3.1.1 (Robyn Speer et al.): word frequency (Zipf), data CC BY-SA 4.0.

Exact versions and sha256 of every input are listed below.

## Changes
Derived and changed by `build_jlpt_words.py`: the list cells are cleaned (alternatives split, `する` dropped, kana-only rows
left out), joined to JMdict, some list errors corrected or dropped, rare or irregular spellings replaced by JMdict's preferred
spelling for the same reading, glosses shortened to the first sense, furigana and frequency added, words ordered by level and frequency.

## Licence of these files
Because they are derived from CC BY-SA 4.0 data, `jlpt_words.json` and `jlpt_beyond.json` are licensed **CC BY-SA 4.0**
(share-alike: adaptations must use the same licence, with the credits above). This applies to the data files only, not to the app code.

---
Source details (`jlpt_sources/SOURCES.md` at build time):

# jlpt_sources: frozen inputs for build_jlpt_words.py

Frozen 2026-11-25 by freeze_jlpt_sources.py (Python 3.10.12).

## Inputs
- Tanos JLPT list `n5.txt` (Jonathan Waller, tanos.co.uk, CC BY): sha256 8f60140057ca9d4d62812bfb20ce4632fc892f1d41233aa69666ef21fdf599d6
- Tanos JLPT list `n4.txt` (Jonathan Waller, tanos.co.uk, CC BY): sha256 cea1ceff587bfb5de253c5562adc35a5ab2b958714264d0d42be8fd6f5d1c504
- Tanos JLPT list `n3.txt` (Jonathan Waller, tanos.co.uk, CC BY): sha256 6d5e1bfa192889b878028523a2d5637e76684fa54d02ea06d38f6bdf6e041641
- Tanos JLPT list `n2.txt` (Jonathan Waller, tanos.co.uk, CC BY): sha256 42bad586a374df134600adf5dba5aa80533bffeee5da4f0d3939281800d608f0
- Tanos JLPT list `n1.txt` (Jonathan Waller, tanos.co.uk, CC BY): sha256 680ad318e6f89240a7fd52652b99674e5ee118d388da18106e88e3bf54785a56
- `JMdict_e.gz` (EDRDG, CC BY-SA 4.0), JMdict created 2026-09-17, 218786 entries: sha256 e40b35352337812b1f0e6ee9429b57591e5b141f5ad7a54ae3335024c33e916c
- `JmdictFurigana.json` (github.com/Doublevil/JmdictFurigana, latest release, CC BY-SA 4.0), 236694 entries: sha256 57c2afa7d153d42df97811d4a44865d10fb9104f6a7bacbbe32a0bf0c38e5abc
- KANJIDIC2 1.6 (April 2008) via jamdict-data 1.5 (`jamdict.db` sha256 871fb170e94088f1b6edbf7cf1646c1bf5dc487212846f42b1b6051024b3e7a0), EDRDG, CC BY-SA 4.0
- wordfreq (data CC BY-SA 4.0), Japanese via MeCab + ipadic: wordfreq 3.1.1, mecab-python3 1.0.12, ipadic 1.0.0, regex 2026.9.29, msgpack 1.2.4, langcodes 3.5.1, ftfy 6.3.1

## Outputs
- `tanos.json`: 8449 rows · `jmdict.json`: 52452 entries · `furigana.json`: 91895 splits · `kanjidic.json`: 4809 kanji · `zipf.json`: 86378 spellings + 48228 kana forms
- `tanos.json` sha256 88bf8673a5b35c9cbc8dad7a5aa59624c3a96169249c2f1e68e9a5781622c4df
- `jmdict.json` sha256 8877d425cb33b0b04a23e76f9ae7adb1ad972f91b5c2fb6a185786409394e14d
- `furigana.json` sha256 f1f3efded8ff5fbf91e4db077028eedc739818ed8b7009876c35d093fd99d312
- `kanjidic.json` sha256 685349dbb00ab303a7c95dfedda58897ccbeb15368bdba136923e72679be3585
- `zipf.json` sha256 052b6a34d1990e5266f4a5d8f438a020ca671bd51c2df30f156c6027e1d74001
