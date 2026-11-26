const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../match_store.js');

const result = (n, abandoned = false) => ({ id: 'b' + n, schema: 1, abandoned, misses: n % 3, activeMs: 1000 * n });

test('fresh store loads empty with a device id', async () => {
    const s = S.memory();
    const d = await s.load();
    assert.equal(d.meta.userId, 'local');
    assert.match(d.meta.deviceId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(d.items['kanji-meaning'], {});
    assert.deepEqual(d.log, []);
});

test('saveBoard writes items, confusions, bests, days, log', async () => {
    const s = S.memory();
    await s.saveBoard({ deck: 'kanji-meaning', items: { 'k:山': { box: 2 } }, confusions: {}, bests: { x: { misses: 0 } },
                        day: { key: '2026-11-19', boards: 1, misses: 2, activeMs: 5000 }, result: result(1) });
    await s.saveBoard({ deck: 'kanji-meaning', items: { 'k:山': { box: 3 } }, confusions: {}, bests: {},
                        day: { key: '2026-11-19', boards: 1, misses: 1, activeMs: 3000 }, result: result(2) });
    const d = await s.load();
    assert.equal(d.items['kanji-meaning']['k:山'].box, 3);
    assert.deepEqual(d.days['2026-11-19'], { boards: 2, misses: 3, activeMs: 8000 });
    assert.equal(d.log.length, 2);
    assert.equal(d.meta.boardsSinceExport, 2);
});

test('log keeps only the last LOG_KEEP boards', async () => {
    const s = S.memory();
    for (let i = 0; i < S.LOG_KEEP + 5; i++) await s.saveBoard({ deck: 'kanji-meaning', items: {}, confusions: {}, bests: {}, result: result(i) });
    const d = await s.load();
    assert.equal(d.log.length, S.LOG_KEEP);
    assert.equal(d.log[0].id, 'b5');
});

test('storage full: the log shrinks instead of losing progress', async () => {
    const mem = S.memoryStorage();
    const real = mem.setItem;
    mem.setItem = (k, v) => {
        if (k.endsWith('.log') && v.length > 400) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
        real(k, v);
    };
    const s = S.create(mem);
    for (let i = 0; i < 20; i++) await s.saveBoard({ deck: 'kanji-meaning', items: { a: { box: i } }, confusions: {}, bests: {}, result: result(i) });
    const d = await s.load();
    assert.equal(d.items['kanji-meaning'].a.box, 19);
    assert.ok(d.log.length < 20);
});

test('damaged data is set aside and reset, with a warning', async () => {
    const mem = S.memoryStorage();
    mem.setItem(S.PREFIX + 'bests', '{not json');
    const s = S.create(mem);
    const d = await s.load();
    assert.deepEqual(d.bests, {});
    assert.equal(d.warnings.length, 1);
    assert.ok([...mem._map.keys()].some(k => k.startsWith(S.PREFIX + 'corrupt.bests.')));
});

test('export → reset → import restores progress; foreign files are rejected', async () => {
    const s = S.memory();
    await s.saveSettings({ level: 'N4', size: 12 });
    await s.saveBoard({ deck: 'kanji-meaning', items: { 'k:山': { box: 4 } }, confusions: { 'k:休|k:体': { count: 1 } },
                        bests: { k: { misses: 0 } }, day: { key: '2026-11-19', boards: 1 }, result: result(1) });
    const backup = JSON.parse(JSON.stringify(await s.exportAll()));
    assert.equal(backup.format, S.FORMAT);
    assert.deepEqual(s.summary(backup).items, 1);
    await s.reset();
    assert.deepEqual((await s.load()).items['kanji-meaning'], {});
    await s.importAll(backup);
    const d = await s.load();
    assert.equal(d.items['kanji-meaning']['k:山'].box, 4);
    assert.equal(d.settings.size, 12);
    // R6: the old 'a|b' key comes back repaired as a JSON pair
    assert.equal(d.confusions['kanji-meaning']['["k:休","k:体"]'].count, 1);
    await assert.rejects(s.importAll({ hello: 1 }), /not a Kanji Match backup/);
    await assert.rejects(s.importAll({ format: S.FORMAT, schema: 99, decks: {} }), /version 99/);
});
