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
    SWEET_POTATO_CATALOG_TEMPLATE,
    SWEET_POTATO_SHOP_DAILY_QUOTA,
    sweetPotatoEnabled,
    isSweetPotatoPlant,
} = require('../../config/sweet-potato');

const SERVICE = 'gamepb.activitypb.ActivityService';
const RETRY_COOLDOWN_SEC = 300;
const SHOP_CACHE_TTL_MS = 30000;
const SHOP_PAGE_SIZE = 5;
const SHARE_REPORT_SOURCE = 28;
const SHARE_REPORT_SCENE = 2017;
/** 收购记录只展示最近这么多条（界面「最近 30 条」）。 */
const RECORD_LIST_LIMIT = 30;
/** 比价扫描的铺子数硬上限，防止好友特别多时一轮发出上百个 cmd 92。 */
const SCAN_MAX_LIMIT = 100;
/** 比价时的并发数：4 个一批，和界面一次查一页的感觉接近。 */
const SCAN_CONCURRENCY = 4;
/** 面板比价结果的短缓存：cmd 92 是实时行情，这层只为防连点刷屏，force 可跳过。 */
const FRIEND_SCAN_TTL_MS = 3 * 60 * 1000;
/** 背包余额的内存有效期：超过这个时间但还没刷新时，快照会顺手在后台补一次。 */
const BALANCE_CACHE_TTL_MS = 10 * 1000;
/**
 * 背包连续读取失败时，最多沿用多久之前的成功值。
 * 余额变化只发生在本次进程内的几个写操作上（写操作后都会强制刷新缓存），
 * 所以 10 分钟内的旧值仍然可信，比把界面刷成「--」更有用。
 */
const BALANCE_STALE_MAX_MS = 10 * 60 * 1000;
/** 单轮自动卖薯最多切换几家铺子：每卖一家都是一次 cmd 93 写，铺子越多越像脚本。 */
const SELL_MAX_SHOPS_PER_RUN = 3;
/** 相邻两笔出售之间的间隔，避免连着发写请求。 */
const SELL_STEP_SPACER_MS = 1200;
/**
 * 这些错误说明「这家现在卖不进去」，换下一家即可，不算整轮失败。
 * 反过来，回包对不上（RESULT_UNKNOWN）必须停手，绝不能重试猜结果。
 */
