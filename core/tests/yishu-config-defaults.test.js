/**
 * 以薯换福面板配置项的归一化闸门。
 *
 * 为什么单独一组：这批字段是照新版面板（脚本配置 v1.0.2）补的，
 * 默认值一旦被 cloneAccountConfig 吞掉，界面显示「23:00」而后端实际是「不限时段」，
 * 排查时完全看不出问题——所以默认值、显式空值、脏值三种情况都钉在这里。
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { cloneAccountConfig, DEFAULT_ACCOUNT_CONFIG } = require('../dist/models/store/shared-state');
const { applyConfigSnapshot } = require('../dist/models/store/account-config');

function yishu(config = {}) {
    return cloneAccountConfig(config).automation;
}

test('空配置取新面板的默认值', () => {
    const a = yishu({});
    assert.equal(a.yishu_enabled, true);
    assert.equal(a.yishu_claim_seed, true);
    assert.equal(a.yishu_share, true);
    assert.equal(a.yishu_claim_commission, true);
    assert.equal(a.yishu_auto_sell, true);
    assert.equal(a.yishu_commission_interval_hours, 6);
    assert.equal(a.yishu_scan_enabled, true);
    assert.equal(a.yishu_scan_interval_hours, 2);
    assert.equal(a.yishu_sell_min_gain, 1);
    assert.equal(a.yishu_sell_keep_count, 0);
    assert.equal(a.yishu_sell_after_time, '23:00');
    assert.equal(a.yishu_quick_sell_enabled, false);
    assert.equal(a.yishu_quick_sell_price, 500);
    assert.equal(a.yishu_sell_fallback_own, true);
    assert.equal(a.yishu_scan_friend_limit, 20);
    assert.equal(a.yishu_sell_min_count, 1);
});

test('显式关掉总开关要保留 false，不能被默认值覆盖', () => {
    const a = yishu({ automation: { yishu_enabled: false } });
    assert.equal(a.yishu_enabled, false);
    // 子开关保持原值：总开关只负责「跑不跑」，不替用户改配置。
    assert.equal(a.yishu_claim_seed ?? true, true);
});

test('显式留空的出售时间保持不限时段', () => {
    const a = yishu({ automation: { yishu_sell_after_time: '' } });
    assert.equal(a.yishu_sell_after_time, '');
});

test('出售时间的脏值归一成 HH:MM，非法值退化为不限时段', () => {
    assert.equal(yishu({ automation: { yishu_sell_after_time: '7:5' } }).yishu_sell_after_time, '07:05');
    assert.equal(yishu({ automation: { yishu_sell_after_time: '25:99' } }).yishu_sell_after_time, '23:59');
    assert.equal(yishu({ automation: { yishu_sell_after_time: 'abc' } }).yishu_sell_after_time, '');
});

test('数值项超界被夹回区间，不会把间隔算成 0', () => {
    const a = yishu({
        automation: {
            yishu_commission_interval_hours: 999,
            yishu_scan_interval_hours: '0',
            yishu_sell_min_gain: 'abc',
            yishu_sell_keep_count: -5,
            yishu_scan_friend_limit: 1000,
            yishu_quick_sell_price: 99999999,
        },
    });
    assert.equal(a.yishu_commission_interval_hours, 48);
    assert.equal(a.yishu_scan_interval_hours, 1);
    // 'abc' 解析不出数字时退回区间下限 0（前端输入框清空就是这种值）。
    assert.equal(a.yishu_sell_min_gain, 0);
    assert.equal(a.yishu_sell_keep_count, 0);
    assert.equal(a.yishu_scan_friend_limit, 200);
    assert.equal(a.yishu_quick_sell_price, 1000000);
});

test('默认配置对象本身与归一化结果一致（防止只改一处）', () => {
    const defaults = DEFAULT_ACCOUNT_CONFIG.automation;
    const cloned = yishu({});
    for (const key of Object.keys(defaults)) {
        if (!key.startsWith('yishu_')) continue;
        assert.deepEqual(cloned[key], defaults[key], `默认值不一致: ${key}`);
    }
});

// ---------- 保存链路：applyConfigSnapshot 的兜底分支会把未知键当布尔 ----------

test('保存快照后出售时间仍是字符串，数值项仍是数字（不会被 !!v 变成 true）', () => {
    const saved = applyConfigSnapshot({
        automation: {
            yishu_sell_after_time: '22:30',
            yishu_commission_interval_hours: 12,
            yishu_scan_interval_hours: 3,
            yishu_sell_min_gain: 5,
            yishu_sell_keep_count: 7,
            yishu_scan_friend_limit: 30,
            yishu_sell_min_count: 2,
            yishu_quick_sell_enabled: true,
            yishu_quick_sell_price: 650,
            yishu_enabled: false,
        },
    }, { persist: false, accountId: '' });
    const a = saved.automation;
    assert.equal(a.yishu_sell_after_time, '22:30');
    assert.equal(typeof a.yishu_sell_after_time, 'string');
    assert.equal(a.yishu_commission_interval_hours, 12);
    assert.equal(a.yishu_scan_interval_hours, 3);
    assert.equal(a.yishu_sell_min_gain, 5);
    assert.equal(a.yishu_sell_keep_count, 7);
    assert.equal(a.yishu_scan_friend_limit, 30);
    assert.equal(a.yishu_sell_min_count, 2);
    assert.equal(a.yishu_quick_sell_enabled, true);
    assert.equal(a.yishu_quick_sell_price, 650);
    assert.equal(a.yishu_enabled, false);
});

test('保存时显式留空的出售时间不会被默认值改回 23:00', () => {
    const saved = applyConfigSnapshot({
        automation: { yishu_sell_after_time: '' },
    }, { persist: false, accountId: '' });
    assert.equal(saved.automation.yishu_sell_after_time, '');
});
