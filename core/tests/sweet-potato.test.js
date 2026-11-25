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

function buildDeps({ types, statePatch = {}, bag = { 20307: 3, 1032: 20, 1033: 0 }, calls = [], shop = {}, catalog = null, records = [] }) {
    let groupReply = buildGroupReply(types, statePatch);
    const shopRemaining = shop.remaining ?? 50;
    const shopCanSell = shop.canSell;
    const catalogGoods = catalog || [
        { index: 10, price: 7000, status: 2, limit: 3 },
        { index: 9, price: 35000, status: 2, limit: 1 },
    ];
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
                    const shopReply = {
                        base_price: 10,
                        bonus_price: 2,
                        remaining: shopRemaining,
                        owner: { gid: String(request.get_shop.host_gid), name: '好友A' },
                    };
                    const payload = { shop: shopReply };
                    // undefined 表示回包不带 can_sell（三态里的「未下发」）。
                    if (shopCanSell !== undefined) payload.can_sell = shopCanSell;
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 92,
                            get_shop: payload,
                            activity: { head: { id: SWEET_POTATO.activityId }, state: { claims: {}, base_price: 10, bonus_price: 2, capacity: 100 } },
                        }),
                    };
                }
                if (Number(request.cmd) === 93) {
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 93,
                            sell: {
                                count: request.sell.count,
                                price: 12,
                                income: Number(request.sell.count) * 12,
                                daily_quota: 8000,
                                coins: 100,
                            },
                            activity: { head: { id: SWEET_POTATO.activityId }, state: { claims: {}, base_price: 10, bonus_price: 2, capacity: 100 } },
                        }),
                    };
                }
                if (Number(request.cmd) === 95) {
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 95,
                            records: { records },
                        }),
                    };
                }
                if (Number(request.cmd) === 97) {
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 97,
                            catalog: { goods: catalogGoods, coins: 100000 },
                        }),
                    };
                }
                if (Number(request.cmd) === 96) {
                    const goods = catalogGoods.find(entry => Number(entry.index) === Number(request.exchange.index)) || {};
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 96,
                            exchange: {
                                price: goods.price,
                                grant: { item_id: 80001, count: request.exchange.count },
                                coins: 100000 - Number(goods.price) * Number(request.exchange.count),
                            },
                            activity: { head: { id: SWEET_POTATO.activityId }, state: { claims: {}, coins: 100000 - Number(goods.price) * Number(request.exchange.count) } },
                        }),
                    };
                }
                if (Number(request.cmd) === 99) {
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 99,
                            claim_commission: { amount: 86, coins: 32156 },
                            activity: { head: { id: SWEET_POTATO.activityId }, state: { claims: {}, coins: 32156 } },
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

test('sweet potato proto: 七个 selector 落在 190+cmd，cmd 与实机抓包一致', async () => {
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
    // 兑换目录 97 / 兑换下单 96 / 领提成 99：兑换走主活动，别再打 2026111709。
    const catalog = encodeRequest({ cmd: 97, catalog: {} });
    assert.equal(Number(catalog.cmd), 97);
    assert.ok(catalog.catalog);
    const exchange = encodeRequest({ cmd: 96, exchange: { index: 10, count: 2 } });
    assert.equal(Number(exchange.cmd), 96);
    assert.equal(String(exchange.exchange.index), '10');
    assert.equal(String(exchange.exchange.count), '2');
    const commission = encodeRequest({ cmd: 99, claim_commission: {} });
    assert.equal(Number(commission.cmd), 99);
    assert.ok(commission.claim_commission);
    // 收购记录 cmd 95 的空 selector 落在 195，别和兑换目录 197 混在一起。
    const records = encodeRequest({ cmd: 95, records: {} });
    assert.equal(Number(records.cmd), 95);
    assert.ok(records.records);
});

test('sweet potato proto: 状态槽 11/13 与 can_sell 按 bool 解', async () => {
    const types = await loadTypes();
    const state = types.SweetPotatoState.decode(encode(types.SweetPotatoState, {
        coins: 32070,
        pending_commission: 86,
        commission_flag: 1,
    }));
    assert.equal(String(state.coins), '32070');
    assert.equal(String(state.pending_commission), '86');
    assert.equal(String(state.commission_flag), '1');
    const reply = types.SweetPotatoOperateReply.decode(encode(types.SweetPotatoOperateReply, {
        id: SWEET_POTATO.activityId,
        cmd: 92,
        get_shop: { shop: { base_price: 99, bonus_price: 66, remaining: 8000 }, can_sell: false },
    }));
    assert.equal(reply.get_shop.can_sell, false);
    // 未下发时必须读不出字段（= 未知），不能用 false 兜底。
    assert.equal(Object.prototype.hasOwnProperty.call(reply.get_shop, 'can_sell'), true);
    const bare = types.SweetPotatoOperateReply.decode(encode(types.SweetPotatoOperateReply, {
        id: SWEET_POTATO.activityId,
        cmd: 92,
        get_shop: { shop: { base_price: 99, bonus_price: 66, remaining: 8000 } },
    }));
    assert.equal(Object.prototype.hasOwnProperty.call(bare.get_shop, 'can_sell'), false);
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
    // 只允许后续刷新用的只读查询（cmd 97 目录），不能再发 cmd 91 写请求。
    assert.equal(calls.filter(call => call.method === 'Operate'
        && Number(types.SweetPotatoOperateRequest.decode(call.body).cmd) === 91).length, 0);
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
        sweet_potato_commission: true,
        sweet_potato_scan_friend_limit: 20,
        sweet_potato_scan_interval_minutes: 30,
        sweet_potato_sell_min_count: 1,
        sweet_potato_sell_fallback_own: true,
    });
    assert.equal(sweetPotatoEnabled({}, 'sell'), true);
    assert.equal(sweetPotatoEnabled({ sweet_potato: false }, 'sell'), false);
    assert.equal(sweetPotatoEnabled({ sweet_potato_sell: false }, 'sell'), false);
    assert.equal(sweetPotatoEnabled({ sweet_potato_sell: false }, 'claim'), true);
    assert.equal(sweetPotatoEnabled({ sweet_potato_commission: false }, 'commission'), false);
});

