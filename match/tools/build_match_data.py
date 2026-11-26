#!/usr/bin/env python3
"""Build the Kanji Match data files (match/data/*.json) from:

  kanji_list.xlsx         which kanji are in which JLPT level (one sheet per level)
  n5.txt ... n1.txt       vocabulary lists (Kanji, Hiragana, English): gloss choice and example words
  JMdict_e.gz             fallback example words (common entries only)
  KANJIDIC2 (JSON)        meanings and readings, from the scriptin/jmdict-simplified release below
  jlpt_words.json         words and readings for the Words cards (read only; Endless's file)
  tools/gloss_overrides.tsv, tools/synonyms.tsv, tools/names_extras.txt

Usage (from the repo folder):
  python match/tools/build_match_data.py            build data + review file + report
  python match/tools/build_match_data.py --check    build into a temp folder and only run the checks

KANJIDIC2 and JMdict are (c) the Electronic Dictionary Research and Development Group (EDRDG),
used under the Creative Commons Attribution-ShareAlike 4.0 licence. The generated data files are
shared under the same licence (see match/DATA_LICENSE.md).
"""
import argparse, collections, glob, gzip, hashlib, io, json, os, re, sys, tempfile, urllib.request, zipfile
import xml.etree.ElementTree as ET
from datetime import date

KANJIDIC_RELEASE = "3.6.2+20261116213322"
KANJIDIC_ZIP = f"kanjidic2-en-{KANJIDIC_RELEASE}.json.zip"
KANJIDIC_URL = f"https://github.com/scriptin/jmdict-simplified/releases/download/{KANJIDIC_RELEASE}/{KANJIDIC_ZIP}"

LEVELS = ["N5", "N4", "N3", "N2", "N1", "X"]          # X = Extras (N1-sheet kanji not on the usual N1 list)
DIFF = {lv: i for i, lv in enumerate(LEVELS)}          # 0 = easiest
MAX_GLOSS = 22                                         # characters on an answer card
MAX_EXAMPLES = 3

HERE = os.path.dirname(os.path.abspath(__file__))
MATCH = os.path.dirname(HERE)


def norm(s):
    """Same normalisation as MatchCore.norm in match_core.js (keep them in step)."""
    s = re.sub(r"\(.*?\)", "", s.lower())
    s = re.sub(r"^(to|a|an|the) ", "", s.strip())
    return re.sub(r"\s+", " ", s).strip()


def is_kanji(c):
    return "一" <= c <= "鿿" or c == "々"


def kana_only(s):
    return re.fullmatch(r"[ぁ-ゖァ-ヺー]+", s) is not None


# ---------------------------------------------------------------- inputs
def load_levels(repo):
    import openpyxl
    wb = openpyxl.load_workbook(os.path.join(repo, "kanji_list.xlsx"), read_only=True)
    extras = set(open(os.path.join(HERE, "names_extras.txt"), encoding="utf-8").read().split("\n")[-2].strip())
    levels, seen = {lv: [] for lv in LEVELS}, {}
    for lv in LEVELS[:5]:
        for row in wb[lv].iter_rows(values_only=True):
            for k in row:
                if not k:
                    continue
                k = str(k).strip()
                if k in seen:
                    sys.exit(f"ERROR: {k} is listed in both {seen[k]} and {lv}")
                seen[k] = lv
                levels["X" if (lv == "N1" and k in extras) else lv].append(k)
    missing = extras - set(levels["X"])
    if missing:
        sys.exit(f"ERROR: names_extras.txt kanji not on the N1 sheet: {''.join(missing)}")
    return levels


