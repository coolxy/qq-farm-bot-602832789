import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * Friend-related routes: friends list, friend lands, friend ops,
 * friend-blacklist, friend-known-gids, interact-records.
 */

const store = require('../../models/store');
const { normalizeKnownFriendGidSyncCooldownSec, normalizeFriendsListCacheTtlSec, INTERVAL_MAX_SEC } = require('../../models/store/shared-state');

const {
    getAccId,
    handleApiError,
    isGatewayProtocolError,
    isSoftRuntimeError,
    buildKnownFriendGidSettings,
} = require('./middleware');

/**
 * 把各种来源的一条记录归一成号池条目。
 * 采集器（card-collector）给的是 {gid, shareKey, openid, shareCfgId}，
 * 手工粘贴的 JSON 常见 {uid, share_key, share_source, ...}，两种都收。
 *
 * 只要求 uid 能转成正整数；openid 可缺（申请模式不需要，强制模式才需要），
 * 但 uid/openid/shareKey 全空的行直接丢弃。
 */
function normalizePoolItem(item: any): any {
    if (!item || typeof item !== 'object') return null;
    const uid = String(item.uid ?? item.gid ?? item.sharer_id ?? '').trim();
    if (!/^\d+$/.test(uid) || Number(uid) <= 0) return null;
    const openid = String(item.openid ?? item.openId ?? item.sharer_open_id ?? '').trim();
    const shareKey = String(item.shareKey ?? item.share_key ?? '').trim();
    if (!openid && !shareKey) return null;
    const shareSource = item.shareSource ?? item.share_source ?? item.shareCfgId ?? item.share_cfg_id ?? '';
    const docId = item.docId ?? item.doc_id ?? '';
    return {
        uid, openid, shareKey,
        shareSource: String(shareSource ?? ''),
        docId: String(docId ?? ''),
        cardTime: String(item.cardTime ?? item.card_time ?? item.at ?? ''),
        name: String(item.name || ''),
        level: Number(item.level) || 0,
        ...(item.dogBreed ? { dogBreed: String(item.dogBreed) } : {}),
    };
}