const SELL_SKIP_CODES = new Set([
    'SWEET_POTATO_CAPACITY_EXCEEDED',
    'SWEET_POTATO_SHOP_CLOSED',
    'SWEET_POTATO_PRICE_CHANGED',
    'SWEET_POTATO_NOT_FRIEND',
]);

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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
    /**
     * 本地分享记账（服务器日期键）。`claims.share_claimed` 是权威判据，这一份只是兜底：
     * 万一服务端没把标记带回来，靠它也能保证同一天不再发第二次 cmd 98。
     */
    let pendingShareDate = '';
    /** 好友铺子价格缓存：30 秒内不重复查同一家。 */
    const shopCache = new Map<string, any>();
    let shopsLoading = false;
    /** 出售幂等：同一次确认重复提交复用同一个 Promise。 */
    const sales = new Map<string, { signature: string; expiresAt: number; promise: Promise<any> }>();
    /** 比价结果缓存：自动卖薯按配置间隔复用同一份排序，不用每轮把好友扫一遍。 */
    let scanCache: { at: number; limit: number; shops: any[] } | null = null;
    /** 面板比价缓存（3 分钟，force 跳过）；和自动卖薯那份分开，免得互相顶掉节奏。 */
    let panelScanCache: { at: number; limit: number; data: any } | null = null;
    /** 自动化相邻两笔出售的间隔；测试注入 0 免得白等。 */
    const stepSpacerMs = Number.isFinite(Number(deps.stepSpacerMs)) ? Math.max(0, Number(deps.stepSpacerMs)) : SELL_STEP_SPACER_MS;

    const now = (): number => Number(getServerTimeSec()) || Math.floor(Date.now() / 1000);
    const dayKey = (): string => new Date((now() + 8 * 3600) * 1000).toISOString().slice(0, 10);
    // 以下四项允许测试注入；生产环境走懒加载，避免 activity-center 与农场/好友模块互相顶层依赖。
    const automation = (): any => (deps.getAutomation
        ? deps.getAutomation()
        : require('../../models/store').getAutomation());
    const enabled = (part: string | null = null): boolean => sweetPotatoEnabled(automation(), part as any);
    /** 自动卖薯的四个可调参数：越界值一律夹到安全区间，不信任前端写入的脏数据。 */
    function sellConfig(): { friendLimit: number; scanIntervalMinutes: number; minCount: number; fallbackOwn: boolean } {
        const raw = automation() || {};
        const int = (key: string, fallback: number, min: number, max: number): number => {
            const parsed = Number.parseInt(String(raw[key]), 10);
            return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
        };
        return {
            friendLimit: int('sweet_potato_scan_friend_limit', 20, 1, SCAN_MAX_LIMIT),
            scanIntervalMinutes: int('sweet_potato_scan_interval_minutes', 30, 5, 720),
            minCount: int('sweet_potato_sell_min_count', 1, 1, 9999),
            fallbackOwn: raw.sweet_potato_sell_fallback_own !== false,
        };
    }
    const selfGid = (): string => {
        const state = deps.getUserState ? deps.getUserState() : require('../../utils/network').getUserState();
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

    /** 背包余额：以物品 ID 为键的数量表。 */
    type Balances = Map<string, number>;

    /** 只取活动关心的三件道具，其余背包内容不参与活动快照。 */
    function readBalances(bag: any): Balances {
        const items = getBagItems(bag) || [];
        const map: Balances = new Map();
        for (const id of [SWEET_POTATO.seedId, SWEET_POTATO.honeyId, SWEET_POTATO.coinId]) {
            map.set(String(id), 0);
        }
        for (const item of items) {
            const key = String(item?.id ?? '');
            if (!map.has(key)) continue;
            map.set(key, (map.get(key) || 0) + (Number(item?.count) || 0));
        }
        return map;
    }

    /**
     * 一次性读背包（自动化判断"还有没有蜜薯/种子"用）。
     * 活动快照**不走这条**，见下面的 refreshBalances / currentBalances。
     */
    async function inventory(): Promise<{ seeds: number; honey: number; coins: number }> {
        const map = readBalances(await getBag());
        return {
            seeds: map.get(String(SWEET_POTATO.seedId)) || 0,
            honey: map.get(String(SWEET_POTATO.honeyId)) || 0,
            coins: map.get(String(SWEET_POTATO.coinId)) || 0,
        };
    }

    /**
     * 余额读取改成「快照永不等待 + 后台单飞刷新」两条通道。
     *
     * 背景：Bag 排在活动请求队列的末尾，网关并发一满就被挤掉。之前快照里同步读背包，
     * 一次抖动既拖慢快照又只能拿到 0；更糟的是页面挂载和轮询会并发打两个快照，
     * 后一个失败就覆盖前一个的成功结果，表现就是「刚刷新有数字、几秒后整排变 0」。
     *
     * 现在只有 refreshBalances 一个通道打网关（同一时刻只有一个在途），结果写进内存；
     * 快照只同步读内存，并发快照读的是同一份状态，不可能互相覆盖。
     */
    let lastGoodBalances: { at: number; data: Balances } | null = null;
    /** 本次数字是上一次成功值（不是刚读到的真值）。 */
    let balanceStale = false;
    /** 最近一次读取失败的原因，随快照下发给前端显示。 */
    let lastBalanceError = '';
    let balanceRefreshing: Promise<Balances | null> | null = null;
    let lastBalanceLogAt = 0;
    let lastBalanceLoggedError = '';

    /** 同一类失败 5 分钟只记一条，避免把日志刷爆后反而看不到别的信息。 */
    function logBalanceFailure(): void {
        try {
            const at = Date.now();
            if (lastBalanceLoggedError !== lastBalanceError || at - lastBalanceLogAt > 5 * 60 * 1000) {
                lastBalanceLoggedError = lastBalanceError;
                lastBalanceLogAt = at;
                require('../../utils/utils').logWarn('以薯换福背包读取失败', { error: lastBalanceError });
            }
        } catch {
            // 日志失败不影响主流程
        }
    }

    /** 最近一次成功值还能不能用（10 分钟内的旧值仍然比「--」有用）。 */
    function freshFallback(): boolean {
        return !!lastGoodBalances && Date.now() - lastGoodBalances.at <= BALANCE_STALE_MAX_MS;
    }

    async function refreshBalances(options: { retries?: number } = {}): Promise<Balances | null> {
        if (balanceRefreshing) return balanceRefreshing;
        const retryDelays = options.retries === 0 ? [] : [250, 700];
        const task = (async (): Promise<Balances | null> => {
            for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
                try {
                    // 一律走普通 getBag()：它会复用在途请求；传 fresh 会绕过在途去重，
                    // 等于连甩三个 Bag 请求，反而更容易撞上网关超时。
                    const data = readBalances(await getBag());
                    lastBalanceError = '';
                    balanceStale = false;
                    lastGoodBalances = { at: Date.now(), data };
                    return data;
                } catch (error: any) {
                    lastBalanceError = String(error?.message || error || '背包读取失败');
                    if (attempt < retryDelays.length) await sleep(retryDelays[attempt]);
                }
            }
            logBalanceFailure();
            if (freshFallback()) {
                balanceStale = true;
                return (lastGoodBalances as { data: Balances }).data;
            }
            balanceStale = false;
            return null;
        })();
        balanceRefreshing = task;
        try {
            return await task;
        } finally {
            if (balanceRefreshing === task) balanceRefreshing = null;
        }
    }

    /** 快照专用：同步返回内存里的余额，绝不 await 网关。 */
    function currentBalances(): Balances | null {
        if (freshFallback()) {
            const snapshot = lastGoodBalances as { at: number; data: Balances };
            // 手里有值就先给出去；超过内存有效期顺手在后台补一次，不阻塞本次快照。
            if (Date.now() - snapshot.at > BALANCE_CACHE_TTL_MS) void refreshBalances();
            return snapshot.data;
        }
        // 还没有任何成功值：触发后台刷新，本次先按未知下发。
        void refreshBalances();
        return null;
    }

    /** 写操作成功后余额一定变了，立刻在后台补一次真值。 */
    function invalidateBalanceCache(): void {
        void refreshBalances();
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

    function toDto(data: any, balances: Balances | null, catalogAvailable: boolean | null = null): any {
        const state = data.entry.state || {};
        const basePrice = int64Number(state.base_price);
        const bonusPrice = int64Number(state.bonus_price);
        const pendingCommission = int64Number(state.pending_commission);
        const balancesKnown = balances !== null;
        const read = (id: number): number => (balances ? balances.get(String(id)) || 0 : 0);
        const seeds = read(SWEET_POTATO.seedId);
        const honey = read(SWEET_POTATO.honeyId);
        const coinsInBag = read(SWEET_POTATO.coinId);
        // 余额未知时不能把「卖不了」当成事实：蜜薯可能就在背包里，只是这次没读到。
        const canSell = !balancesKnown || honey > 0;
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
            // 基础价为 0 说明服务端还没下发当日行情，此时不能按 0 价卖。
            priceKnown: basePrice > 0,
            coins: int64Number(state.coins),
            capacity: int64Number(state.capacity),
            pendingCommission,
            commissionClaimable: !!data.active && pendingCommission > 0,
            seeds,
            honey,
            coinsInBag,
            // 三个数量是「读到 0」还是「没读到」，前端靠这两个字段区分 0 与 --。
            balancesKnown,
            balanceStale: balancesKnown && balanceStale,
            balanceError: balancesKnown ? '' : (lastBalanceError || '背包读取失败'),
            shopAvailable: catalogAvailable,
            catalogAvailable,
            rules: rulesOf(data.entry),
            actions: {
                claim: { enabled: !state.claims?.seed_claimed, available: !state.claims?.seed_claimed },
                share: { enabled: !state.claims?.share_claimed, available: !state.claims?.share_claimed },
                sell: { enabled: canSell && basePrice > 0, available: canSell && basePrice > 0 },
                // 兑换只看活动期：目录要现查，不能因为快照没带目录就把按钮打回不可点。
                exchange: { enabled: !!data.active, available: !!data.active, catalogAvailable },
                commission: { enabled: pendingCommission > 0, available: pendingCommission > 0 },
            },
        };
    }

    /**
     * 发一次 Operate 并核对回包骨架。
     *
     * 写操作（claim/share/sell/exchange/commission）必须同时带回
     * `activity.head.id` 与 `activity.state`，否则按「结果不明」处理；
     * 只读的 cmd 97（兑换目录）在活动未进期时可能不带状态，允许放宽。
     */
    async function rpc(
        action: keyof typeof SWEET_POTATO_COMMANDS,
        params: any = {},
        timeoutMs?: number,
        options: { requireState?: boolean } = {},
    ): Promise<any> {
        const operation = SWEET_POTATO_COMMANDS[action];
        const requireState = options.requireState !== false;
        const payload: any = { id: SWEET_POTATO.activityId, cmd: operation.cmd, [operation.field]: params };
        const body = Buffer.from(types.SweetPotatoOperateRequest.encode(types.SweetPotatoOperateRequest.create(payload)).finish());
        const { body: replyBody } = await sendMsgAsync(SERVICE, 'Operate', body, timeoutMs ? { timeoutMs } : undefined);
        const reply = types.SweetPotatoOperateReply.decode(replyBody);
        const stateOk = !requireState
            || (int64String(reply?.activity?.head?.id) === SWEET_POTATO.activityId && !!reply?.activity?.state);
        if (int64String(reply?.id) !== SWEET_POTATO.activityId
            || int64Number(reply?.cmd) !== operation.cmd
            || !reply?.[operation.field]
            || !stateOk) {
            throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '操作回包未能确认，请刷新活动，勿重复提交');
        }
        return reply;
    }

    /**
     * 好友列表。`getFriendsList` 是 async（要打网关取好友），必须 await；
     * 之前把它当成同步函数直接 `for...of`，遍历 Promise 会抛「list is not iterable」，
     * 让整个比价/出售链路在生产环境不可用（测试里注入的是同步 getFriends，所以没拦住）。
     */
    async function friendsOf(): Promise<any[]> {
        const list = (deps.getFriends
            ? await deps.getFriends()
            : await require('../friend').getFriendsList(false, 'normal', true)) || [];
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
        // can_sell 三态：true 可收 / false 明确拒收 / 字段缺失按可卖处理。
        // protobufjs 的 decode 不会给缺失字段补默认值，所以用 hasOwnProperty 区分「明确 false」与「没下发」。
        const canSellKnown = Object.prototype.hasOwnProperty.call(reply.get_shop, 'can_sell');
        const canSell = canSellKnown ? !!reply.get_shop.can_sell : null;
        const unlimited = hostGid === selfGid();
        return {
            hostGid,
            name: unlimited ? '自己的铺子' : String(friend?.name || shop.owner?.name || '好友铺子'),
            avatarUrl: String(friend?.avatarUrl || shop.owner?.avatar || ''),
            basePrice: int64Number(shop.base_price),
            bonusPrice: int64Number(shop.bonus_price),
            price,
            // 服务端下发的原始剩余额度：自家铺子也带上，界面上单独显示「今日还可收」。
            quota: int64Number(shop.remaining),
            // 自家铺子不占好友额度，remaining 对它是「不限」，不能用 0 去拦。
            remaining: unlimited ? null : int64Number(shop.remaining),
            unlimited,
            canSell,
            dailyQuota: SWEET_POTATO_SHOP_DAILY_QUOTA,
            checkedAt: now() * 1000,
            available: canSell !== false,
            error: canSell === false ? '该铺子当前不收蜜薯' : '',
        };
    }

    /**
     * 刷新本人铺子的今日行情（cmd 92，host_gid 传自己）。
     *
     * 状态槽 130.5/130.6 只给基础价与暴击，剩余接收额度必须现查；没有这个入口时
     * 面板「今日还可收」只能等下一次任意操作触发。查询是只读的，不发写请求。
     */
    async function refreshSweetPotatoQuote(): Promise<any> {
        assertCanOperate(null, false);
        const self = selfGid();
        if (!self) throw businessError('SWEET_POTATO_INACTIVE', '获取不到本人 GID，暂时刷新不了行情');
        const reply = await rpc('shop', { host_gid: self }, 8000);
        const raw = reply.get_shop?.shop;
        const basePrice = int64Number(raw?.base_price);
        const bonusPrice = int64Number(raw?.bonus_price);
        const canSellKnown = Object.prototype.hasOwnProperty.call(reply.get_shop, 'can_sell');
        const canSell = canSellKnown ? !!reply.get_shop.can_sell : null;
        const shop = {
            hostGid: self,
            name: '自己的铺子',
            avatarUrl: String(raw?.owner?.avatar || ''),
            basePrice,
            bonusPrice,
            price: basePrice + bonusPrice,
            quota: int64Number(raw?.remaining),
            remaining: null,
            unlimited: true,
            canSell,
            dailyQuota: SWEET_POTATO_SHOP_DAILY_QUOTA,
            checkedAt: now() * 1000,
            // 基础价为 0 说明服务端还没生成当日行情，这时候卖会按 0 价结算。
            priceKnown: basePrice > 0,
            available: basePrice > 0 && canSell !== false,
            error: canSell === false ? '该铺子当前不收蜜薯' : '',
        };
        shopCache.set(self, shop);
        // 行情变了，两份比价缓存（面板 3 分钟 / 自动卖薯按间隔）都必须作废。
        panelScanCache = null;
        scanCache = null;
        return {
            shop,
            price: shop.price,
            basePrice,
            bonusPrice,
            priceKnown: shop.priceKnown,
            canSell,
            quota: shop.quota,
            message: shop.priceKnown
                ? `今日收购价 ${shop.price}（基础 ${basePrice} + 暴击 ${bonusPrice}），今日还可收 ${shop.quota}`
                : '今日收购价尚未生成，请先领取红薯种子',
        };
    }

    /**
     * 活动快照。余额只读内存，不再 await 背包，所以面板轮询不会被 Bag 拖住。
     *
     * `fetchShop` 会给快照顺带查一次兑换目录（多一条网关请求），默认关闭：
     * 目录是独立接口，面板自己按需拉，不该压在每次轮询上。
     * `freshBalances` 用在写操作之后——那时候余额一定变了，必须等一次真值。
     */
    async function getSweetPotatoActivity(fetchShop: boolean = false, options: { freshBalances?: boolean } = {}): Promise<any> {
        const data = await getGroup();
        // 写操作后、以及进程里还没有任何成功值时，同步单次读一次（不重试）；
        // 其余情况只读内存，快照不会被 Bag 拖住，也不会出现并发快照互相覆盖。
        const balances = options.freshBalances || !freshFallback()
            ? await refreshBalances({ retries: 0 })
            : currentBalances();
        let shopAvailable: boolean | null = null;
        if (fetchShop && data.active) {
            try {
                const catalog = await queryCatalog();
                shopAvailable = !!catalog && catalog.goods.length > 0;
            } catch {
                shopAvailable = false;
            }
        }
        return toDto(data, balances, shopAvailable);
    }

    /** 兑换商店目录（面板专用；不在活动快照里顺带查，避免拖慢每轮快照）。 */
    async function getSweetPotatoShopCatalog(): Promise<any> {
        const catalog = await queryCatalog();
        if (!catalog) {
            return { available: false, goods: [], message: '兑换目录暂不可用，请稍后重试' };
        }
        const goods = normalizeCatalog(catalog);
        return {
            available: goods.length > 0,
            goods,
            coins: int64String(catalog.catalog?.coins || '0'),
            message: goods.length > 0 ? '' : '本期兑换目录为空',
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
            const list = await friendsOf();
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
                        unlimited: false,
                        canSell: null,
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

    /**
     * 好友铺子比价（cmd 92 × N，只读）。按成交价降序，同价按剩余额度降序，
     * 自家铺子永远排在最后——它是兜底，不是最优价。
     *
     * 只读不代表免费：N 个铺子就是 N 次请求，所以面板上限 100、自动卖薯按配置节流。
     */
    async function scanNow(limit: number): Promise<any> {
        assertCanOperate(null, false);
        const data = await getGroup();
        if (!data.active) throw businessError('SWEET_POTATO_INACTIVE', '以薯换福活动未开放或已结束');
        if (shopsLoading) throw businessError('SWEET_POTATO_SHOPS_BUSY', '正在查询好友价格，请稍后');
        shopsLoading = true;
        try {
            const self = selfGid();
            // 自家铺子先入列再截断：limit 很小时也要保证「卖自己」这条路还在。
            const targets: any[] = [{ gid: self, own: true, name: '自己的铺子', avatarUrl: '' }];
            for (const friend of await friendsOf()) {
                if (targets.length >= limit) break;
                const gid = String(friend.gid);
                if (gid === self) continue;
                targets.push({
                    gid,
                    own: false,
                    name: String(friend.name || '好友铺子'),
                    avatarUrl: String(friend.avatarUrl || ''),
                });
            }
            const shops: any[] = [];
            let failed = 0;
            let failureMessage = '';
            for (let start = 0; start < targets.length; start += SCAN_CONCURRENCY) {
                const batch = targets.slice(start, start + SCAN_CONCURRENCY);
                const settled = await Promise.allSettled(batch.map(entry => queryShop(entry.gid, entry)));
                settled.forEach((result: any, index: number) => {
                    const entry = batch[index];
                    if (result.status === 'rejected') {
                        failed += 1;
                        if (!failureMessage) failureMessage = String(result.reason?.message || '铺子行情查询失败');
                        shops.push({
                            hostGid: entry.gid,
                            name: entry.name,
                            avatarUrl: entry.avatarUrl,
                            price: null,
                            remaining: null,
                            unlimited: entry.own,
                            canSell: null,
                            checkedAt: now() * 1000,
                            available: false,
                            error: '暂无法读取该铺子',
                        });
                        return;
                    }
                    shopCache.set(entry.gid, result.value);
                    shops.push(result.value);
                });
            }
            const rank = (shop: any): number => (shop.unlimited ? -1 : Number(shop.remaining ?? 0));
            shops.sort((left: any, right: any) => {
                const priceDiff = Number(right.price ?? -1) - Number(left.price ?? -1);
                if (priceDiff !== 0) return priceDiff;
                return rank(right) - rank(left);
            });
            const best = shops.find((shop: any) => shop.available && !shop.unlimited) || null;
            const ownShop = shops.find((shop: any) => shop.unlimited) || null;
            return {
                shops,
                best,
                ownShop,
                scanned: targets.length,
                failed,
                friendCount: Math.max(0, targets.length - 1),
                cached: false,
                scannedAt: Date.now(),
                message: shops.some((shop: any) => shop.available)
                    ? `已比价 ${shops.length} 个铺子，最高收购价 ${Number(best?.price ?? ownShop?.price ?? 0)}`
                    : (failureMessage || '没有可查询的铺子'),
            };
        } finally {
            shopsLoading = false;
        }
    }

    /**
     * 面板比价：3 分钟内复用上一次结果，`force` 跳过缓存。
     * cmd 92 是实时行情，这层缓存只为防连点刷屏，不改变「比价要新鲜」的语义。
     */
    async function scanShops(input: any = {}): Promise<any> {
        const config = sellConfig();
        const rawLimit = Number(input?.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.floor(rawLimit), SCAN_MAX_LIMIT)
            : config.friendLimit;
        const force = input?.force === true || String(input?.force) === '1';
        const at = Date.now();
        if (!force && panelScanCache && panelScanCache.limit === limit && at - panelScanCache.at < FRIEND_SCAN_TTL_MS) {
            return { ...panelScanCache.data, cached: true };
        }
        const result = await scanNow(limit);
        panelScanCache = { at, limit, data: result };
        return result;
    }

    /** 自动卖薯用的比价：按「上限 + 配置间隔」复用上一轮排序，间隔内不再打网关。 */
    async function rankedShops(limit: number, intervalMinutes: number): Promise<any[]> {
        const at = Date.now();
        if (scanCache && scanCache.limit === limit && at - scanCache.at < intervalMinutes * 60000) {
            return scanCache.shops;
        }
        const result = await scanNow(limit);
        scanCache = { at, limit, shops: result.shops };
        return result.shops;
    }

    function recordDto(record: any): any {
        return {
            timestamp: int64Number(record?.timestamp) * 1000,
            gid: int64String(record?.gid),
            name: String(record?.name || ''),
            avatarUrl: String(record?.avatar || ''),
            level: int64Number(record?.level),
            count: int64Number(record?.count),
            total: int64Number(record?.total),
            commission: int64Number(record?.commission),
        };
    }

    /**
     * 收购记录（cmd 95，只读）：好友把蜜薯卖进你的铺子，字段 4 是付给卖家的总额，字段 9 是你的提成。
     *
     * 没有记录时服务端可能只回一个空包，所以不套 rpc() 的「必须带 activity.state」校验，
     * 改成「空包，或 ID / 命令号匹配」都接受，其余按结果不明处理。
     */
    async function getSweetPotatoRecords(): Promise<any> {
        assertCanOperate(null, false);
        const operation = SWEET_POTATO_COMMANDS.records;
        const body = Buffer.from(types.SweetPotatoOperateRequest.encode(types.SweetPotatoOperateRequest.create({
            id: SWEET_POTATO.activityId,
            cmd: operation.cmd,
            [operation.field]: {},
        })).finish());
        const { body: replyBody } = await sendMsgAsync(SERVICE, 'Operate', body, { timeoutMs: 8000 });
        const reply = types.SweetPotatoOperateReply.decode(replyBody);
        const confirmed = int64String(reply?.id) === SWEET_POTATO.activityId
            || int64Number(reply?.cmd) === operation.cmd;
        if (replyBody.length > 0 && !confirmed) {
            throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '收购记录回包未能确认，请稍后重试');
        }
        const records = (Array.isArray(reply?.records?.records) ? reply.records.records : [])
            .map(recordDto)
            .sort((left: any, right: any) => right.timestamp - left.timestamp)
            .slice(0, RECORD_LIST_LIMIT);
        const totalCommission = records.reduce((sum: number, entry: any) => sum + entry.commission, 0);
        const totalIncome = records.reduce((sum: number, entry: any) => sum + entry.total, 0);
        return {
            records,
            count: records.length,
            totalCommission,
            totalIncome,
            message: records.length
                ? `最近 ${records.length} 条收购记录，合计提成 ${totalCommission} 福气币`
                : '暂无收购记录',
        };
    }

    /**
     * 兑换目录（cmd 97，只读）。
     *
     * 早期按「通用兑换商店」用 QueryActivityRequest 打 2026111709，回包永远是空目录：
     * 实机抓包里副模块 2026111709 的 field 117 始终为空，真正的目录挂在主活动上。
     * 活动未进期时服务端可能不带状态，所以这里放宽 rpc 的状态校验。
     */
    async function queryCatalog(): Promise<any | null> {
        try {
            const reply = await rpc('catalog', {}, 8000, { requireState: false });
            return { goods: Array.isArray(reply?.catalog?.goods) ? reply.catalog.goods : [], catalog: reply.catalog };
        } catch {
            return null;
        }
    }

    /** 目录归一化：协议只给序号/价格/状态/限购，名称与 item_id 走静态模板对上价格才认。 */
    function normalizeCatalog(catalog: any): any[] {
        return (catalog?.goods || []).map((entry: any) => {
            const index = int64Number(entry?.index);
            const price = int64String(entry?.price);
            const template = SWEET_POTATO_CATALOG_TEMPLATE[index];
            const nameKnown = !!template && template.price === price;
            const itemId = nameKnown ? template.itemId : '';
            const limit = int64Number(entry?.limit);
            const exchangedToday = int64Number(entry?.field_5);
            return {
                index,
                itemId,
                // 静态表按「序号 + 价格」双重匹配才算命中；价格变了说明官方调过档位，
                // 此时宁可不显示名字，也不能把错商品的名字挂上去。
                itemIdMatched: !!itemId,
                name: nameKnown ? template.name : `第 ${index} 档`,
                nameKnown,
                price,
                status: int64Number(entry?.status),
                limit,
                exchangedToday,
                image: itemId ? String(itemDto({ item_id: itemId, count: 1 })?.image || '') : '',
                // 服务端不再下发 exchangeable，能否兑换由价格、限购与余额决定，最终以下单回包为准。
                exchangeable: price !== '0',
            };
        });
    }

    /** 兑换下单（cmd 96）。index 是目录序号，count 是数量。 */
    async function exchangeSweetPotatoGoods(input: any = {}): Promise<any> {
        return serializeMutation(async () => {
            assertCanOperate(null, false);
            const index = positiveDecimal(input?.index ?? input?.goodsId, 'INVALID_SWEET_POTATO_INDEX', 'index');
            const count = positiveDecimal(input?.count ?? 1, 'INVALID_SWEET_POTATO_COUNT', 'count');
            const data = await getGroup();
            if (!data.active) throw businessError('SWEET_POTATO_INACTIVE', '以薯换福活动未开放或已结束');
            const catalog = await getSweetPotatoShopCatalog();
            const goods = catalog.goods.find((entry: any) => String(entry.index) === index);
            if (!goods) throw businessError('SWEET_POTATO_GOODS_NOT_FOUND', '兑换目录里没有这一档商品');
            if (!goods.exchangeable) throw businessError('SWEET_POTATO_GOODS_UNAVAILABLE', '该档商品当前不可兑换');
            const cost = BigInt(goods.price) * BigInt(count);
            if (goods.limit > 0 && BigInt(count) > BigInt(goods.limit)) {
                throw businessError('SWEET_POTATO_EXCEED_LIMIT', `该档剩余可兑换 ${goods.limit} 次，本次选择了 ${count} 次`);
            }
            const before = BigInt(int64String(data.entry.state?.coins || '0'));
            if (before > 0n && before < cost) {
                throw businessError('SWEET_POTATO_INSUFFICIENT_COINS', `福气币不足，需要 ${cost}，当前 ${before}`);
            }
            const reply = await rpc('exchange', { index, count }, 15000);
            const result = reply.exchange;
            if (int64String(result?.price) !== goods.price) {
                throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '兑换回包单价与目录不一致，请刷新目录核对');
            }
            if (result?.grant && int64String(result.grant.count) !== count) {
                throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '兑换回包数量与请求不一致，请刷新核对');
            }
            // 兑换会扣福气币、进道具，背包必须重读。
            invalidateBalanceCache();
            return {
                changed: true,
                index: Number(index),
                count: int64String(result?.grant?.count ?? count),
                itemId: int64String(result?.grant?.item_id ?? goods.itemId),
                price: goods.price,
                cost: cost.toString(),
                coins: int64String(result?.coins ?? ''),
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
            invalidateBalanceCache();
            return {
                changed: true,
                message: '每日红薯种子已领取',
                rewards: (reply.claim_seed?.rewards || []).map(itemDto),
            };
        }

        if (action === 'share') {
            // 服务端标记优先，本地记账兜底。两者都成立才算「今天已经分享过」，
            // 否则一旦上报那一步出过岔子，冷却结束后会再发一次 cmd 98（写请求不能重发）。
            if (state.claims?.share_claimed || pendingShareDate === dayKey()) {
                return { changed: false, message: '今日分享暴击已触发' };
            }
            retryAfter.set(action, now() + RETRY_COOLDOWN_SEC);
            // cmd 98 是活动内的分享动作；暴击加成还要靠 ShareService.ReportShare 才真正落地。
            // 顺序与官方客户端一致：先发 cmd 98，再 CheckCanShare → ReportShare。
            // 上报失败不能把已经发生的分享打成失败，所以单独 try，把结果透给前端。
            const reply = await rpc('share');
            pendingShareDate = dayKey();
            let shareReported = false;
            let shareReportError = '';
            try {
                const checkBody = Buffer.from(types.CheckCanShareRequest.encode(types.CheckCanShareRequest.create({})).finish());
                const check = await sendMsgAsync('gamepb.sharepb.ShareService', 'CheckCanShare', checkBody);
                if (types.CheckCanShareReply.decode(check.body)?.can_share) {
                    const reportBody = Buffer.from(types.ReportShareRequest.encode(types.ReportShareRequest.create({
                        field_1: SHARE_REPORT_SOURCE,
                        field_4: SHARE_REPORT_SCENE,
                    })).finish());
                    await sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', reportBody);
                    shareReported = true;
                } else {
                    shareReportError = '当前分享入口不可用（CheckCanShare=false）';
                }
            } catch (error: any) {
                shareReportError = String(error?.message || error || '分享上报失败');
            }
            if (!shareReported) {
                try {
                    require('../../utils/utils').logWarn('以薯换福分享上报失败', { error: shareReportError });
                } catch {
                    // 日志失败不影响主流程
                }
            }
            const confirmed = await getGroup();
            if (!confirmed.entry.state.claims?.share_claimed) {
                throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '分享状态未能确认，请刷新活动');
            }
            // 记账保留到当天结束：即使后面这段抛错，今天也不会再发一次 cmd 98。
            retryAfter.delete(action);
            invalidateBalanceCache();
            const bonusPrice = int64Number(confirmed.entry.state.bonus_price);
            const share = reply.share;
            const grantCount = int64Number(share?.grant?.count);
            const shareKey = String(share?.shop?.share_key || '');
            return {
                changed: true,
                message: bonusPrice > 0
                    ? '分享暴击已确认，收购价已上涨'
                    : (shareReportError ? `铺子已分享，但分享上报未确认：${shareReportError}` : '铺子已分享'),
                bonusPrice,
                // 分享上报（ReportShare）才是暴击真正落地的那一步，成功与否都要让用户看到。
                shareReported,
                shareReportError,
                shareKey,
                seedReward: grantCount > 0
                    ? { itemId: int64String(share.grant.item_id), count: grantCount }
                    : null,
            };
        }

        // sell
        const self = selfGid();
        // 自动卖薯也会指定好友铺子，所以不能因为 automatic 就强制写成自己。
        const owner = input?.hostGid === undefined ? self : String(input.hostGid || '');
        if (!/^[1-9]\d{0,15}$/.test(owner)) {
            throw businessError('INVALID_SWEET_POTATO_HOST', '请选择有效的蜜薯铺子');
        }
        let friend: any = null;
        if (owner !== self) {
            friend = (await friendsOf()).find(item => String(item.gid) === owner) || null;
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
        if (shop.canSell === false) {
            throw businessError('SWEET_POTATO_SHOP_CLOSED', '该铺子当前不收蜜薯，请换一家');
        }
        if (input?.expectedPrice !== undefined && input.expectedPrice !== shop.price) {
            throw businessError('SWEET_POTATO_PRICE_CHANGED', `收购价已变为 ${shop.price}，本次未出售，请重新查询并确认`);
        }
        // 自家铺子不占好友额度（remaining 为 null），只有好友铺子才按剩余量拦。
        if (!shop.unlimited && shop.remaining !== null && requested > shop.remaining) {
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
        // 卖出会改变目标铺子的剩余额度与自己背包的蜜薯数，两份比价缓存都要作废。
        panelScanCache = null;
        scanCache = null;
        invalidateBalanceCache();
        // 回包的 field 4 是该铺每日「上限」（实机 8000），不是剩余量；剩余量只能自己按成交数递减。
        const updatedShop = {
            ...shop,
            remaining: shop.unlimited ? null : Math.max(0, (shop.remaining || 0) - requested),
            checkedAt: now() * 1000,
        };
        shopCache.set(owner, updatedShop);
        return {
            changed: true,
            message: `已向${owner === self ? '自己的铺子' : shop.name}出售蜜薯 ${requested} 个，获得福气币 ${int64Number(sale.income)}`,
            sold: requested,
            income: int64Number(sale.income),
            shop: updatedShop,
        };
    }

    /**
     * 领取收购提成（cmd 99）。
     *
     * 提成来自「好友把蜜薯卖进你的铺子」，状态槽 130.11 是待领金额，
     * 领完该字段消失、福气币 +amount。没得领就返回 changed=false，不发写请求。
     */
    async function claimCommission(automatic = false): Promise<any> {
        assertCanOperate('commission', automatic);
        return serializeMutation(async () => {
            if ((retryAfter.get('commission') || 0) > now()) {
                throw businessError('SWEET_POTATO_COOLDOWN', '上一次提成领取结果正在核对，请稍后刷新再试');
            }
            const data = await getGroup();
            if (!data.active) throw businessError('SWEET_POTATO_INACTIVE', '以薯换福活动未开放或已结束');
            const pending = int64Number(data.entry.state?.pending_commission);
            if (pending <= 0) return { changed: false, message: '当前没有可领取的收购提成' };
            retryAfter.set('commission', now() + RETRY_COOLDOWN_SEC);
            const reply = await rpc('commission', {}, 15000);
            const result = reply.claim_commission;
            const amount = int64Number(result?.amount);
            if (amount <= 0) {
                throw businessError('SWEET_POTATO_RESULT_UNKNOWN', '提成领取回包金额为 0，请刷新核对');
            }
            retryAfter.delete('commission');
            invalidateBalanceCache();
            return {
                changed: true,
                amount,
                coins: int64String(result?.coins || ''),
                message: `已领取收购提成 ${amount} 福气币`,
            };
        });
    }

    async function operateSweetPotato(action: string, input: any = {}): Promise<any> {
        if (!['claim', 'share', 'sell', 'exchange', 'commission'].includes(action)) {
            throw businessError('INVALID_SWEET_POTATO_ACTION', '不支持的以薯换福操作');
        }
        if (action === 'exchange') return exchangeSweetPotatoGoods(input);
        if (action === 'commission') return claimCommission(false);

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
                // 写操作刚改了背包/福气币，这份回填的快照必须拿真值，不能读内存里的旧值。
                return { ...result, activity: await getSweetPotatoActivity(false, { freshBalances: true }) };
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
        if (data.entry.state.claims?.share_claimed || pendingShareDate === dayKey()) return false;
        const result = await mutate('share', {}, true);
        return !!result.changed;
    }

    /**
     * 自动卖薯：不是「无脑卖自己」，而是按成交价贪心吃额度。
     *
     * 1. 背包蜜薯低于 `min_count` 直接跳过，不白扫一遍好友；
     * 2. 比价按 `scan_interval_minutes` 节流，间隔内复用上一轮排序；
     * 3. 从最高价开始卖，一家额度吃满再换下一家，单轮最多 3 家；
     * 4. 好友都不收/额度用完时，按 `fallback_own` 决定要不要卖给自己；
     * 5. 每家失败只换下一家（额度不足、停收、价格变了），回包对不上就整轮停手。
     */
    async function autoSell(): Promise<boolean> {
        if (!alive() || !enabled('sell')) return false;
        const data = await getGroup();
        if (!data.active) return false;
        const config = sellConfig();
        let bag: { seeds: number; honey: number; coins: number };
        try {
            bag = await inventory();
        } catch {
            return false;
        }
        if (bag.honey <= 0 || bag.honey < config.minCount) return false;
        const shops = await rankedShops(config.friendLimit, config.scanIntervalMinutes);
        const candidates = config.fallbackOwn ? shops : shops.filter((shop: any) => !shop.unlimited);
        let remaining = bag.honey;
        let sold = 0;
        let switched = 0;
        let wrote = false;
        for (const shop of candidates) {
            if (remaining <= 0 || switched >= SELL_MAX_SHOPS_PER_RUN) break;
            if (!shop.available || shop.canSell === false) continue;
            const price = Number(shop.price || 0);
            if (!price) continue;
            // 自家铺子不占好友额度，上限只看背包；好友铺子按剩余额度截断。
            const quota = shop.unlimited ? remaining : Number(shop.remaining || 0);
            const count = Math.min(remaining, quota);
            if (count <= 0) continue;
            if (wrote && stepSpacerMs > 0) await sleep(stepSpacerMs);
            try {
                const result = await mutate('sell', {
                    hostGid: shop.unlimited ? undefined : shop.hostGid,
                    count,
                    expectedPrice: shop.unlimited ? undefined : price,
                }, true);
                // 背包已经空了（并发收获/手动出售抢在前面），本轮直接结束。
                if (!result.changed) break;
                wrote = true;
                switched += 1;
                const got = Number(result.sold || 0);
                remaining -= got;
                sold += got;
            } catch (error: any) {
                if (SELL_SKIP_CODES.has(String(error?.code || ''))) {
                    // 这家现在卖不进去，标记额度用完，换下一家。
                    shop.remaining = 0;
                    continue;
                }
                // 回包不可信这类错误必须停手，绝不能重试猜结果。
                break;
            }
        }
        if (sold > 0) scanCache = null;
        return sold > 0;
    }

    async function autoClaimCommission(): Promise<boolean> {
        if (!alive() || !enabled('commission')) return false;
        const data = await getGroup();
        if (!data.active) return false;
        if (int64Number(data.entry.state?.pending_commission) <= 0) return false;
        const result = await claimCommission(true);
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
        // 收获与补种都动背包，下一份快照要按真值报。
        invalidateBalanceCache();
        return harvestedCount + planted.length;
    }

    // 进程起来后先预热一次背包。首个快照最容易被网关并发挤掉，而这时还没有
    // 「上次成功值」可回退，界面就会一路显示 0 到下一次成功为止。提前拉一次把兜底填上。
    const warmupTimer: any = setTimeout(() => {
        void refreshBalances();
    }, 1200);
    if (typeof warmupTimer?.unref === 'function') warmupTimer.unref();

    return {
        getSweetPotatoActivity,
        getSweetPotatoShopCatalog,
        getSweetPotatoShops,
        getSweetPotatoRecords,
        scanShops,
        refreshSweetPotatoQuote,
        operateSweetPotato,
        exchangeSweetPotatoGoods,
        claimCommission,
        autoClaim,
        autoShare,
        autoSell,
        autoClaimCommission,
        plantEmptyLands,
        runCropCycle,
        isSweetPotatoActive: async (): Promise<boolean> => {
            if (!alive()) return false;
            return isActiveCached();
        },
    };
}

module.exports = { createSweetPotatoService };