def load_kanjidic(cache):
    path = os.path.join(cache, KANJIDIC_ZIP)
    if not os.path.exists(path):
        print(f"Downloading {KANJIDIC_URL}")
        os.makedirs(cache, exist_ok=True)
        urllib.request.urlretrieve(KANJIDIC_URL, path)
    with zipfile.ZipFile(path) as z:
        name = [n for n in z.namelist() if n.endswith(".json")][0]
        kd = json.loads(z.read(name))
    out = {}
    for ch in kd["characters"]:
        rm = ch.get("readingMeaning")
        groups = rm["groups"] if rm else []
        kun = []
        for g in groups:
            for r in g["readings"]:
                if r["type"] != "ja_kun":
                    continue
                v = r["value"]
                if v.startswith("-") or v.endswith("-"):
                    continue
                v = v.replace(".", "(", 1) + (")" if "." in v else "")
                if v not in kun:
                    kun.append(v)
        out[ch["literal"]] = dict(
            meanings=[m["value"] for g in groups for m in g["meanings"] if m["lang"] == "en"],
            on=list(dict.fromkeys(r["value"] for g in groups for r in g["readings"] if r["type"] == "ja_on")),
            kun=kun,
            strokes=ch["misc"]["strokeCounts"][0],
            freq=ch["misc"].get("frequency"),
        )
    return out, kd.get("dictDate"), kd.get("version")


def load_vocab(repo, report):
    words = []
    for lv in LEVELS[:5]:
        with open(os.path.join(repo, f"{lv.lower()}.txt"), encoding="utf-8") as f:
            rows = [l.rstrip("\r\n").split("\t") for l in f][1:]
        for r in rows:
            if len(r) < 3 or not r[0].strip():
                continue                                   # kana-only word
            w, kana, en = r[0].strip(), r[1].strip(), r[2].strip()
            if not any(is_kanji(c) for c in w):
                continue                                   # kana word in the Kanji column
            kana = re.sub(r"[()（）]", "", kana.replace("・する", "")).split("/")[0].split()[0] if kana.strip() else ""
            if not kana_only(kana):
                report["skipped vocab rows"].append(f"{lv} {w} {r[1]!r}")
                continue
            senses = [s.strip() for s in re.split(r"[,;]", en) if s.strip()]
            words.append(dict(w=w, r=kana, en="; ".join(senses[:2]), senses=senses, lv=lv))
    return words


def load_jmdict_common(repo, wanted):
    """JMdict words containing any kanji in `wanted`, most common first:
    tier 0 = ichi1/news1/spec1, tier 1 = any other priority mark, tier 2 = no mark."""
    out = collections.defaultdict(list)
    with gzip.open(os.path.join(repo, "JMdict_e.gz")) as f:
        for _, el in ET.iterparse(f):
            if el.tag != "entry":
                continue
            rebs = [r for r in el.findall("r_ele") if r.find("re_nokanji") is None]
            gl = [g.text for s in el.findall("sense")[:1] for g in s.findall("gloss")[:2] if g.text]
            if rebs and gl:
                for k in el.findall("k_ele"):
                    w = k.findtext("keb")
                    hit = set(w) & wanted
                    if not hit:
                        continue
                    pri = {p.text for p in k.findall("ke_pri")}
                    tier = 0 if pri & {"ichi1", "news1", "spec1"} else (1 if pri else 2)
                    for c in hit:
                        out[c].append(dict(w=w, r=rebs[0].findtext("reb"), en="; ".join(gl), lv=None, tier=tier))
                    break
            el.clear()
    for c in out:
        out[c].sort(key=lambda w: (w["tier"], len(w["w"]), w["w"]))
    return out


def load_tsv(name):
    path = os.path.join(HERE, name)
    rows = []
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\r\n")
        if line and not line.startswith("#"):
            rows.append(line.split("\t"))
    return rows


# ---------------------------------------------------------------- gloss choice
SKIP_MEANING = re.compile(r"radical|sign of the|kokuji|\bzodiac\b|\(no\.", re.I)