test('sweet potato: 活动 ID 已绑定到活动中心玩法', () => {
    const { buildActivityGameplayBindings, resolveActivityGameplays } = require('../dist/services/activity-gameplay-registry');
    const bindings = buildActivityGameplayBindings({});
    const resolved = resolveActivityGameplays(['2026111707', '2026111708', '2026111709'], bindings);
    assert.equal(resolved.gameplayKey, 'sweetPotato');
    assert.equal(resolved.detailTarget, 'sweetPotato');
});

test('sweet potato: can_sell=false 的铺子直接换一家，不发 cmd 93', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildDeps({ types, calls, shop: { canSell: false } }));
    await assert.rejects(
        () => service.operateSweetPotato('sell', { hostGid: '10002', count: 5, expectedPrice: 12 }),
        error => error.code === 'SWEET_POTATO_SHOP_CLOSED',
    );
    assert.equal(calls.filter(call => call.method === 'Operate'
        && Number(types.SweetPotatoOperateRequest.decode(call.body).cmd) === 93).length, 0);
});

test('sweet potato: 回包没带 can_sell 时按可卖处理（三态里的未知不等于拒收）', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildDeps({ types, calls }));
    const result = await service.operateSweetPotato('sell', { hostGid: '10002', count: 5, expectedPrice: 12 });
    assert.equal(result.changed, true);
    assert.equal(result.sold, 5);
});

test('sweet potato: 自家铺子不占额度，remaining=0 也能一次卖完', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildDeps({
        types, calls, shop: { remaining: 0 }, bag: { 20307: 3, 1032: 40, 1033: 0 },
    }));
    const result = await service.operateSweetPotato('sell', { count: 40 });
    assert.equal(result.changed, true);
    assert.equal(result.sold, 40);
    assert.equal(result.shop.unlimited, true);
    assert.equal(result.shop.remaining, null);
});

