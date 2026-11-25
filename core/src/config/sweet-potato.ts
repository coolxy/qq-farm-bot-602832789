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
    /**
     * 子活动：抓包里存在但不承载数据（field 117 恒空）。
     * 兑换商店实际是主活动 2026111708 上的 cmd 96/97，这里只保留 ID 供活动目录识别。
     */
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

/**
 * cmd 与 selector 的对应关系（Operate 请求体里的 field 号 = 190 + cmd）。
 *
 * 2026-11-25 实机抓包（对照 muyuewang/qq-farm-bot-li）确认的完整命令集：
 * 91 领种子 / 92 查铺 / 93 出售 / 95 收购记录 / 96 兑换下单 / 97 兑换目录 / 98 分享 / 99 领提成。
 * 注意：兑换商店在**主活动** 2026111708 内，不走 2026111709 —— 抓包里副模块 field 117 始终为空。
 */
const SWEET_POTATO_COMMANDS = {
    claim: { cmd: 91, field: 'claim_seed' },
    shop: { cmd: 92, field: 'get_shop' },
    sell: { cmd: 93, field: 'sell' },
    catalog: { cmd: 97, field: 'catalog' },
    exchange: { cmd: 96, field: 'exchange' },
    share: { cmd: 98, field: 'share' },
    commission: { cmd: 99, field: 'claim_commission' },
} as const;

/**
 * 兑换目录的静态商品表：协议只下发档位序号与价格，item_id 由客户端静态配置映射。
 * 与官方客户端活动配置一致；价格对不上时（官方换档）一律不显示名字，避免展示错商品。
 */
const SWEET_POTATO_CATALOG_TEMPLATE: Record<number, { itemId: string; name: string; price: string }> = {
    1: { itemId: '204013', name: '七彩花弦', price: '1000000' },
    2: { itemId: '101627', name: '福气金豆礼包', price: '60000' },
    3: { itemId: '40522', name: '金币果', price: '40000' },
    4: { itemId: '40523', name: '经验蘑菇', price: '40000' },
    5: { itemId: '80011', name: '有机化肥(1小时)', price: '8500' },
    6: { itemId: '101620', name: '南瓜种子礼包', price: '28000' },
    7: { itemId: '101621', name: '荷风种子礼包', price: '28000' },
    8: { itemId: '101622', name: '千星种子礼包', price: '28000' },
    9: { itemId: '101623', name: '萌宠种子礼包', price: '35000' },
    10: { itemId: '80001', name: '化肥(1小时)', price: '7000' },
};

/** 单个铺子每日接收上限（抓包 quota 满值），只用于展示进度，不做校验。 */
const SWEET_POTATO_SHOP_DAILY_QUOTA = 8000;

/** 自动化开关默认值：与活动一起默认开启，用户明确关掉的保留。 */
const SWEET_POTATO_DEFAULTS = {
    sweet_potato: true,
    sweet_potato_claim: true,
    sweet_potato_plant: true,
    sweet_potato_sell: true,
    sweet_potato_share: true,
    sweet_potato_commission: true,
} as const;

type SweetPotatoPart = 'claim' | 'plant' | 'sell' | 'share' | 'commission' | null;

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
    SWEET_POTATO_CATALOG_TEMPLATE,
    SWEET_POTATO_SHOP_DAILY_QUOTA,
    SWEET_POTATO_DEFAULTS,
    sweetPotatoEnabled,
    isSweetPotatoPlant,
};
