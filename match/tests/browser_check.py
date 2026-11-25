#!/usr/bin/env python3
"""Browser checks for Kanji Match (Playwright + Chromium; cloud workspace only).

  cd <repo>; python -m http.server 8765 &
  python match/tests/browser_check.py --base http://localhost:8765 [--wanakana path/to/wanakana.min.js] [--shots dir]

Checks: layout at phone / landscape / PC sizes for 6 / 8 / 12 pairs (no page scroll, cards >= 44 px, the
longest card texts fit), a full board by tapping (learn panel after every match incl. the last, a miss
shakes and reveals nothing), summary and Next board, keyboard-only play, Esc to quit, reduced motion,
progress kept after reload, Review, export -> reset -> import, and the main Nihongo Lab page (link,
tabs still switch, no errors).
"""
import argparse, json, os, sys, tempfile
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--base', default='http://localhost:8765')
ap.add_argument('--wanakana', help='local wanakana.min.js for the main page (unpkg is offline here)')
ap.add_argument('--shots', help='folder for screenshots')
a = ap.parse_args()
MATCH = a.base + '/match/'
failures = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        failures.append(msg)


def shot(page, name):
    if a.shots:
        os.makedirs(a.shots, exist_ok=True)
        page.screenshot(path=os.path.join(a.shots, name + '.png'))


def new_page(browser, w, h, mobile, **kw):
    ctx = browser.new_context(viewport={'width': w, 'height': h}, has_touch=mobile, is_mobile=mobile, **kw)
    page = ctx.new_page()
    page.errors = []
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    page.on('console', lambda m: page.errors.append(m.text) if m.type == 'error' and 'fonts.g' not in m.text
            and 'ERR_' not in m.text else None)
    page.route('**/fonts.googleapis.com/**', lambda r: r.fulfill(status=200, body='', content_type='text/css'))
    if a.wanakana:
        page.route('**/unpkg.com/wanakana*', lambda r: r.fulfill(path=a.wanakana, content_type='application/javascript'))
    return ctx, page


def start(page, level='N5', size=8, lower=False, mode='play'):
    page.check(f'input[name="level"][value="{level}"]', force=True)
    page.check(f'input[name="size"][value="{size}"]', force=True)
    page.set_checked('#include-lower', lower)
    page.wait_for_timeout(200)
    page.click('#play-btn' if mode == 'play' else '#review-btn')
    page.wait_for_selector('#play:not(.hidden) #zone-kanji .card')


def board_ids(page):
    return page.eval_on_selector_all('#zone-kanji .card:not(.gone):not(.ok)', 'cs => cs.map(c => c.dataset.id)')


def tap_pair(page, kid, aid):
    page.click(f'#zone-kanji .card[data-id="{kid}"]')
    page.click(f'#zone-answers .card[data-id="{aid}"]')