test('sweet potato: 出售后剩余额度按成交数递减，不把回包 field4 当日上限', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildDeps({ types, calls, shop: { remaining: 50 } }));
    const result = await service.operateSweetPotato('sell', { hostGid: '10002', count: 20, expectedPrice: 12 });
    assert.equal(result.shop.remaining, 30);
});

test('sweet potato: 有提成时发 cmd 99 领取，没提成时不发请求', async () => {
    const types = await loadTypes();
    const calls = [];
    const withCommission = createSweetPotatoService(buildDeps({
        types, calls, statePatch: { pending_commission: 86, commission_flag: 1 },
    }));
    const activity = await withCommission.getSweetPotatoActivity(false);
    assert.equal(activity.pendingCommission, 86);
    assert.equal(activity.commissionClaimable, true);
    const result = await withCommission.operateSweetPotato('commission', {});
    assert.equal(result.changed, true);
    assert.equal(result.amount, 86);
    const claimCalls = calls.filter(call => call.method === 'Operate'
        && Number(types.SweetPotatoOperateRequest.decode(call.body).cmd) === 99);
    assert.equal(claimCalls.length, 1);

    const quietCalls = [];
    const noCommission = createSweetPotatoService(buildDeps({ types, calls: quietCalls }));
    const empty = await noCommission.operateSweetPotato('commission', {});
    assert.equal(empty.changed, false);
    assert.equal(quietCalls.filter(call => call.method === 'Operate'
        && Number(types.SweetPotatoOperateRequest.decode(call.body).cmd) === 99).length, 0);
});

test('sweet potato: 兑换目录走 cmd 97，按序号与静态模板归一化', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildDeps({ types, calls }));
    const catalog = await service.getSweetPotatoShopCatalog();
    assert.equal(catalog.available, true);
    const fertilizer = catalog.goods.find(goods => goods.index === 10);
    assert.equal(fertilizer.itemId, '80001');
    assert.equal(fertilizer.name, '化肥(1小时)');
    assert.equal(fertilizer.nameKnown, true);
    assert.equal(fertilizer.price, '7000');
    assert.equal(catalog.goods.find(goods => goods.index === 9).name, '萌宠种子礼包');
    assert.equal(calls.filter(call => call.method === 'Operate'
        && Number(types.SweetPotatoOperateRequest.decode(call.body).cmd) === 97).length, 1);
});

test('sweet potato: 价格对不上静态模板时不显示名字，避免展示错商品', async () => {
    const types = await loadTypes();
    const service = createSweetPotatoService(buildDeps({
        types,
        catalog: [{ index: 10, price: 9999, status: 2, limit: 5 }],
    }));
    const catalog = await service.getSweetPotatoShopCatalog();
    assert.equal(catalog.goods[0].nameKnown, false);
    assert.equal(catalog.goods[0].itemId, '');
    assert.match(catalog.goods[0].name, /第 10 档/);
});

test('sweet potato: 兑换按 cmd 96 下单，超限购与余额不足在本地先拦', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildDeps({ types, calls, statePatch: { coins: 100000 } }));
    const ok = await service.operateSweetPotato('exchange', { index: 10, count: 2 });
    assert.equal(ok.changed, true);
    assert.equal(ok.cost, '14000');
    const exchangeCalls = calls.filter(call => call.method === 'Operate'
        && Number(types.SweetPotatoOperateRequest.decode(call.body).cmd) === 96);
    assert.equal(exchangeCalls.length, 1);
    assert.equal(String(types.SweetPotatoOperateRequest.decode(exchangeCalls[0].body).exchange.index), '10');

    await assert.rejects(
        () => service.operateSweetPotato('exchange', { index: 10, count: 4 }),
        error => error.code === 'SWEET_POTATO_EXCEED_LIMIT',
    );
    const poor = createSweetPotatoService(buildDeps({ types, calls: [], statePatch: { coins: 100 } }));
    await assert.rejects(
        () => poor.operateSweetPotato('exchange', { index: 10, count: 1 }),
        error => error.code === 'SWEET_POTATO_INSUFFICIENT_COINS',
    );
});