/** 解析一行 `?uid=..&openid=..&share_source=..&share_key=..` 或带时间前缀的采集日志行。 */
function parsePoolLine(line: string): any {
    const text = String(line || '').trim();
    if (!text) return null;
    // 逐行分享日志可能是 `2026-07-26 02:00:51 | uid=..&openid=..`，
    // 用正则抽参数而不是 URLSearchParams——后者会把时间前缀当成第一个键名。
    const paramRe = /(?:^|[?&\s"'<|])(uid|openid|share_source|doc_id|share_key)=([^&\s"'<|]+)/g;
    const params: Record<string, string> = {};
    let firstIndex = -1;
    let match: RegExpExecArray | null = paramRe.exec(text);
    while (match) {
        if (!(match[1] in params)) params[match[1]] = match[2];
        if (firstIndex < 0) firstIndex = match.index;
        match = paramRe.exec(text);
    }
    if (firstIndex < 0) return null;
    const cardTime = firstIndex > 0 ? text.slice(0, firstIndex).replace(/[|?&\s]+$/, '').trim() : '';
    return normalizePoolItem({
        uid: params.uid, openid: params.openid,
        shareSource: params.share_source, docId: params.doc_id,
        shareKey: params.share_key, cardTime,
    });
}

/**
 * 取好友列表用于「附加昵称头像」。返回 null 表示已经写过响应，调用方直接 return。
 *
 * `await x || []` 只兜住 null/undefined：provider 若返回对象（错误包 / 空响应），
 * 调用方的 `for...of` 会抛 TypeError —— 而那段代码在 try 之外，Express 4 不捕获
 * async 拒绝，整个主进程会因此退出，所有账号一起掉线。
 */
async function readFriendsForDisplay(ctx: AdminContext, accountId: any, res: Response): Promise<any[] | null> {
    if (!ctx.provider || typeof ctx.provider.getFriends !== 'function') return [];
    try {
        const raw = await ctx.provider.getFriends(accountId);
        return Array.isArray(raw) ? raw : [];
    } catch (error: any) {
        if (isGatewayProtocolError(error) || isSoftRuntimeError(error)) {
            handleApiError(res, error);
            return null;
        }
        // 非协议错误不影响本地数据展示
        return [];
    }
}

function mountFriendRoutes(app: Application, ctx: AdminContext): void {

    // API: 好友列表
    app.get('/api/friends', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        const forceSync = req.query.forceSync === 'true';

        try {
            const list = await ctx.provider.getFriends(id, forceSync, true);
            res.json({ ok: true, ...list });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 仅读取 Worker 内存中的好友列表缓存，不触发任何游戏协议请求。
    app.get('/api/friends/cache', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });
        try {
            const list = await ctx.provider.getFriendsCache(id, true);
            res.json({ ok: true, ...list });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 清除好友列表缓存
    app.post('/api/friends/clear-cache', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            await ctx.provider.clearFriendsCache(id);
            res.json({ ok: true });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 访客
    app.get('/api/interact-records', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = await ctx.provider.getInteractRecords(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 好友农田详情
    app.get('/api/friend/:gid/lands', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });

        try {
            const data = await ctx.provider.getFriendLands(id, req.params.gid);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 背包中当前可用于好友土地的特殊互动道具。
    app.get('/api/friend-interaction-items', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.getFriendInteractionItems(id);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 在同一次好友访问会话内，按地块编号顺序使用特殊互动道具。
    app.post('/api/friend/:gid/interaction-items/use-batch', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.useFriendInteractionItemBatch(
                id,
                req.params.gid,
                req.body?.itemId,
                req.body?.landIds,
            );
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友农场使用不需要地块目标的特殊互动道具（例如青蛙使坏瓶）。
    app.post('/api/friend/:gid/interaction-items/use-farm', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = await ctx.provider.useFriendFarmInteractionItem(id, req.params.gid, req.body?.itemId);
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友执行单次操作（偷菜/浇水/除草/捣乱）
    app.post('/api/friend/:gid/op', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const opType = String((req.body || {}).opType || '');
            const data = await ctx.provider.doFriendOp(id, req.params.gid, opType);
            if (data && data.ok === false) {
                return res.json({
                    ok: false,
                    error: data.errorMessage || data.message || data.error || '好友操作失败',
                    ...(data.reason ? { reason: data.reason } : {}),
                    ...(data.errorMessage ? { errorMessage: data.errorMessage } : {}),
                    ...(data.errorCode ? { errorCode: data.errorCode } : {}),
                });
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 游戏内删除好友
    app.post('/api/friend/:gid/delete', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const gid = Number(req.params.gid);
            if (!Number.isFinite(gid) || gid <= 0) {
                return res.status(400).json({ ok: false, error: '无效的好友 GID' });
            }
            const data = await ctx.provider.delFriend(id, gid);
            // provider 用 { ok:false } 表达游戏侧拒绝（不抛异常），同文件 /api/friend/:gid/op
            // 已按这个形状判断。原来无条件写黑名单并回报成功，会让本地与游戏内数据分叉。
            if (data && data.ok === false) {
                return res.status(400).json({ ok: false, error: String(data.error || '游戏内删除好友失败') });
            }
            if (store.addFriendToBlacklist) {
                store.addFriendToBlacklist(id, gid);
            }
            if (store.getKnownFriendGids && store.setKnownFriendGids) {
                const current = store.getKnownFriendGids(id) || [];
                const next = current.filter((item: any) => Number(item) !== gid);
                if (next.length !== current.length) {
                    store.setKnownFriendGids(id, next);
                }
            }
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            res.json({ ok: true, message: '删除好友成功', data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 好友黑名单
    app.get('/api/friend-blacklist', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        let gids: number[] = [];
        try {
            gids = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
        } catch (e: any) {
            // Express 4 不捕获 async handler 的拒绝：读盘抛错必须就地转成响应，
            // 否则请求永远挂着，并在 Node 20 上变成未处理拒绝。
            return handleApiError(res, e);
        }

        // 尝试获取好友列表以附加昵称和头像。
        // `await x || []` 只兜住了 null/undefined：provider 若返回对象（错误包 / 空响应），
        // 后面的 for...of 会抛 TypeError，而这段代码在 try 之外 —— Express 4 不捕获 async
        // 拒绝，整个主进程会因此退出，所有账号一起掉线。所以这里必须显式判数组。
        const friendsList = await readFriendsForDisplay(ctx, id, res);
        if (friendsList === null) return;

        // 构建好友信息映射
        const friendMap = new Map<number, { name: string; avatarUrl: string }>();
        for (const f of friendsList) {
            const gid = Number(f && f.gid);
            if (gid > 0) {
                friendMap.set(gid, {
                    name: f.name || f.remark || '',
                    avatarUrl: f.avatarUrl || f.avatar_url || '',
                });
            }
        }

        // 构建带好友信息的黑名单
        const list = gids.map((gid: any) => {
            const info = friendMap.get(Number(gid)) || { name: '', avatarUrl: '' };
            return {
                gid: Number(gid),
                name: info.name || '',
                avatarUrl: info.avatarUrl || '',
            };
        });

        res.json({ ok: true, data: list });
    });

    app.post('/api/friend-blacklist/toggle', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gid = Number((req.body || {}).gid);
        // 原来 `!gid` 放行 -1 / Infinity：下游会静默过滤掉，路由却回报 ok:true，
        // 前端以为已拉黑。与删除好友接口用同一套正整数校验。
        if (!Number.isInteger(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: '无效的好友 GID' });
        }
        let savedGids: number[];
        try {
            const current = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
            let next: number[];
            if (current.includes(gid)) {
                next = current.filter((g: number) => g !== gid);
            } else {
                next = [...current, gid];
            }
            savedGids = store.setFriendBlacklist ? store.setFriendBlacklist(id, next) : next;

            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
        } catch (e: any) {
            return handleApiError(res, e);
        }

        // 尝试获取好友列表以附加昵称和头像。
        // `await x || []` 只兜住了 null/undefined：provider 若返回对象（错误包 / 空响应），
        // 后面的 for...of 会抛 TypeError，而这段代码在 try 之外 —— Express 4 不捕获 async
        // 拒绝，整个主进程会因此退出，所有账号一起掉线。所以这里必须显式判数组。
        const friendsList = await readFriendsForDisplay(ctx, id, res);
        if (friendsList === null) return;

        // 构建好友信息映射
        const friendMap = new Map<number, { name: string; avatarUrl: string }>();
        for (const f of friendsList) {
            const fGid = Number(f && f.gid);
            if (fGid > 0) {
                friendMap.set(fGid, {
                    name: f.name || f.remark || '',
                    avatarUrl: f.avatarUrl || f.avatar_url || '',
                });
            }
        }

        // 构建带好友信息的黑名单
        const saved = savedGids.map((g: any) => {
            const info = friendMap.get(Number(g)) || { name: '', avatarUrl: '' };
            return {
                gid: Number(g),
                name: info.name || '',
                avatarUrl: info.avatarUrl || '',
            };
        });

        res.json({ ok: true, data: saved });
    });

    /**
     * 外挂检测：基于访客互动样本（72 小时窗口）的行为分析。
     * 纯本地数据，不触发游戏请求；好友昵称/头像从缓存名单里补。
     */
    app.get('/api/friend-cheat-analysis', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        let analysis: any;
        try {
            analysis = require('../../services/friend/cheat-detect').analyzeFriendCheat(String(id));
        } catch (e: any) {
            return handleApiError(res, e);
        }

        // 好友昵称/头像只是锦上添花：账号离线或 provider 报错时直接跳过，
        // 不能让「本地样本分析」被一次网络请求拖成失败。
        let friendsList: any[] = [];
        try {
            const raw = typeof ctx.provider?.getFriends === 'function' ? await ctx.provider.getFriends(id) : [];
            friendsList = Array.isArray(raw) ? raw : [];
        }
        catch {
            friendsList = [];
        }
        const friendMap = new Map<number, { name: string, avatarUrl: string }>();
        for (const f of friendsList) {
            const gid = Number(f && f.gid);
            if (gid > 0)
                friendMap.set(gid, { name: f.name || f.remark || '', avatarUrl: f.avatarUrl || f.avatar_url || '' });
        }
        const visitors = (analysis.visitors || []).map((visitor: any) => {
            const info = friendMap.get(Number(visitor.gid));
            return {
                ...visitor,
                name: info?.name || visitor.nick || `GID:${visitor.gid}`,
                avatarUrl: info?.avatarUrl || '',
            };
        });

        return res.json({ ok: true, data: { ...analysis, visitors } });
    });

    // ============ 好友GID管理 API ============

    // 获取已知好友GID设置
    app.get('/api/friend-known-gids', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 保存已知好友GID设置
    app.post('/api/friend-known-gids', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            for (const [field, label, normalize] of [
                ['knownFriendGidSyncCooldownSec', '访客检测入库冷却', normalizeKnownFriendGidSyncCooldownSec],
                ['friendsListCacheTtlSec', '好友列表缓存', normalizeFriendsListCacheTtlSec],
            ] as const) {
                const raw = body[field];
                if (raw === undefined) continue;
                const seconds = typeof raw === 'string' ? Number(raw) : raw;
                if (!Number.isInteger(seconds) || normalize(seconds) !== seconds) {
                    return res.status(400).json({ ok: false, error: `${label}须填写 ${normalize(0)} 至 ${INTERVAL_MAX_SEC} 的整数秒数` });
                }
            }
            if (body.knownFriendGids !== undefined) {
                store.setKnownFriendGids(id, body.knownFriendGids);
            }
            if (body.knownFriendGidSyncCooldownSec !== undefined) {
                store.setKnownFriendGidSyncCooldownSec(id, Number(body.knownFriendGidSyncCooldownSec));
            }
            if (body.friendsListCacheTtlSec !== undefined) {
                store.setFriendsListCacheTtlSec(id, Number(body.friendsListCacheTtlSec));
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 移除单个好友GID
    app.post('/api/friend-known-gids/remove', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gid = Number((req.body || {}).gid);
        if (!Number.isFinite(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: 'GID 无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const next = Array.isArray(current) ? current.filter((item: any) => Number(item) !== gid) : [];
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 批量添加好友GID
    app.post('/api/friend-known-gids/batch-add', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.status(400).json({ ok: false, error: 'GID 列表无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const currentSet = new Set(current.map(Number));
            let addedCount = 0;
            for (const gid of gids) {
                const num = Number(gid);
                if (!Number.isFinite(num) || num <= 0) continue;
                if (!currentSet.has(num)) {
                    currentSet.add(num);
                    addedCount++;
                }
            }
            const next = Array.from(currentSet);
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig(id);
            }
            return res.json({
                ok: true,
                data: buildKnownFriendGidSettings(id),
                addedCount,
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // 批量删除未同步的好友GID
    app.post('/api/friend-known-gids/batch-remove', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id), removedCount: 0 });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const removeSet = new Set(gids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0));
            const next = current.filter((gid: any) => !removeSet.has(Number(gid)));
            const removedCount = current.length - next.length;

            if (removedCount > 0 && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }

            return res.json({
                ok: true,
                data: buildKnownFriendGidSettings(id),
                removedCount,
            });
        } catch (e: any) {
            return handleApiError(res, e);
        }
    });

    // ==================== 好友号池 / 主动加好友（BUGDey v2.18.12） ====================
    // 号池文件全账号共享，状态按账号隔离；导入/删除在主进程直接落盘，
    // 真正发申请必须通过 worker（游戏连接在那里，且要独占自动化）。
    app.get('/api/friends/pool', (req: Request, res: Response) => {
        const id = getAccId(ctx, req) || 'default';
        try {
            res.json({ ok: true, data: require('../../services/friend/pool').snapshot(id) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/friends/pool/import', (req: Request, res: Response) => {
        const raw = String((req.body || {}).text || '').trim();
        const items: any[] = [];
        // 兼容采集器导出的 JSON（{ data:[...] } 或直接数组）与逐行分享链接两种格式。
        if (raw.startsWith('{') || raw.startsWith('[')) {
            try {
                const parsed = JSON.parse(raw);
                const entries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
                for (const entry of entries) {
                    const item = normalizePoolItem(entry);
                    if (item) items.push(item);
                }
            } catch {
                return res.status(400).json({ ok: false, error: 'JSON 解析失败，请检查粘贴内容' });
            }
        } else {
            for (const line of raw.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean)) {
                const item = parsePoolLine(line);
                if (item) items.push(item);
            }
        }
        try {
            const result = items.length
                ? require('../../services/friend/pool').upsertItems(items)
                : { added: 0, updated: 0 };
            res.json({ ok: true, data: { ...result, parsed: items.length } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // ==================== 采集器兼容层（card-collector / pywxrobot4 推送） ====================
    // 采集器（collect.py、server.py）打的是 /api/auto-friend/pool/import，
    // body {users:[{gid,shareKey,openid,shareCfgId}]}，头 x-admin-token + x-account-id，
    // 只认 data.added / data.updated / data.skipped。这里做等价映射，
    // 采集器端只需把 PANEL_URL 指向本机，其它一概不用改。
    app.post('/api/auto-friend/pool/import', (req: Request, res: Response) => {
        const body = req.body || {};
        const entries: any[] = Array.isArray(body.users)
            ? body.users
            : (Array.isArray(body.items) ? body.items : []);
        const items: any[] = [];
        let skipped = 0;
        for (const entry of entries) {
            const item = normalizePoolItem(entry);
            if (item) items.push(item);
            else skipped += 1;
        }
        // 采集器偶尔直接转发整段文本（没有 users 数组）时，退回文本解析。
        if (!entries.length && typeof body.text === 'string') {
            for (const line of String(body.text).split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean)) {
                const item = parsePoolLine(line);
                if (item) items.push(item);
                else skipped += 1;
            }
        }
        try {
            const result = items.length
                ? require('../../services/friend/pool').upsertItems(items)
                : { added: 0, updated: 0 };
            res.json({ ok: true, data: { ...result, skipped, parsed: items.length } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // 采集器/面板读取号池（等价于 /api/friends/pool，路径与参考实现一致）
    app.get('/api/auto-friend/pool', (req: Request, res: Response) => {
        const id = getAccId(ctx, req) || 'default';
        try {
            res.json({ ok: true, data: require('../../services/friend/pool').snapshot(id) });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/friends/pool/:uid', (req: Request, res: Response) => {
        try {
            const removed = require('../../services/friend/pool').removeItem(req.params.uid);
            res.json({ ok: true, data: { removed } });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    app.post('/api/friends/apply-invites', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false });
        const body = req.body || {};
        try {
            const data = await ctx.provider.applyFriendInvites(id, Array.isArray(body.items) ? body.items : [], body.options || {});
            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

}

// normalizePoolItem / parsePoolLine 一并导出，供采集器兼容层单测直接调用。
module.exports = { mountFriendRoutes, normalizePoolItem, parsePoolLine };