def choose_gloss(k, meanings, words):
    cands = [m for m in meanings[:6] if not SKIP_MEANING.search(m)] or meanings[:1]
    single = [w for w in words if re.fullmatch(re.escape(k) + r"[ぁ-ゖ]*", w["w"])]
    scored = []
    for i, m in enumerate(cands):
        nm = norm(m)
        if not nm:
            continue
        s = 0
        for w in single:
            s += 3 * sum(1 for g in w["senses"] if norm(g) == nm or nm in norm(g).split())
        for w in words:
            s += sum(1 for g in w["senses"] if re.search(r"\b" + re.escape(nm) + r"\b", norm(g)))
        scored.append((s - 0.3 * i, s, m))
    scored.sort(key=lambda x: -x[0])
    def fit(m):
        m2 = re.sub(r"\s*\(.*?\)\s*", " ", m).strip()
        return m if len(m) <= MAX_GLOSS else (m2 if m2 and len(m2) <= MAX_GLOSS else None)
    scored = [(a, b, fit(m)) for a, b, m in scored if fit(m)]
    best = scored[0][2] if scored else meanings[0][:MAX_GLOSS]
    second = None
    for _, raw, m in scored[1:]:
        if raw > 0 and norm(m) != norm(best) and len(best) + len(m) + 3 <= MAX_GLOSS:
            second = m
            break
    evidence = ", ".join(f"{m}:{raw}" for _, raw, m in scored[:5])
    return best, second, evidence


# ---------------------------------------------------------------- build

# ---------------------------------------------------------------- words (deck "word-reading")
def build_words(repo, level_of, report, errors):
    """Match's own word files from Endless's jlpt_words.json (read only). A word belongs to level L
    if all its kanji are at or below L and at least one is at L. 々 counts as no kanji."""
    src = json.load(open(os.path.join(repo, "jlpt_words.json"), encoding="utf-8"))
    col = {f: i for i, f in enumerate(src["fields"])}
    by_level = {lv: [] for lv in LEVELS}
    seen_ids, skipped = set(), collections.Counter()
    for row in src["rows"]:
        t, r = row[col["t"]], row[col["r"]]
        ks = [c for c in dict.fromkeys(t) if is_kanji(c) and c != "々"]
        if not ks:
            skipped["kana-only"] += 1; continue
        if any(c not in level_of for c in ks):
            skipped["kanji not in the kanji data"] += 1; continue
        wid = f"w:{t}|{r}"
        if wid in seen_ids:
            errors.append(f"duplicate word id {wid}"); continue
        seen_ids.add(wid)
        alt = [a for a in (row[col["alt"]] or "").split(",") if a and a != r]
        lv = max((level_of[c] for c in ks), key=lambda x: DIFF[x])
        by_level[lv].append(dict(
            id=wid, k=t, r=r, alt=alt, split=row[col["split"]], gloss=row[col["gloss"]],
            lv=lv, kanji=ks, zipf=row[col["zipf"]] or 0,
            shown=[r, "#" + t], keys=sorted(set([r, "#" + t] + alt))))
    for lv, items in by_level.items():
        items.sort(key=lambda w: (-w["zipf"], w["id"]))
        for i, w in enumerate(items):          # board building sorts new items by freq, then strokes
            w["freq"] = i + 1; w["strokes"] = len(w["k"]); del w["zipf"]
        for w in items:                         # checks
            if kana_only(w["k"]) or not w["kanji"]:
                errors.append(f"kana-only word {w['id']}")
            if any(c not in level_of for c in w["kanji"]):
                errors.append(f"word {w['id']} has kanji missing from the kanji data")
    report["words skipped"] = [f"{k}: {v}" for k, v in sorted(skipped.items())]
    report["words per level"] = [f"{lv}: {len(v)}" for lv, v in by_level.items()]
    return by_level

