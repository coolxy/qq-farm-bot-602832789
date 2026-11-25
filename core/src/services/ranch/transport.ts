export {};

const network = require('../../utils/network');
const { types } = require('../../utils/proto');
const { runExclusiveAutomationTask } = require('../automation-lock');
const { getAmbientSendContext, runWithSendContext } = require('./context');
const { logWarn } = require('../../utils/utils');
const { error } = require('./model');

const ROUTES: Record<string, [string, string, string, string?]> = {
    cells: ['homesteadpb.HomesteadService', 'AllCells', 'RanchAllCells'],
    buildings: ['homesteadpb.HomesteadService', 'GetBuildingList', 'RanchGetBuildingList'],
    facility: ['homesteadpb.HomesteadService', 'GetFacilityDetail', 'RanchGetFacilityDetail'],
    activateShed: ['homesteadpb.HomesteadService', 'ActivateFacility', 'RanchActivateFacility'],
    upgrade: ['homesteadpb.HomesteadService', 'UpgradeBuilding', 'RanchUpgradeBuilding'],
    speedUpUpgrade: ['homesteadpb.HomesteadService', 'SpeedUpBuildingUpgrade', 'RanchSpeedUpBuildingUpgrade'],
    completeUpgrade: ['homesteadpb.HomesteadService', 'CompleteBuildingUpgrade', 'RanchCompleteBuildingUpgrade'],
    addGrass: ['homesteadpb.FeedMachineService', 'AddFeed', 'RanchAddFeed'],
    animals: ['animalpb.AnimalService', 'GetRanchDetail', 'RanchGetRanchDetail'],
    enterFriend: ['visitpb.VisitService', 'EnterHomestead', 'RanchEnterHomestead'],
    leaveFriend: ['visitpb.VisitService', 'LeaveHomestead', 'RanchLeaveHomestead'],
    steal: ['animalpb.AnimalService', 'StealProduce', 'RanchStealProduce'],
    place: ['animalpb.AnimalService', 'PlaceAnimal', 'RanchPlaceAnimal'],
    produce: ['animalpb.AnimalService', 'TriggerProduce', 'RanchTriggerProduce'],
    harvest: ['animalpb.AnimalService', 'HarvestRanch', 'RanchHarvestRanch'],
    feed: ['animalpb.AnimalService', 'FeedAnimal', 'RanchFeedAnimal'],
    clean: ['animalpb.RanchService', 'CleanAllRanch', 'RanchCleanAllRanch'],
    stroke: ['animalpb.RanchService', 'StrokeAnimal', 'RanchStrokeAnimal'],
    opTimes: ['animalpb.RanchService', 'GetRanchOpTimes', 'RanchGetRanchOpTimes'],
    release: ['animalpb.AnimalService', 'DonateAnimal', 'RanchDonateAnimal'],
    putMosquito: ['animalpb.RanchService', 'PutHazard', 'RanchPutHazard'],
    bag: ['itempb.ItemService', 'GetBag', 'RanchGetBag'],
    bagTabs: ['itempb.ItemService', 'GetBagTab', 'RanchGetBagTab'],
    lockItems: ['itempb.ItemService', 'LockItems', 'LockItems'],
    unlockItems: ['itempb.ItemService', 'UnlockItems', 'UnlockItems'],
    sell: ['itempb.ItemService', 'Sell', 'RanchSell'],
    useCan: ['itempb.ItemService', 'Use', 'RanchUse'],
    shopProfiles: ['shoppb.ShopService', 'ShopProfiles', 'ShopProfiles'],
    shop: ['shoppb.ShopService', 'ShopInfo', 'ShopInfo'],
    buy: ['shoppb.ShopService', 'BuyGoods', 'BuyGoods'],
    market: ['shoppb.ShopService', 'RotationShopInfo', 'RanchRotationShopInfo'],
    exchange: ['shoppb.ShopService', 'RotationBuyGoods', 'RanchRotationBuyGoods'],
    tasks: ['taskpb.TaskService', 'TaskInfo', 'TaskInfo'],
    claimTask: ['taskpb.TaskService', 'ClaimTaskReward', 'ClaimTaskReward'],
    claimTasks: ['taskpb.TaskService', 'BatchClaimTaskReward', 'BatchClaimTaskReward'],
    reportTask: ['taskpb.TaskService', 'ClientReportProgress', 'ClientReportProgress'],
    book: ['illustratedpb.IllustratedService', 'GetIllustratedListV2', 'RanchGetIllustratedListV2'],
    bookLevels: ['illustratedpb.IllustratedService', 'GetIllustratedLevelListV2', 'GetIllustratedLevelListV2'],
    clearBookNew: ['illustratedpb.IllustratedService', 'ClearNewUnlockedFruitsV2', 'ClearNewUnlockedFruitsV2'],
    weightBook: ['illustratedpb.IllustratedService', 'GetRanchWeightScoreV2', 'RanchGetRanchWeightScoreV2'],
    claimBook: ['illustratedpb.IllustratedService', 'ClaimAllRewardsV2', 'RanchClaimAllRewardsV2'],
    claimWeight: ['illustratedpb.IllustratedService', 'ClaimRanchWeightScoreRewardV2', 'RanchClaimRanchWeightScoreRewardV2'],
    checkShare: ['sharepb.ShareService', 'CheckCanShare', 'CheckCanShare'],
    reportShare: ['sharepb.ShareService', 'ReportShare', 'RanchReportShare'],
    claimShare: ['sharepb.ShareService', 'ClaimShareReward', 'RanchClaimShareReward'],
    activities: ['activitypb.ActivityService', 'List', 'ActivityList'],
    canShop: ['mallpb.MallService', 'GetMallListBySlotType', 'GetMallListBySlotType', 'GetMallListBySlotTypeResponse'],
    buyCan: ['mallpb.MallService', 'Purchase', 'Purchase', 'PurchaseResponse'],
};

