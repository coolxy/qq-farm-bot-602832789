const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 本地 runtime-paths 的 data 目录固定（不支持 FARM_DATA_DIR），
// 因此 listAllKnownFriendGidsCaches 接受可选目录参数用于测试隔离；
// 生产调用（yishuhuanfu.ts）不传参，仍读 KNOWN_FRIEND_GIDS_DIR，行为不变。
const { listAllKnownFriendGidsCaches } = require('../dist/models/store/gid-cache');

// 场景：accounts.json 只挂一个账号（本地常见），但缓存目录里有多个账号的
// <id>.json。面板好友池必须以目录为准，否则只剩本号好友，看不到历史账号的好友。
function withTempCaches(files, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yshf-gids-'));
    for (const [name, data] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data));
    }
    try {
        return fn(dir);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('listAllKnownFriendGidsCaches reads every account file, not just the current account', () => {
    withTempCaches({
        '1': { gids: [], updatedAt: 1 },
        '2': { gids: [111001, 111002], updatedAt: 2 },
        '3': { gids: [222001], updatedAt: 3 },
    }, (dir) => {
        const caches = listAllKnownFriendGidsCaches(dir);
        const byId = new Map(caches.map(entry => [entry.accountId, entry.gids]));
        assert.equal(byId.get('1').length, 0, '空缓存也要列出');
        assert.deepEqual(byId.get('2'), [111001, 111002]);
        assert.deepEqual(byId.get('3'), [222001]);
    });
});

test('a damaged cache file does not hide the other accounts', () => {
    withTempCaches({
        '2': { gids: [111001] },
        '4': { broken: true },
        '9': { gids: [999001] },
    }, (dir) => {
        const caches = listAllKnownFriendGidsCaches(dir);
        assert.equal(caches.length, 2, '损坏文件被跳过，其余仍可读');
        assert.ok(caches.some(entry => entry.accountId === '2'));
        assert.ok(caches.some(entry => entry.accountId === '9'));
    });
});