def play_out(page, miss_first=0):
    """Clear the board; make `miss_first` wrong pairs first. Returns learn-panel kanji after each match."""
    ids = board_ids(page)
    for i in range(miss_first):
        tap_pair(page, ids[i], ids[i + 1])
        page.wait_for_timeout(50)
    learned = []
    for kid in ids:
        tap_pair(page, kid, kid)
        page.wait_for_timeout(30)
        learned.append(page.text_content('#learn .lp-tile'))
    page.wait_for_selector('#summary:not(.hidden)')
    return ids, learned


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ------------------------------------------------------------ layout
    print('Layout')
    for name, (w, h, mobile) in {'small phone 360x560': (360, 560, True), 'phone 390x700': (390, 700, True),
                                 'landscape 700x390': (700, 390, True), 'PC 1366x768': (1366, 768, False)}.items():
        ctx, page = new_page(browser, w, h, mobile)
        page.goto(MATCH + '?seed=5&test=1')
        page.wait_for_selector('#progress-bars .lv-row')
        for size in (6, 8, 12):
            start(page, 'X', size, lower=True)        # loads every level, so all glosses are available
            m = page.evaluate('''() => {
                const cards = [...document.querySelectorAll('#table .card')];
                const small = cards.filter(c => { const r = c.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).length;
                const items = [...window.__match.byId.values()];
                const longest = items.map(it => it.gloss + (it.gloss2 ? ', ' + it.gloss2 : ''))
                                     .sort((x, y) => y.length - x.length);
                const ans = [...document.querySelectorAll('#zone-answers .gl')];
                ans.forEach((g, i) => { g.textContent = longest[i]; });
                const cut = ans.filter(g => g.scrollHeight > g.clientHeight + 1 || g.scrollWidth > g.clientWidth + 1)
                               .map(g => g.textContent);
                const learn = document.getElementById('learn').getBoundingClientRect();
                const table = document.getElementById('table').getBoundingClientRect();
                return { scroll: document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1,
                         small, cut, learnVisible: learn.height > 60 && learn.bottom <= innerHeight + 1, tableH: table.height };
            }''')
            check(not m['scroll'], f'{name}, {size} pairs: no page scroll')
            check(m['small'] == 0, f'{name}, {size} pairs: all cards at least 44 px ({m["small"]} smaller)')
            check(not m['cut'], f'{name}, {size} pairs: longest card texts fit {m["cut"][:3]}')
            check(m['learnVisible'], f'{name}, {size} pairs: learn panel visible')
            shot(page, f'layout-{w}x{h}-{size}')
            page.click('#quit-btn'); page.click('#quit-yes')
            page.wait_for_selector('#home:not(.hidden)')
        check(not page.errors, f'{name}: no console errors {page.errors[:2]}')
        ctx.close()

    # ------------------------------------------------------------ full play on a phone
    print('Play')
    ctx, page = new_page(browser, 390, 700, True)
    page.goto(MATCH + '?seed=11&test=1')
    page.wait_for_selector('#progress-bars .lv-row')
    start(page, 'N5', 8)
    ids = board_ids(page)
    tap_pair(page, ids[0], ids[1])
    page.wait_for_timeout(60)
    check(page.eval_on_selector(f'#zone-kanji .card[data-id="{ids[0]}"]', 'c => c.classList.contains("miss")'),
          'a wrong pair shakes the cards')
    check(page.is_visible('#learn .learn-empty'), 'a wrong pair reveals nothing in the learn panel')
    check(page.text_content('#bar-misses').startswith('1 '), 'wrong pairs counted in the bar')
    page.wait_for_timeout(500)
    # same-zone tap moves the selection, not a miss
    page.click(f'#zone-kanji .card[data-id="{ids[2]}"]'); page.click(f'#zone-kanji .card[data-id="{ids[3]}"]')
    check(page.text_content('#bar-misses').startswith('1 '), 'tapping two kanji just moves the selection')
    page.click(f'#zone-kanji .card[data-id="{ids[3]}"]')     # deselect
    shot(page, 'play-phone-midboard')
    learned = []
    for kid in ids:
        tap_pair(page, kid, kid); page.wait_for_timeout(30)
        learned.append(page.text_content('#learn .lp-tile'))
    page.wait_for_selector('#summary:not(.hidden)')
    want = [page.evaluate(f'() => window.__match.byId.get("{i}").k') for i in ids]
    check(learned == want, 'learn panel shows each matched kanji, including the last pair')
    check(page.text_content('#learn .lp-tile') == want[-1], 'learn panel keeps the last kanji on the summary')
    check('1' in page.text_content('#summary .stats'), 'summary shows the wrong pair')
    check(page.is_visible('#summary .again button'), 'summary lists kanji worth another look')
    shot(page, 'play-phone-summary')
    saved = page.evaluate('() => Object.keys(JSON.parse(localStorage.getItem("nihongoMatch.v1.items.kanji-meaning") || "{}")).length')
    check(saved == 8, f'progress saved for all 8 kanji ({saved})')
    page.keyboard.press('Enter')                              # Next board has focus
    page.wait_for_selector('#zone-kanji:not(.hidden) .card')
    ids2 = board_ids(page)
    check(len(ids2) == 8 and ids2 != ids, 'Next board starts a new board')
    play_out(page, miss_first=2)
    page.click('#summary .btn:not(.primary)')                 # Home
    page.wait_for_selector('#home:not(.hidden)')
    check('Review (' in page.text_content('#review-btn'), 'Review offers the kanji that need work')
    page.reload(); page.wait_for_selector('#progress-bars .lv-row')
    check('need work' in page.text_content('#progress-bars') and 'Boards today: 2' in page.text_content('#progress-facts'),
          'progress and boards today survive a reload')
    start(page, 'N5', 8, mode='review')
    check(len(board_ids(page)) == 8, 'a review board fills up to the board size')
    page.keyboard.press('Escape')
    check(page.is_visible('#quit-bar'), 'Esc asks before quitting')
    page.click('#quit-yes'); page.wait_for_selector('#home:not(.hidden)')
    check(not page.errors, f'no console errors while playing {page.errors[:2]}')

    # ------------------------------------------------------------ backup
    print('Backup')
    page.click('.options summary')
    with page.expect_download() as dl:
        page.click('#export-btn')
    path = os.path.join(tempfile.mkdtemp(), 'backup.json')
    dl.value.save_as(path)
    backup = json.load(open(path, encoding='utf-8'))
    check(backup['format'] == 'nihongo-match-export' and len(backup['decks']['kanji-meaning']['items']) >= 8, 'export has the progress')
    page.click('#reset-btn'); page.fill('#backup-confirm input', 'reset')
    page.click('#backup-confirm .danger-quiet')
    page.wait_for_timeout(200)
    check('80 not seen yet' in page.text_content('#progress-bars'), 'reset clears progress')
    page.set_input_files('#import-file', path)
    page.wait_for_selector('#backup-confirm .primary')
    page.click('#backup-confirm .primary'); page.wait_for_timeout(300)
    check('need work' in page.text_content('#progress-bars'), 'import restores progress')
    ctx.close()

    # ------------------------------------------------------------ keyboard only, PC
    print('Keyboard')
    ctx, page = new_page(browser, 1366, 768, False)
    page.goto(MATCH + '?seed=21&test=1'); page.wait_for_selector('#progress-bars .lv-row')
    page.focus('#play-btn'); page.keyboard.press('Enter')
    page.wait_for_selector('#zone-kanji .card')
    first = page.evaluate('() => document.activeElement.dataset.id')
    page.keyboard.press('ArrowRight')
    check(page.evaluate('() => document.activeElement.dataset.id') != first, 'arrow keys move between cards')
    for _ in range(8):
        kid = page.evaluate('() => document.querySelector("#zone-kanji .card:not(.ok):not(.gone)").dataset.id')
        page.focus(f'#zone-kanji .card[data-id="{kid}"]'); page.keyboard.press('Enter')
        for _ in range(30):
            page.keyboard.press('Tab')
            if page.evaluate(f'() => document.activeElement.dataset.id === "{kid}" && document.activeElement.dataset.kind === "a"'):
                break
        page.keyboard.press('Space'); page.wait_for_timeout(40)
    page.wait_for_selector('#summary:not(.hidden)', timeout=3000)
    check(True, 'a whole board can be played with the keyboard')
    shot(page, 'pc-summary')
    ctx.close()

    # ------------------------------------------------------------ reduced motion
    ctx, page = new_page(browser, 390, 700, True, reduced_motion='reduce')
    page.goto(MATCH + '?seed=2&test=1'); page.wait_for_selector('#progress-bars .lv-row')
    start(page)
    ids = board_ids(page); tap_pair(page, ids[0], ids[1])
    anim = page.eval_on_selector(f'#zone-kanji .card[data-id="{ids[0]}"]', 'c => getComputedStyle(c).animationName')
    check(anim == 'none', f'reduced motion: no shake ({anim})')
    ctx.close()

    # ------------------------------------------------------------ main Nihongo Lab page
    print('Main page')
    ctx, page = new_page(browser, 1366, 768, False)
    page.goto(a.base + '/'); page.wait_for_timeout(800)
    check(page.get_attribute('a[href="match/"]', 'href') == 'match/', 'link to Kanji Match on the main page')
    tabs = page.eval_on_selector_all('.tab-btn', 'bs => bs.map(b => b.dataset.tab)')
    for t in tabs:
        page.click(f'.tab-btn[data-tab="{t}"]'); page.wait_for_timeout(80)
        check(page.is_visible('#' + t), f'main page tab {t} still opens')
    check(not page.errors, f'main page: no console errors {page.errors[:2]}')
    page.click('a[href="match/"]'); page.wait_for_selector('#home h1')
    check(page.text_content('#home h1') == 'Kanji Match', 'the link opens Kanji Match')
    ctx.close()
    browser.close()

print(f'\n{len(failures)} failure(s)')
sys.exit(1 if failures else 0)