def build(repo, out_dir, review_dir):
    report = collections.defaultdict(list)
    levels = load_levels(repo)
    kd, dict_date, kd_version = load_kanjidic(os.path.join(HERE, "cache"))
    words = load_vocab(repo, report)
    level_of = {k: lv for lv, ks in levels.items() for k in ks}

    overrides = {}
    for r in load_tsv("gloss_overrides.tsv"):
        overrides[r[0]] = (r[1].strip(), (r[2].strip() if len(r) > 2 and r[2].strip() else None))
    synonyms = [[norm(x) for x in r[0].split("|")] for r in load_tsv("synonyms.tsv")]

    words_with = collections.defaultdict(list)
    for w in words:
        for c in set(w["w"]):
            if c in level_of:
                words_with[c].append(w)

    need_jm = {k for k in level_of if len({w["w"] for w in words_with[k]}) < MAX_EXAMPLES}
    jm = load_jmdict_common(repo, need_jm) if need_jm else {}

    items_by_level, review = {lv: [] for lv in LEVELS}, []
    for lv in LEVELS:
        for k in levels[lv]:
            info = kd.get(k)
            if not info or not info["meanings"]:
                report["ERROR no KANJIDIC meanings"].append(k)
                continue
            auto, auto2, evidence = choose_gloss(k, info["meanings"], words_with[k])
            if k in overrides:
                gloss, gloss2 = overrides[k]
            else:
                gloss, gloss2 = auto, auto2
            if gloss != info["meanings"][0]:
                report["gloss differs from KANJIDIC first meaning"].append(f"{k} {info['meanings'][0]} → {gloss}")
            if lv in ("N5", "N4"):
                review.append([lv, k, gloss, gloss2 or "", "override" if k in overrides else "auto",
                               auto + (f" · {auto2}" if auto2 else ""), "; ".join(info["meanings"][:6]), evidence])
            shown = [norm(gloss)] + ([norm(gloss2)] if gloss2 else [])
            keys = sorted(set(norm(m) for m in info["meanings"]) | set(shown))

            def ex_key(w):
                wl = DIFF[w["lv"]] if w["lv"] else 9
                others = max([DIFF.get(level_of.get(c, "X"), 9) for c in w["w"] if is_kanji(c) and c != k] or [0])
                return (wl, others > DIFF[lv], len(w["w"]), w["w"])
            ex, seen_w = [], set()
            for w in sorted(words_with[k], key=ex_key) + jm.get(k, []):
                if w["w"] in seen_w:
                    continue
                seen_w.add(w["w"])
                ex.append([w["w"], w["r"], w["en"], w["lv"] or ""])
                if len(ex) >= MAX_EXAMPLES:
                    break
            if len(ex) < 2:
                report["fewer than 2 example words"].append(f"{lv} {k} ({len(ex)})")
            items_by_level[lv].append(dict(
                id="k:" + k, k=k, lv=lv, freq=info["freq"], strokes=info["strokes"],
                gloss=gloss, gloss2=gloss2,
                meanings=[m for m in info["meanings"] if not SKIP_MEANING.search(m)][:8] or info["meanings"][:1],
                shown=shown, keys=keys, kun=info["kun"], on=info["on"], ex=ex))

    # ------------------------------------------------ same card text within a level: add a second meaning
    for lv, items in items_by_level.items():
        groups = collections.defaultdict(list)
        for it in items:
            groups[tuple(it["shown"])].append(it)
        for shown, grp in groups.items():
            if len(grp) < 2:
                continue
            for it in grp:
                if it["k"] in overrides:
                    continue
                taken = {x for o in grp if o is not it for x in o["keys"]}
                for m in it["meanings"]:
                    nm = norm(m)
                    if SKIP_MEANING.search(m) or nm in shown or nm in taken:
                        continue
                    if len(it["gloss"]) + len(m) + 3 <= MAX_GLOSS:
                        it["gloss2"] = m
                        it["shown"] = [norm(it["gloss"]), nm]
                        it["keys"] = sorted(set(it["keys"]) | {nm})
                        report["second meaning added to tell same-text cards apart"].append(
                            f"{lv} {it['k']} {it['gloss']} · {m}")
                        break

    # ------------------------------------------------ checks
    errors = list(report.pop("ERROR no KANJIDIC meanings", []))
    for lv, items in items_by_level.items():
        by_shown = collections.defaultdict(list)
        for it in items:
            g = it["gloss"] + (" · " + it["gloss2"] if it["gloss2"] else "")
            if not it["gloss"] or len(g) > MAX_GLOSS:
                errors.append(f"{lv} {it['k']}: gloss empty or longer than {MAX_GLOSS}: {g!r}")
            if not (it["on"] or it["kun"]):
                errors.append(f"{lv} {it['k']}: no readings")
            by_shown[tuple(it["shown"])].append(it["k"])
        for s, ks in by_shown.items():
            if len(ks) > 1:
                errors.append(f"{lv}: same card text {' · '.join(s)!r} for {''.join(ks)}")
        # clash statistics (same rule as MatchCore.clash)
        syn = {}
        for gi, grp in enumerate(synonyms):
            for x in grp:
                syn.setdefault(x, set()).add(gi)
        n = 0
        for i, a in enumerate(items):
            for b in items[i + 1:]:
                if (set(a["shown"]) & set(b["keys"])) or (set(b["shown"]) & set(a["keys"])) or \
                   any(syn.get(x, set()) & syn.get(y, set()) for x in a["shown"] for y in b["shown"]):
                    n += 1
        report["clashing pairs per level (never share a board)"].append(f"{lv}: {n}")
    total = sum(len(v) for v in items_by_level.values())
    if total != len(level_of):
        errors.append(f"{len(level_of) - total} kanji missing from the output")

    # ------------------------------------------------ write
    os.makedirs(out_dir, exist_ok=True)
    files = {}
    for lv, items in items_by_level.items():
        doc = dict(schema=1, deck="kanji-meaning", level=lv, items=items)
        text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        fn = f"kanji_{lv}.json"
        with open(os.path.join(out_dir, fn), "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        files[lv] = dict(count=len(items), file=fn, sha=hashlib.sha256(text.encode()).hexdigest()[:10])
    wfiles = {}
    for lv, items in build_words(repo, level_of, report, errors).items():
        doc = dict(schema=1, deck="word-reading", level=lv, items=items)
        text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        fn = f"words_{lv}.json"
        with open(os.path.join(out_dir, fn), "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        wfiles[lv] = dict(count=len(items), file=fn, sha=hashlib.sha256(text.encode()).hexdigest()[:10])
    shas = [v["sha"] for v in files.values()] + [v["sha"] for v in wfiles.values()]
    build_id = hashlib.sha256("".join(shas).encode()).hexdigest()[:8]
    meta = dict(
        schema=1, build=build_id, built=date.today().isoformat(),
        levels=files, words=wfiles,
        levelNames={"N5": "N5", "N4": "N4", "N3": "N3", "N2": "N2", "N1": "N1", "X": "Extras"},
        synonyms=synonyms,
        sources=dict(
            kanjidic2=dict(release=KANJIDIC_RELEASE, dictDate=dict_date, version=kd_version,
                           licence="CC BY-SA 4.0, EDRDG"),
            jmdict=dict(file="JMdict_e.gz", use="fallback example words", licence="CC BY-SA 4.0, EDRDG"),
            lists="kanji_list.xlsx; n5.txt–n1.txt",
            words="jlpt_words.json (Nihongo Lab, CC BY-SA 4.0), deck word-reading"))
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")

    os.makedirs(review_dir, exist_ok=True)
    with open(os.path.join(review_dir, "gloss_review_N5_N4.tsv"), "w", encoding="utf-8-sig", newline="\n") as f:
        f.write("level\tkanji\tcard text\tsecond meaning\tsource\tautomatic choice\tKANJIDIC meanings (in order)\tvocab evidence (meaning:score)\n")
        for r in review:
            f.write("\t".join(r) + "\n")
    with open(os.path.join(review_dir, "build_report.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write(f"Kanji Match data build {build_id}  ({total} kanji)\n")
        f.write("Counts: " + ", ".join(f"{lv} {v['count']}" for lv, v in files.items()) + "\n\n")
        for key, vals in report.items():
            f.write(f"== {key} ({len(vals)})\n" + "\n".join(vals) + "\n\n")
        if errors:
            f.write("== ERRORS\n" + "\n".join(errors) + "\n")
    return errors, build_id, files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=os.path.dirname(MATCH), help="folder with kanji_list.xlsx, n*.txt, JMdict_e.gz")
    ap.add_argument("--check", action="store_true", help="build into a temp folder and only report")
    a = ap.parse_args()
    out = tempfile.mkdtemp() if a.check else os.path.join(MATCH, "data")
    errors, build_id, files = build(a.repo, out, os.path.join(HERE, "out"))
    print(f"Build {build_id}: " + ", ".join(f"{lv} {v['count']}" for lv, v in files.items()))
    print(f"Report: {os.path.join(HERE, 'out', 'build_report.txt')}")
    if errors:
        print(f"{len(errors)} ERRORS:\n  " + "\n  ".join(errors[:40]))
        sys.exit(1)
    print("All checks passed.")


if __name__ == "__main__":
    main()
