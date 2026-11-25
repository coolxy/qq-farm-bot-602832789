const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const { createSweetPotatoService } = require('../dist/services/activity-center/sweet-potato');
const {
    SWEET_POTATO,
    SWEET_POTATO_DEFAULTS,
    sweetPotatoEnabled,
} = require('../dist/config/sweet-potato');

const ACTIVITY_START = 1796000000;

async function loadTypes() {
    const root = new protobuf.Root();
    await root.load([
        path.join(__dirname, '../src/proto/activitypb.proto'),
        path.join(__dirname, '../src/proto/sweet-potato.proto'),
        path.join(__dirname, '../src/proto/corepb.proto'),
        path.join(__dirname, '../src/proto/itempb.proto'),
        path.join(__dirname, '../src/proto/sharepb.proto'),
    ], { keepCase: true });
    const lookup = name => root.lookupType(`gamepb.activitypb.${name}`);
    return {
        raw: root,
        GetGroupRequest: root.lookupType('gamepb.activitypb.GetGroupRequest'),
        BagRequest: root.lookupType('gamepb.itempb.BagRequest'),
        BagReply: root.lookupType('gamepb.itempb.BagReply'),
        CheckCanShareRequest: root.lookupType('gamepb.sharepb.CheckCanShareRequest'),
        CheckCanShareReply: root.lookupType('gamepb.sharepb.CheckCanShareReply'),
        ReportShareRequest: root.lookupType('gamepb.sharepb.ReportShareRequest'),
        SweetPotatoGroupReply: lookup('SweetPotatoGroupReply'),
        SweetPotatoOperateRequest: lookup('SweetPotatoOperateRequest'),
        SweetPotatoOperateReply: lookup('SweetPotatoOperateReply'),
        SweetPotatoActivity: lookup('SweetPotatoActivity'),
        SweetPotatoState: lookup('SweetPotatoState'),
    };
}

function encode(type, payload) {
    return Buffer.from(type.encode(type.create(payload)).finish());
}

function buildGroupReply(types, statePatch = {}) {
    return encode(types.SweetPotatoGroupReply, {
        group: {
            head: { id: SWEET_POTATO.groupId, name: '以薯换福', start_time: ACTIVITY_START - 3600, end_time: ACTIVITY_START + 86400, status: 1 },
            children: [{
                head: { id: SWEET_POTATO.activityId, group_id: SWEET_POTATO.groupId, name: '以薯换福', start_time: ACTIVITY_START - 3600, end_time: ACTIVITY_START + 86400, status: 1 },
                state: {
                    claims: { seed_claimed: false, share_claimed: false },
                    coins: 12,
                    base_price: 10,
                    bonus_price: 0,
                    capacity: 100,
                    ...statePatch,
                },
            }],
        },
    });
}

function buildDeps({ types, statePatch = {}, bag = { 20307: 3, 1032: 20, 1033: 0 }, calls = [] }) {
    let groupReply = buildGroupReply(types, statePatch);
    const deps = {
        types,
        getServerTimeSec: () => ACTIVITY_START,
        int64String: value => String(value ?? '0'),
        int64Number: value => Number(value || 0),
        itemDto: item => ({ id: String(item?.id || ''), count: String(item?.count || '') }),
        businessError: (code, message) => Object.assign(new Error(message), { code }),
        positiveDecimal: (value, code, field) => {
            const text = String(value ?? '');
            if (!/^[1-9]\d*$/.test(text)) throw Object.assign(new Error(`${field} 无效`), { code });
            return text;
        },
        serializeMutation: fn => fn(),
        getActivityCenterSnapshot: async () => ({}),
        getAutomation: () => ({ ...SWEET_POTATO_DEFAULTS }),
        getUserState: () => ({ gid: 10001 }),
        getFriends: () => [{ gid: 10002, name: '好友A' }],
        getBagItems: reply => reply.item_bag?.items || [],
        getBag: async () => ({
            item_bag: {
                items: Object.entries(bag).map(([id, count]) => ({ id: Number(id), count })),
            },
        }),
        sendMsgAsync: async (service, method, body) => {
            calls.push({ service, method, body: Buffer.from(body) });
            if (service === 'gamepb.activitypb.ActivityService' && method === 'GetGroup') {
                return { body: groupReply };
            }
            if (service === 'gamepb.itempb.ItemService' && method === 'Bag') {
                return { body: Buffer.alloc(0) };
            }
            if (service === 'gamepb.sharepb.ShareService' && method === 'CheckCanShare') {
                return { body: encode(types.CheckCanShareReply, { can_share: true }) };
            }
            if (service === 'gamepb.sharepb.ShareService' && method === 'ReportShare') {
                return { body: Buffer.alloc(0) };
            }
            if (service === 'gamepb.activitypb.ActivityService' && method === 'Operate') {
                const request = types.SweetPotatoOperateRequest.decode(body);
                assert.equal(String(request.id), SWEET_POTATO.activityId);
                if (Number(request.cmd) === 92) {
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 92,
                            get_shop: { shop: { base_price: 10, bonus_price: 2, remaining: 50, owner: { gid: String(request.get_shop.host_gid), name: '好友A' } } },
                            activity: { head: { id: SWEET_POTATO.activityId }, state: { claims: {}, base_price: 10, bonus_price: 2, capacity: 100 } },
                        }),
                    };
                }
                if (Number(request.cmd) === 93) {
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 93,
                            sell: { count: request.sell.count, price: 12, income: Number(request.sell.count) * 12, remaining: 50 - Number(request.sell.count) },
                            activity: { head: { id: SWEET_POTATO.activityId }, state: { claims: {}, base_price: 10, bonus_price: 2, capacity: 100 } },
                        }),
                    };
                }
                if (Number(request.cmd) === 91) {
                    groupReply = buildGroupReply(types, { ...statePatch, claims: { seed_claimed: true, share_claimed: false } });
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 91,
                            claim_seed: { rewards: [{ id: SWEET_POTATO.seedId, count: 5 }] },
                            activity: { head: { id: SWEET_POTATO.activityId }, state: { claims: { seed_claimed: true } } },
                        }),
                    };
                }
                if (Number(request.cmd) === 98) {
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 98,
                            share: { bonus_price: 0, price: 10 },
                            activity: { head: { id: SWEET_POTATO.activityId }, state: { claims: { share_claimed: true }, base_price: 10, bonus_price: 0 } },
                        }),
                    };
                }
            }
            throw new Error(`unexpected ${service}.${method}`);
        },
    };
    return deps;
}