async function rpc(route: string, input: any = {}, writing = false): Promise<any> {
    const [service, method, type, replyType] = ROUTES[route];
    const request = types[`${type}Request`];
    const body = request.encode(request.fromObject(input)).finish();
    const context = getAmbientSendContext();
    const reply = await network.sendMsgAsync(`gamepb.${service}`, method, body, {
        beforeSend: () => context?.check(`gamepb.${service}`, method) || null,
        onSent: () => { if (writing) context?.onSent(`gamepb.${service}`, method); },
    });
    return types[replyType || `${type}Reply`].decode(reply.body);
}

function isUnlocked(): boolean {
    return network.getUserState().unlockedSceneIds.includes(2);
}

function inScene(run: (cells: any) => Promise<any>): Promise<any> {
    return runExclusiveAutomationTask('ranch.scene', async () => {
        if (!isUnlocked()) throw error('RANCH_LOCKED', '牧场尚未解锁，请先在游戏中完成开启条件');
        const knownScene = network.getUserState().globalSceneId;
        // 0 表示上一次恢复失败留下的「场景未知」标记。按农场（1）恢复，
        // 不能把 0 当成场景 id 发 PlayerSceneLogin。
        const previous = knownScene === 2 ? 2 : 1;
        const socket = network.getWs();
        let result: any;
        try {
            const scene = previous === 2 ? null : await network.loginGameScene(2);
            const cells = scene ? types.RanchSceneData.decode(scene.big_farm_scene_ext_data).homestead_cells : null;
            result = await run(cells);
            return result;
        } finally {
            if (previous !== 2 && network.getWs() === socket) {
                const restore = () => runWithSendContext({ check: () => null, onSent: () => {} }, () => network.loginGameScene(previous));
                let restoreError: any = null;
                try {
                    // 调用方取消后仍在原队列任务中恢复场景。
                    await restore();
                } catch (firstError: any) {
                    restoreError = firstError;
                    // 连接已经很久没有入站数据时，重试只会再白等一个超时；
                    // 但也不要在这里 terminate——连接死活交给心跳判，见下面的说明。
                    const silenceMs = Number(network.getInboundSilenceMs?.() || 0);
                    if (silenceMs > 15000) {
                        logWarn('牧场', `恢复场景 ${previous} 失败（连接已静默 ${Math.round(silenceMs / 1000)} 秒），跳过重试交由心跳判活：${firstError.message}`, { module: 'ranch', event: 'ranch_scene_restore' });
                    } else {
                        logWarn('牧场', `恢复场景 ${previous} 首次失败，1.5 秒后重试：${firstError.message}`, { module: 'ranch', event: 'ranch_scene_restore_retry' });
                        await new Promise(resolve => setTimeout(resolve, 1500));
                        // 等这 1.5 秒期间连接可能已经被换掉，此时重试毫无意义，直接沿用首次失败。
                        if (network.getWs() !== socket) {
                            restoreError = firstError;
                        } else {
                            try {
                                await restore();
                                restoreError = null;
                            } catch (retryError: any) {
                                restoreError = retryError;
                                logWarn('牧场', `恢复场景 ${previous} 重试仍失败：${retryError.message}`, { module: 'ranch', event: 'ranch_scene_restore' });
                            }
                        }
                    }
                }
                if (restoreError) {
                    // 场景没切回来 ≠ 连接已死：这里只把场景标记为未知，连接继续用。
                    // 直接 terminate 的代价两端不对称——微信有续期凭证 60 秒能回来，
                    // QQ 只有一次性 Code，牧场抖一下就要人工补票（容器里表现为「跑一会儿就掉线」）。
                    // 真正不可用的连接会在心跳漏拍 + 静默双条件满足时被判死，那条路径更明确。
                    network.markGameSceneUnknown('牧场操作结束后场景恢复未确认，已保留连接待下次重进');
                    // refreshRequired 在本项目里的语义是「让面板重拉一次数据核对结果」，不是「要求重新登录」。
                    if (result) Object.assign(result, { sceneRestored: false, refreshRequired: true, notice: '场景恢复未确认，下次牧场操作前会自动重新进入；连接保持在线' });
                }
            }
        }
    });
}

module.exports = { rpc, inScene, isUnlocked };
