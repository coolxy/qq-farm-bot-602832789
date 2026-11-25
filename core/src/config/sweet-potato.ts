export {};

/**
 * 以薯换福（2026-11）活动常量与自动化开关。
 *
 * ID、时间窗与协议 cmd 均来自官方客户端抓包（2026-11-25），
 * 与本仓库已合并的红薯资源（Plant 1020307 / 种子 20307 / 果实 40307 / 蜜薯 1032）配套。
 */
const SWEET_POTATO = {
    /** 活动组：GetGroup 的 group_id */
    groupId: '2026111707',
    /** 主活动：领种子 / 出售 / 分享都在这个 ID 上操作 */
    activityId: '2026111708',
    /** 子活动：兑换商店（ExchangeShopRequest 用这个 ID，见 docs/sweet-potato.md） */
    shopActivityId: '2026111709',
    seedId: 20307,
    plantId: 1020307,
    fruitId: 40307,
    /** 蜜薯：收获红薯时额外掉落，出售给铺子换福气币 */
    honeyId: 1032,
    /** 福气币 */
    coinId: 1033,
    /** 抓包时的活动窗口（服务端回包会覆盖，这里只作离线兜底） */
    fallbackStartTime: 1795572000,
    fallbackEndTime: 1796831999,
} as const;

/** cmd 与 selector 的对应关系（Operate 请求体里的 field 号）。 */
const SWEET_POTATO_COMMANDS = {
    claim: { cmd: 91, field: 'claim_seed' },
    shop: { cmd: 92, field: 'get_shop' },
    sell: { cmd: 93, field: 'sell' },
    share: { cmd: 98, field: 'share' },
} as const;

/** 自动化开关默认值：与活动一起默认开启，用户明确关掉的保留。 */
const SWEET_POTATO_DEFAULTS = {
    sweet_potato: true,
    sweet_potato_claim: true,
    sweet_potato_plant: true,
    sweet_potato_sell: true,
    sweet_potato_share: true,
} as const;

type SweetPotatoPart = 'claim' | 'plant' | 'sell' | 'share' | null;

/** 总开关 + 子开关都开才算启用；part 为空时只判总开关。 */
function sweetPotatoEnabled(automation: any, part: SweetPotatoPart = null): boolean {
    if (automation?.sweet_potato === false) return false;
    return !part || automation?.[`sweet_potato_${part}`] !== false;
}

function isSweetPotatoPlant(plant: any): boolean {
    return Number(plant?.id) === SWEET_POTATO.plantId;
}

module.exports = {
    SWEET_POTATO,
    SWEET_POTATO_COMMANDS,
    SWEET_POTATO_DEFAULTS,
    sweetPotatoEnabled,
    isSweetPotatoPlant,
};