test('sweet potato proto: 四个 selector 落在 191/192/193/198，cmd 与抓包一致', async () => {
    const types = await loadTypes();
    const encodeRequest = payload => types.SweetPotatoOperateRequest.decode(
        encode(types.SweetPotatoOperateRequest, { id: SWEET_POTATO.activityId, ...payload }),
    );
    // 解码后回读，确保字段号没有写错（写错时解码会丢 selector）。
    assert.equal(SWEET_POTATO.activityId, '2026111708');
    assert.deepEqual(
        { cmd: Number(encodeRequest({ cmd: 91, claim_seed: {} }).cmd), hasClaim: !!encodeRequest({ cmd: 91, claim_seed: {} }).claim_seed },
        { cmd: 91, hasClaim: true },
    );
    const shop = encodeRequest({ cmd: 92, get_shop: { host_gid: '10002' } });
    assert.equal(Number(shop.cmd), 92);
    assert.equal(String(shop.get_shop.host_gid), '10002');
    const sell = encodeRequest({ cmd: 93, sell: { host_gid: '10002', count: 6 } });
    assert.equal(Number(sell.cmd), 93);
    assert.equal(String(sell.sell.count), '6');
    const share = encodeRequest({ cmd: 98, share: {} });
    assert.equal(Number(share.cmd), 98);
    assert.ok(share.share);
});

test('sweet potato: 已领种子直接返回 changed=false，不再发 Operate', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildDeps({
        types,
        calls,
        statePatch: { claims: { seed_claimed: true, share_claimed: false } },
    }));
    const result = await service.operateSweetPotato('claim', {});
    assert.equal(result.changed, false);
    assert.match(result.message, /已领取/);
    assert.equal(calls.filter(call => call.method === 'Operate').length, 0);
});

test('sweet potato: 好友铺子价格变化时中止出售，不发写请求', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildDeps({ types, calls }));
    await assert.rejects(
        () => service.operateSweetPotato('sell', { hostGid: '10002', count: 5, expectedPrice: 11 }),
        error => error.code === 'SWEET_POTATO_PRICE_CHANGED',
    );
    assert.equal(calls.filter(call => call.method === 'Operate' && Number(types.SweetPotatoOperateRequest.decode(call.body).cmd) === 93).length, 0);
});

test('sweet potato: 收购余量不足时中止出售', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildDeps({ types, calls, bag: { 20307: 3, 1032: 100, 1033: 0 } }));
    await assert.rejects(
        () => service.operateSweetPotato('sell', { hostGid: '10002', count: 60, expectedPrice: 12 }),
        error => error.code === 'SWEET_POTATO_CAPACITY_EXCEEDED',
    );
});

test('sweet potato: 分享后暴击没涨价按结果不明处理', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildDeps({ types, calls }));
    await assert.rejects(
        () => service.operateSweetPotato('share', {}),
        error => error.code === 'SWEET_POTATO_RESULT_UNKNOWN',
    );
    // 分享前置与上报都发过，但回包 bonus_price=0，不能报成功。
    assert.ok(calls.some(call => call.method === 'ReportShare'));
});

test('sweet potato: 好友价格 30 秒内复用缓存，不重复查同一家铺子', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildDeps({ types, calls }));
    const first = await service.getSweetPotatoShops({ offset: 0 });
    const second = await service.getSweetPotatoShops({ offset: 0 });
    assert.equal(first.shops.length, 1);
    assert.equal(second.shops[0].price, 12);
    const shopQueries = calls.filter(call => call.method === 'Operate'
        && Number(types.SweetPotatoOperateRequest.decode(call.body).cmd) === 92);
    assert.equal(shopQueries.length, 1);
});

test('sweet potato: 活动自动化默认开启，且子开关受总开关约束', () => {
    assert.deepEqual(SWEET_POTATO_DEFAULTS, {
        sweet_potato: true,
        sweet_potato_claim: true,
        sweet_potato_plant: true,
        sweet_potato_sell: true,
        sweet_potato_share: true,
    });
    assert.equal(sweetPotatoEnabled({}, 'sell'), true);
    assert.equal(sweetPotatoEnabled({ sweet_potato: false }, 'sell'), false);
    assert.equal(sweetPotatoEnabled({ sweet_potato_sell: false }, 'sell'), false);
    assert.equal(sweetPotatoEnabled({ sweet_potato_sell: false }, 'claim'), true);
});

test('sweet potato: 活动 ID 已绑定到活动中心玩法', () => {
    const { buildActivityGameplayBindings, resolveActivityGameplays } = require('../dist/services/activity-gameplay-registry');
    const bindings = buildActivityGameplayBindings({});
    const resolved = resolveActivityGameplays(['2026111707', '2026111708', '2026111709'], bindings);
    assert.equal(resolved.gameplayKey, 'sweetPotato');
    assert.equal(resolved.detailTarget, 'sweetPotato');
});
