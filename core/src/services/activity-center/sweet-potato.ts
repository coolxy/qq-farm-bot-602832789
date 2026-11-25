export {};

/**
 * 以薯换福（2026-11）：领种子 / 红薯种植收获 / 蜜薯出售 / 分享暴击 / 兑换商店。
 *
 * 协议常量与报文结构来自官方客户端 2026-11-25 抓包；服务只在本账号 worker 里跑，
 * 所有写操作都经过「先读状态 → 校验 → 单次发送 → 回包确认」，结果不明时冷却 5 分钟，
 * 不做自动重试。
 */

const {
    SWEET_POTATO,
    SWEET_POTATO_COMMANDS,
    sweetPotatoEnabled,
    isSweetPotatoPlant,
} = require('../../config/sweet-potato');

const SERVICE = 'gamepb.activitypb.ActivityService';
const EXCHANGE_SHOP_OPERATE_TYPE = 1;
const QUERY_SHOP_OPERATE_TYPE = 7;
const RETRY_COOLDOWN_SEC = 300;
const SHOP_CACHE_TTL_MS = 30000;
const SHOP_PAGE_SIZE = 5;
const SHARE_REPORT_SOURCE = 28;
const SHARE_REPORT_SCENE = 2017;

function createSweetPotatoService(deps: any) {
    const {
        types,
        sendMsgAsync,
        getBag,
        getBagItems,
        getServerTimeSec,
        itemDto,
        int64String,
        int64Number,
        businessError,
        positiveDecimal,
        serializeMutation,
        getActivityCenterSnapshot,
    } = deps;

    /** 写操作冷却：任何「结果不明」的写都在这里挡住 5 分钟。 */
    const retryAfter = new Map<string, number>();
    /** 分享前置已成功、但 ReportShare 还没确认的日期键；跨 tick 保持，避免重复触发前置。 */
    let pendingShareDate = '';
    /** 好友铺子价格缓存：30 秒内不重复查同一家。 */
    const shopCache = new Map<string, any>();
    let shopsLoading = false;
    /** 出售幂等：同一次确认重复提交复用同一个 Promise。 */
    const sales = new Map<string, { signature: string; expiresAt: number; promise: Promise<any> }>();

    const now = (): number => Number(getServerTimeSec()) || Math.floor(Date.now() / 1000);
    const dayKey = (): string => new Date((now() + 8 * 3600) * 1000).toISOString().slice(0, 10);
    // 以下四项允许测试注入；生产环境走懒加载，避免 activity-center 与农场/好友模块互相顶层依赖。
    const automation = (): any => (deps.getAutomation
        ? deps.getAutomation()
        : require('../../models/store').getAutomation());
    const enabled = (part: string | null = null): boolean => sweetPotatoEnabled(automation(), part as any);
    const selfGid = (): string => {
        const state = deps.getUserState ? deps.getUserState() : require('../utils/network').getUserState();
        const gid = String(state?.gid || '');
        return /^[1-9]\d{0,15}$/.test(gid) ? gid : '';
    };
    const inWindow = (seconds: number): boolean => (
        seconds >= SWEET_POTATO.fallbackStartTime && seconds <= SWEET_POTATO.fallbackEndTime
    );
    const alive = (): boolean => !!selfGid() && inWindow(now());

    function assertCanOperate(part: string | null, automatic: boolean): void {
        if (!alive()) throw businessError('SWEET_POTATO_INACTIVE', '以薯换福活动未开放或账号未登录');
        if (automatic && !enabled(part)) throw businessError('SWEET_POTATO_STOPPED', '对应自动化开关已关闭');
    }

    /** 活动未下发时的短期缓存：避免每轮快照都为不存在的活动发 GetGroup。 */
    let unavailableUntil = 0;

    async function getGroup(): Promise<any> {
        if (now() < unavailableUntil) {
            throw businessError('SWEET_POTATO_INACTIVE', '以薯换福活动未开放');
        }
        const body = Buffer.from(types.GetGroupRequest.encode(types.GetGroupRequest.create({
            group_id: SWEET_POTATO.groupId,
        })).finish());
        const { body: replyBody } = await sendMsgAsync(SERVICE, 'GetGroup', body);
        const reply = types.SweetPotatoGroupReply.decode(replyBody);
        const group = reply?.group;
        const entry = (Array.isArray(group?.children) ? group.children : [])
            .find((child: any) => int64String(child?.head?.id) === SWEET_POTATO.activityId);
        if (int64String(group?.head?.id) !== SWEET_POTATO.groupId
            || int64String(entry?.head?.id) !== SWEET_POTATO.activityId
            || !entry?.state) {
            unavailableUntil = now() + 300;
            throw businessError('SWEET_POTATO_UNAVAILABLE', '以薯换福活动数据暂不可用');
        }
        unavailableUntil = 0;
        const start = int64Number(entry.head.start_time);
        const end = int64Number(entry.head.end_time);
        const active = int64Number(entry.head.status) === 1 && start <= now() && now() <= end && inWindow(now());
        return { group, entry, active, start, end };
    }

    async function inventory(): Promise<{ seeds: number; honey: number; coins: number }> {
        const items = getBagItems(await getBag());
        const count = (id: number): number => (items || [])
            .filter((item: any) => Number(item?.id) === id)
            .reduce((total: number, item: any) => total + (Number(item?.count) || 0), 0);
        return {
            seeds: count(SWEET_POTATO.seedId),
            honey: count(SWEET_POTATO.honeyId),
            coins: count(SWEET_POTATO.coinId),
        };
    }

    function rulesOf(entry: any): string[] {
        try {
            const tips = JSON.parse(String(entry?.head?.extra || '{}'))?.tips?.txt;
            return (Array.isArray(tips) ? tips : [])
                .filter((line: any) => typeof line === 'string')
                .map((line: string) => line.replace(/<[^>]*>/g, ''));
        } catch {
            return [];
        }
    }

    function toDto(data: any, bag: { seeds: number; honey: number; coins: number }, shopAvailable: boolean | null = null): any {
        const state = data.entry.state || {};
        const basePrice = int64Number(state.base_price);
        const bonusPrice = int64Number(state.bonus_price);
        return {
            activityId: SWEET_POTATO.activityId,
            groupId: SWEET_POTATO.groupId,
            shopActivityId: SWEET_POTATO.shopActivityId,
            title: '以薯换福',
            active: !!data.active,
            startTime: data.start * 1000,
            endTime: data.end * 1000,
            serverTime: now() * 1000,
            seedClaimed: !!state.claims?.seed_claimed,
            shareClaimed: !!state.claims?.share_claimed,
            basePrice,
            bonusPrice,
            price: basePrice + bonusPrice,
            coins: int64Number(state.coins),
            capacity: int64Number(state.capacity),
            seeds: bag.seeds,
            honey: bag.honey,
            coinsInBag: bag.coins,
            shopAvailable,
            rules: rulesOf(data.entry),
            actions: {
                claim: { enabled: !state.claims?.seed_claimed, available: !state.claims?.seed_claimed },
                share: { enabled: !state.claims?.share_claimed, available: !state.claims?.share_claimed },
                sell: { enabled: bag.honey > 0, available: bag.honey > 0 },
                exchange: { enabled: shopAvailable === true, available: shopAvailable === true },
            },
        };
    }

    async function rpc(action: keyof typeof SWEET_POTATO_COMMANDS, params: any = {}, timeoutMs?: number): Promise<any> {
        const operation = SWEET_POTATO_COMMANDS[action];
        const payload: any = { id: SWEET_POTATO.activityId, cmd: operation.cmd, [operation.field]: params };
        const body = Buffer.from(types.SweetPotatoOperateRequest.encode(types.SweetPotatoOperateRequest.create(payload)).finish());
        const { body: replyBody } = await sendMsgAsync(SERVICE, 'Operate', body, timeoutMs ? { timeoutMs } : undefined);
        const reply = types.SweetPotatoOperateReply.decode(replyBody);
        if (int64String(reply?.id) !== SWEET_POTATO.activityId
            || int64Number(reply?.cmd) !== operation.cmd
            || !reply?.[operation.field]
            || int64String(reply?.activity?.head?.id) !== SWEET_POTATO.activityId
            || !reply?.activity?.state) {
            throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '操作回包未能确认，请刷新活动，勿重复提交');
        }
        return reply;
    }

    function friendsOf(): any[] {
        const list = (deps.getFriends
            ? deps.getFriends()
            : require('../friend').getFriendsList(false, 'normal', true)) || [];
        const unique = new Map<string, any>();
        for (const friend of list) {
            const gid = String(friend?.gid || '');
            if (/^[1-9]\d{0,15}$/.test(gid) && gid !== selfGid()) unique.set(gid, friend);
        }
        return Array.from(unique.values());
    }

    async function queryShop(hostGid: string, friend: any = null): Promise<any> {
        if (!alive()) throw businessError('SWEET_POTATO_INACTIVE', '活动未开放或账号未登录');
        const reply = await rpc('shop', { host_gid: hostGid }, 8000);
        const shop = reply.get_shop?.shop;
        const price = int64Number(shop?.base_price) + int64Number(shop?.bonus_price);
        if (String(shop?.owner?.gid || '') !== hostGid || !price) {
            throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '无法确认选中铺子的主人及收购价，本次未出售');
        }
        return {
            hostGid,
            name: String(friend?.name || shop.owner?.name || '好友铺子'),
            avatarUrl: String(friend?.avatarUrl || shop.owner?.avatar || ''),
            basePrice: int64Number(shop.base_price),
            bonusPrice: int64Number(shop.bonus_price),
            price,
            remaining: int64Number(shop.remaining),
            checkedAt: now() * 1000,
            available: true,
            error: '',
        };
    }

    async function getSweetPotatoActivity(fetchShop: boolean = true): Promise<any> {
        const data = await getGroup();
        let bag = { seeds: 0, honey: 0, coins: 0 };
        try {
            bag = await inventory();
        } catch {
            // 背包读不到不影响活动状态展示，数量按 0 展示并在 actions 上体现为不可卖。
        }
        let shopAvailable: boolean | null = null;
        if (fetchShop && data.active) {
            try {
                const catalog = await queryShopCatalog();
                shopAvailable = !!catalog && catalog.goods.length > 0;
            } catch {
                shopAvailable = false;
            }
        }
        return toDto(data, bag, shopAvailable);
    }

    /** 兑换商店目录（面板专用；不在活动快照里顺带查，避免拖慢每轮快照）。 */
    async function getSweetPotatoShopCatalog(): Promise<any> {
        const catalog = await queryShopCatalog();
        if (!catalog) {
            return { available: false, goods: [], message: '兑换商店暂未开放，或当前版本尚未确认商店协议' };
        }
        return {
            available: catalog.goods.length > 0,
            goods: normalizeCatalog(catalog),
            message: catalog.goods.length > 0 ? '' : '商店目录为空',
        };
    }

    async function getSweetPotatoShops(input: any = {}): Promise<any> {
        const rawOffset = input?.offset ?? 0;
        if (!/^\d+$/.test(String(rawOffset))) {
            throw businessError('INVALID_SWEET_POTATO_PAGE', '好友价格分页参数无效');
        }
        const offset = Number(rawOffset);
        if (!Number.isSafeInteger(offset) || offset < 0) {
            throw businessError('INVALID_SWEET_POTATO_PAGE', '好友价格分页参数无效');
        }
        if (shopsLoading) throw businessError('SWEET_POTATO_SHOPS_BUSY', '正在查询好友价格，请稍后');
        shopsLoading = true;
        try {
            const data = await getGroup();
            if (!data.active) throw businessError('SWEET_POTATO_INACTIVE', '以薯换福活动未开放或已结束');
            const list = friendsOf();
            const page = list.slice(offset, offset + SHOP_PAGE_SIZE);
            const shops: any[] = [];
            for (const friend of page) {
                const hostGid = String(friend.gid);
                const cached = shopCache.get(hostGid);
                try {
                    const shop = cached && now() * 1000 - cached.checkedAt < SHOP_CACHE_TTL_MS
                        ? { ...cached, name: String(friend.name || cached.name) }
                        : await queryShop(hostGid, friend);
                    shopCache.set(hostGid, shop);
                    shops.push(shop);
                } catch {
                    shops.push({
                        hostGid,
                        name: String(friend.name || '好友铺子'),
                        avatarUrl: String(friend.avatarUrl || ''),
                        price: null,
                        remaining: null,
                        checkedAt: now() * 1000,
                        available: false,
                        error: '暂无法读取该铺子，请稍后重试',
                    });
                }
            }
            return {
                shops,
                total: list.length,
                nextOffset: offset + page.length,
                hasMore: offset + page.length < list.length,
            };
        } finally {
            shopsLoading = false;
        }
    }

    /** 兑换商店目录：只读查询，失败按「未开放」处理，不影响主活动。 */
    async function queryShopCatalog(): Promise<any | null> {
        const body = Buffer.from(types.QueryActivityRequest.encode(types.QueryActivityRequest.create({
            activity_id: SWEET_POTATO.shopActivityId,
            operate_type: QUERY_SHOP_OPERATE_TYPE,
        })).finish());
        let reply: any;
        try {
            const { body: replyBody } = await sendMsgAsync(SERVICE, 'Operate', body, { timeoutMs: 8000 });
            reply = types.ActivityOperateReply.decode(replyBody);
        } catch {
            return null;
        }
        const goods = reply?.data?.catalog?.goods;
        if (int64String(reply?.activity_id) !== SWEET_POTATO.shopActivityId || !Array.isArray(goods)) return null;
        return { goods, raw: reply.data };
    }

    function normalizeCatalog(catalog: any): any[] {
        return (catalog?.goods || []).map((entry: any) => ({
            id: int64String(entry?.goods_id),
            itemId: int64String(entry?.item?.id),
            name: String(entry?.item?.name || ''),
            count: int64Number(entry?.item?.count) || 1,
            costItemId: int64String(entry?.cost?.item_id),
            costCount: int64String(entry?.cost?.count),
            limit: int64Number(entry?.limit),
            bought: int64Number(entry?.bought),
            exchangeable: entry?.exchangeable !== false,
        }));
    }

    async function exchangeSweetPotatoGoods(input: any = {}): Promise<any> {
        const goodsId = positiveDecimal(input?.goodsId, 'INVALID_SWEET_POTATO_GOODS', 'goodsId');
        const count = positiveDecimal(input?.count, 'INVALID_SWEET_POTATO_COUNT', 'count');
        return serializeMutation(async () => {
            assertCanOperate('sell', false);
            const catalog = await queryShopCatalog();
            if (!catalog) throw businessError('SWEET_POTATO_SHOP_UNAVAILABLE', '兑换商店暂未开放，或当前版本尚未确认商店协议');
            const goods = normalizeCatalog(catalog).find(entry => entry.id === goodsId);
            if (!goods) throw businessError('SWEET_POTATO_GOODS_NOT_FOUND', '兑换商店中未找到指定商品');
            if (!goods.exchangeable) throw businessError('SWEET_POTATO_GOODS_UNAVAILABLE', '该商品当前不可兑换');
            const body = Buffer.from(types.ExchangeShopRequest.encode(types.ExchangeShopRequest.create({
                activity_id: SWEET_POTATO.shopActivityId,
                operate_type: EXCHANGE_SHOP_OPERATE_TYPE,
                exchange_shop_operate: { goods_id: goodsId, count },
            })).finish());
            const { body: replyBody } = await sendMsgAsync(SERVICE, 'Operate', body, { timeoutMs: 15000 });
            const reply = types.ActivityOperateReply.decode(replyBody);
            if (int64String(reply?.activity_id) !== SWEET_POTATO.shopActivityId
                || int64Number(reply?.operate_type) !== EXCHANGE_SHOP_OPERATE_TYPE) {
                throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '兑换回包未能确认，请刷新商店核对，勿重复提交');
            }
            return {
                message: `已兑换「${goods.name}」×${count}`,
                snapshot: await getActivityCenterSnapshot(),
            };
        });
    }

    async function mutate(action: 'claim' | 'share' | 'sell', input: any = {}, automatic = false, canContinue = () => true): Promise<any> {
        assertCanOperate(action, automatic);
        if ((retryAfter.get(action) || 0) > now()) {
            throw businessError('SWEET_POTATO_COOLDOWN', '上一次操作结果正在核对，请稍后刷新再试');
        }
        if (!canContinue()) throw businessError('SWEET_POTATO_STOPPED', '自动化已停止');
        const current = await getGroup();
        if (!current.active) throw businessError('SWEET_POTATO_INACTIVE', '以薯换福活动未开放或已结束');
        const state = current.entry.state;

        if (action === 'claim') {
            if (state.claims?.seed_claimed) return { changed: false, message: '今日红薯种子已领取' };
            retryAfter.set(action, now() + RETRY_COOLDOWN_SEC);
            const reply = await rpc('claim');
            if (!reply.activity.state.claims?.seed_claimed) {
                throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '领取状态未能确认，请刷新活动');
            }
            retryAfter.delete(action);
            return {
                changed: true,
                message: '每日红薯种子已领取',
                rewards: (reply.claim_seed?.rewards || []).map(itemDto),
            };
        }

        if (action === 'share') {
            if (state.claims?.share_claimed && pendingShareDate !== dayKey()) {
                return { changed: false, message: '今日分享暴击已触发' };
            }
            retryAfter.set(action, now() + RETRY_COOLDOWN_SEC);
            const checkBody = Buffer.from(types.CheckCanShareRequest.encode(types.CheckCanShareRequest.create({})).finish());
            const check = await sendMsgAsync('gamepb.sharepb.ShareService', 'CheckCanShare', checkBody);
            if (!types.CheckCanShareReply.decode(check.body)?.can_share) {
                retryAfter.delete(action);
                throw businessError('SWEET_POTATO_SHARE_UNAVAILABLE', '当前分享入口不可用');
            }
            if (!state.claims?.share_claimed) {
                const reply = await rpc('share');
                if (!reply.activity.state.claims?.share_claimed) {
                    throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '分享前置状态未能确认，请刷新活动');
                }
                pendingShareDate = dayKey();
            }
            const reportBody = Buffer.from(types.ReportShareRequest.encode(types.ReportShareRequest.create({
                field_1: SHARE_REPORT_SOURCE,
                field_4: SHARE_REPORT_SCENE,
            })).finish());
            await sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', reportBody);
            const confirmed = await getGroup();
            if (!confirmed.entry.state.claims?.share_claimed || int64Number(confirmed.entry.state.bonus_price) <= 0) {
                throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '分享后涨价状态未能确认，请刷新活动');
            }
            pendingShareDate = '';
            retryAfter.delete(action);
            return {
                changed: true,
                message: '分享暴击已确认，收购价已上涨',
                bonusPrice: int64Number(confirmed.entry.state.bonus_price),
            };
        }

        // sell
        const self = selfGid();
        const owner = automatic || input?.hostGid === undefined ? self : String(input.hostGid || '');
        if (!/^[1-9]\d{0,15}$/.test(owner)) {
            throw businessError('INVALID_SWEET_POTATO_HOST', '请选择有效的蜜薯铺子');
        }
        let friend: any = null;
        if (owner !== self) {
            friend = friendsOf().find(item => String(item.gid) === owner) || null;
            if (!friend) throw businessError('SWEET_POTATO_NOT_FRIEND', '该铺主不在当前账号的好友列表中，请重新查询');
            if (!Number.isSafeInteger(input?.expectedPrice) || input.expectedPrice <= 0) {
                throw businessError('INVALID_SWEET_POTATO_PRICE', '请先查询并确认好友收购价');
            }
        }
        const bag = await inventory();
        if (!bag.honey) {
            retryAfter.delete(action);
            return { changed: false, message: '当前没有蜜薯可出售' };
        }
        const requested = input?.count === undefined ? bag.honey : input.count;
        if (!Number.isSafeInteger(requested) || requested <= 0 || requested > bag.honey) {
            retryAfter.delete(action);
            throw businessError('INVALID_SWEET_POTATO_COUNT', '出售数量必须为正整数，且不能超过蜜薯库存');
        }
        if (!canContinue()) throw businessError('SWEET_POTATO_STOPPED', '自动化已停止');
        const shop = await queryShop(owner, friend);
        shopCache.set(owner, shop);
        if (input?.expectedPrice !== undefined && input.expectedPrice !== shop.price) {
            throw businessError('SWEET_POTATO_PRICE_CHANGED', `收购价已变为 ${shop.price}，本次未出售，请重新查询并确认`);
        }
        if (requested > shop.remaining) {
            throw businessError('SWEET_POTATO_CAPACITY_EXCEEDED', `该铺子剩余收购量为 ${shop.remaining}，本次未出售`);
        }
        if (!Number.isSafeInteger(requested * shop.price)) {
            throw businessError('INVALID_SWEET_POTATO_COUNT', '出售金额超出支持范围');
        }
        if (!canContinue()) throw businessError('SWEET_POTATO_STOPPED', '自动化已停止');
        retryAfter.set(action, now() + RETRY_COOLDOWN_SEC);
        const reply = await rpc('sell', { host_gid: owner, count: requested });
        const sale = reply.sell;
        if (int64Number(sale?.count) !== requested
            || int64Number(sale?.price) !== shop.price
            || int64Number(sale?.income) !== requested * shop.price) {
            throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '出售回包与数量或价格不一致，请刷新核对');
        }
        retryAfter.delete(action);
        const updatedShop = { ...shop, remaining: int64Number(sale.remaining), checkedAt: now() * 1000 };
        shopCache.set(owner, updatedShop);
        return {
            changed: true,
            message: `已向${owner === self ? '自己的铺子' : shop.name}出售蜜薯 ${requested} 个，获得福气币 ${int64Number(sale.income)}`,
            sold: requested,
            income: int64Number(sale.income),
            shop: updatedShop,
        };
    }

    async function operateSweetPotato(action: string, input: any = {}): Promise<any> {
        if (!['claim', 'share', 'sell', 'exchange'].includes(action)) {
            throw businessError('INVALID_SWEET_POTATO_ACTION', '不支持的以薯换福操作');
        }
        if (action === 'exchange') return exchangeSweetPotatoGoods(input);

        const requestId = action === 'sell' ? input?.requestId : undefined;
        let signature = '';
        if (requestId !== undefined) {
            if (typeof requestId !== 'string' || !/^[\w-]{10,80}$/.test(requestId)) {
                throw businessError('INVALID_SWEET_POTATO_REQUEST', '出售请求标识无效');
            }
            signature = JSON.stringify({
                hostGid: input?.hostGid ?? 'self',
                count: input?.count ?? 'all',
                expectedPrice: input?.expectedPrice ?? null,
            });
            for (const [key, entry] of sales) {
                if (entry.expiresAt <= now()) sales.delete(key);
            }
            const previous = sales.get(requestId);
            if (previous) {
                if (previous.signature !== signature) {
                    throw businessError('INVALID_SWEET_POTATO_REQUEST', '出售请求内容已变化，请重新确认');
                }
                return previous.promise;
            }
            if (sales.size >= 128) throw businessError('SWEET_POTATO_COOLDOWN', '出售请求过于频繁，请稍后重试');
        }
        const pending = serializeMutation(async () => {
            const result = await mutate(action as any, input);
            try {
                return { ...result, activity: await getSweetPotatoActivity() };
            } catch {
                return { ...result, activity: null, refreshRequired: true };
            }
        });
        if (requestId !== undefined) {
            sales.set(requestId, { signature, expiresAt: now() + 600, promise: pending });
        }
        return pending;
    }

    // ---------------- 自动化 ----------------

    async function autoClaim(): Promise<boolean> {
        if (!alive() || !enabled('claim')) return false;
        const data = await getGroup();
        if (!data.active || data.entry.state.claims?.seed_claimed) return false;
        const result = await mutate('claim', {}, true);
        return !!result.changed;
    }

    async function autoShare(): Promise<boolean> {
        if (!alive() || !enabled('share')) return false;
        const data = await getGroup();
        if (!data.active) return false;
        if (data.entry.state.claims?.share_claimed && pendingShareDate !== dayKey()) return false;
        const result = await mutate('share', {}, true);
        return !!result.changed;
    }

    async function autoSell(): Promise<boolean> {
        if (!alive() || !enabled('sell')) return false;
        const data = await getGroup();
        if (!data.active) return false;
        if (int64Number(data.entry.state.bonus_price) <= 0) return false;
        const result = await mutate('sell', {}, true);
        return !!result.changed;
    }

    /** 活动是否开放：60 秒缓存，巡田每轮都问一次也不至于每轮发 GetGroup。 */
    let activeCacheAt = 0;
    let activeCached = false;
    async function isActiveCached(): Promise<boolean> {
        if (now() - activeCacheAt < 60) return activeCached;
        const data = await getGroup().catch(() => null);
        activeCacheAt = now();
        activeCached = !!data?.active;
        return activeCached;
    }

    /** 活动期间的红薯补种：只种空地，不动正在生长的作物。 */
    async function plantEmptyLands(landIds: number[], options: any = {}): Promise<number[]> {
        const canContinue = options.canContinue || (() => true);
        if (!alive() || !enabled('plant') || !canContinue() || !landIds.length) return [];
        if (!await isActiveCached()) return [];
        const bag = await inventory().catch(() => null);
        if (!bag?.seeds) return [];
        const plantSeeds = deps.plantSeeds || require('./farm/planting').plantSeeds;
        const planted: number[] = [];
        const count = Math.min(landIds.length, bag.seeds);
        for (const landId of landIds.slice(0, count)) {
            if (!canContinue()) break;
            const result = await plantSeeds(SWEET_POTATO.seedId, [landId], {
                maxPlantCount: 1,
                propagateErrors: true,
                canContinue,
            });
            if (Array.isArray(result?.plantedLandIds) && result.plantedLandIds.includes(landId)) {
                planted.push(landId);
            } else {
                throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '红薯播种状态未能确认，本轮停止补种');
            }
        }
        return planted;
    }

    /** 一轮作物循环：收成熟红薯 → 铲死苗 → 空地补种。 */
    async function runCropCycle(): Promise<number> {
        if (!alive() || !enabled('plant')) return 0;
        const farm = deps.farm || require('./farm/api');
        const analyzeLands = deps.analyzeLands || require('./farm/land-analysis').analyzeLands;
        let lands = (await farm.getAllLands())?.lands || [];
        const status = analyzeLands(lands);
        const ownEventIds = new Set(lands
            .filter((land: any) => isSweetPotatoPlant(land.plant))
            .map((land: any) => Number(land.id)));
        const mature = status.harvestable.filter((id: number) => ownEventIds.has(id));
        let harvestedCount = 0;
        if (mature.length) {
            const reply = await farm.harvest(mature);
            const confirmed = new Set((reply?.land || []).map((land: any) => Number(land?.id)));
            harvestedCount = mature.filter((id: number) => confirmed.has(id)).length;
            if (!harvestedCount) {
                throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '红薯收获状态未能确认，本轮停止补种');
            }
            lands = (await farm.getAllLands())?.lands || [];
        }
        const latest = analyzeLands(lands);
        const dead = latest.dead.filter((id: number) => lands.some((land: any) => (
            Number(land.id) === id && isSweetPotatoPlant(land.plant)
        )));
        if (dead.length) {
            await farm.removePlant(dead);
            lands = (await farm.getAllLands())?.lands || [];
        }
        const empty = analyzeLands(lands).empty.filter((id: number) => lands.some((land: any) => (
            Number(land.id) === id && (!land.plant || !Number(land.plant.id))
        )));
        const planted = await plantEmptyLands(empty);
        return harvestedCount + planted.length;
    }

    return {
        getSweetPotatoActivity,
        getSweetPotatoShopCatalog,
        getSweetPotatoShops,
        operateSweetPotato,
        exchangeSweetPotatoGoods,
        autoClaim,
        autoShare,
        autoSell,
        plantEmptyLands,
        runCropCycle,
        isSweetPotatoActive: async (): Promise<boolean> => {
            if (!alive()) return false;
            return isActiveCached();
        },
    };
}

module.exports = { createSweetPotatoService };