/**
 * 自动卖薯专用夹具：每个 gid 一份铺子行情，卖薯回包按该 gid 的成交价回写，
 * 这样「回包对不上」的分支也能通过改单个 gid 的价格来触发。
 */
function buildAutoSellDeps({ types, quotes, bag = 20, automation = {}, calls = [], badSellGid = '' }) {
    const groupReply = buildGroupReply(types);
    const priceOf = gid => {
        const quote = quotes[gid] || { base: 10, bonus: 0 };
        return quote.base + quote.bonus;
    };
    return {
        types,
        stepSpacerMs: 0,
        getServerTimeSec: () => ACTIVITY_START,
        int64String: value => String(value ?? '0'),
        int64Number: value => Number(value || 0),
        itemDto: item => ({ id: String(item?.id || ''), count: String(item?.count || '') }),
        businessError: (code, message) => Object.assign(new Error(message), { code }),
        positiveDecimal: (value, code) => {
            const text = String(value ?? '');
            if (!/^[1-9]\d*$/.test(text)) throw Object.assign(new Error('invalid'), { code });
            return text;
        },
        serializeMutation: fn => fn(),
        getActivityCenterSnapshot: async () => ({}),
        getAutomation: () => ({ ...SWEET_POTATO_DEFAULTS, ...automation }),
        getUserState: () => ({ gid: 10001 }),
        getFriends: () => Object.keys(quotes)
            .filter(gid => gid !== '10001')
            .map(gid => ({ gid: Number(gid), name: `好友${gid}` })),
        getBagItems: reply => reply.item_bag?.items || [],
        getBag: async () => ({ item_bag: { items: [{ id: SWEET_POTATO.honeyId, count: bag }] } }),
        sendMsgAsync: async (service, method, body) => {
            calls.push({ service, method, body: Buffer.from(body) });
            if (method === 'GetGroup') return { body: groupReply };
            if (method === 'Bag') return { body: Buffer.alloc(0) };
            if (method === 'Operate') {
                const request = types.SweetPotatoOperateRequest.decode(body);
                const gid = String(request.get_shop?.host_gid || request.sell?.host_gid || '10001');
                const quote = quotes[gid] || {};
                if (Number(request.cmd) === 92) {
                    const payload = {
                        shop: {
                            base_price: quote.base ?? 10,
                            bonus_price: quote.bonus ?? 0,
                            remaining: quote.remaining ?? 0,
                            owner: { gid, name: `铺子${gid}` },
                        },
                    };
                    if (quote.canSell !== undefined) payload.can_sell = quote.canSell;
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 92,
                            get_shop: payload,
                            activity: { head: { id: SWEET_POTATO.activityId }, state: { claims: {}, base_price: 10, bonus_price: 0 } },
                        }),
                    };
                }
                if (Number(request.cmd) === 93) {
                    const count = Number(request.sell.count);
                    const price = priceOf(gid) + (gid === badSellGid ? 1 : 0);
                    return {
                        body: encode(types.SweetPotatoOperateReply, {
                            id: SWEET_POTATO.activityId,
                            cmd: 93,
                            sell: { count, price, income: count * price, daily_quota: 8000 },
                            activity: { head: { id: SWEET_POTATO.activityId }, state: { claims: {}, base_price: 10, bonus_price: 0 } },
                        }),
                    };
                }
            }
            throw new Error(`unexpected ${service}.${method}`);
        },
    };
}

function sellCallsOf(types, calls) {
    return calls
        .filter(call => call.method === 'Operate' && Number(types.SweetPotatoOperateRequest.decode(call.body).cmd) === 93)
        .map(call => {
            const request = types.SweetPotatoOperateRequest.decode(call.body);
            return { gid: String(request.sell.host_gid), count: Number(request.sell.count) };
        });
}

test('sweet potato 比价: 按成交价降序，额度吃满换下一家，单轮最多 3 家', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildAutoSellDeps({
        types,
        calls,
        bag: 20,
        quotes: {
            10001: { base: 10, bonus: 0, remaining: 0 },
            10002: { base: 10, bonus: 5, remaining: 3 },
            10003: { base: 10, bonus: 20, remaining: 2 },
            10004: { base: 10, bonus: 10, remaining: 5 },
        },
    }));
    assert.equal(await service.autoSell(), true);
    // 30 > 20 > 15：前卖 2、5、3 个，剩下的 10 个留到下一轮；自家价最低且没进前三。
    assert.deepEqual(sellCallsOf(types, calls), [
        { gid: '10003', count: 2 },
        { gid: '10004', count: 5 },
        { gid: '10002', count: 3 },
    ]);
    const scan = await service.scanShops({ limit: 10 });
    assert.deepEqual(scan.shops.map(shop => shop.price), [30, 20, 15, 10]);
    assert.equal(scan.ownShop.hostGid, '10001');
});

test('sweet potato 比价: 好友都不收时兜底卖自己，关掉兜底就一笔不发', async () => {
    const types = await loadTypes();
    const quotes = {
        10001: { base: 10, bonus: 2, remaining: 0 },
        10002: { base: 10, bonus: 5, remaining: 0 },
    };
    const calls = [];
    const own = createSweetPotatoService(buildAutoSellDeps({ types, calls, bag: 8, quotes }));
    assert.equal(await own.autoSell(), true);
    assert.deepEqual(sellCallsOf(types, calls), [{ gid: '10001', count: 8 }]);

    const disabledCalls = [];
    const disabled = createSweetPotatoService(buildAutoSellDeps({
        types,
        calls: disabledCalls,
        bag: 8,
        quotes,
        automation: { sweet_potato_sell_fallback_own: false },
    }));
    assert.equal(await disabled.autoSell(), false);
    assert.deepEqual(sellCallsOf(types, disabledCalls), []);
});

test('sweet potato 比价: 低于最低出售数量时连比价都不发', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildAutoSellDeps({
        types,
        calls,
        bag: 3,
        quotes: { 10001: { base: 10, bonus: 2, remaining: 50 } },
        automation: { sweet_potato_sell_min_count: 5 },
    }));
    assert.equal(await service.autoSell(), false);
    assert.equal(calls.filter(call => call.method === 'Operate').length, 0);
});

test('sweet potato 比价: 回包价格对不上就停手，不继续卖下一家', async () => {
    const types = await loadTypes();
    const calls = [];
    const service = createSweetPotatoService(buildAutoSellDeps({
        types,
        calls,
        bag: 20,
        badSellGid: '10003',
        quotes: {
            10001: { base: 10, bonus: 0, remaining: 0 },
            10003: { base: 10, bonus: 20, remaining: 2 },
            10004: { base: 10, bonus: 10, remaining: 5 },
        },
    }));
    assert.equal(await service.autoSell(), false);
    assert.deepEqual(sellCallsOf(types, calls), [{ gid: '10003', count: 2 }]);
});

test('sweet potato 收购记录: cmd 95 解析按时间倒序并汇总提成，空回包按暂无记录处理', async () => {
    const types = await loadTypes();
    const records = [
        { timestamp: 1795590561, gid: 1006806548, count: 30, total: 4320, name: '风筝有风', avatar: 'a.png', level: 114, commission: 86 },
        { timestamp: 1795590700, gid: 10002, count: 10, total: 1440, name: '好友A', avatar: 'b.png', level: 60, commission: 28 },
    ];
    const service = createSweetPotatoService(buildDeps({ types, records }));
    const result = await service.getSweetPotatoRecords();
    assert.equal(result.count, 2);
    assert.equal(result.totalCommission, 114);
    assert.equal(result.totalIncome, 5760);
    assert.deepEqual(result.records.map(record => record.name), ['好友A', '风筝有风']);
    assert.equal(result.records[1].commission, 86);

    const calls = [];
    const empty = createSweetPotatoService(buildDeps({ types, calls, records: [] }));
    const none = await empty.getSweetPotatoRecords();
    assert.equal(none.count, 0);
    assert.match(none.message, /暂无/);
    const recordCalls = calls.filter(call => call.method === 'Operate'
        && Number(types.SweetPotatoOperateRequest.decode(call.body).cmd) === 95);
    assert.equal(recordCalls.length, 1);
});
