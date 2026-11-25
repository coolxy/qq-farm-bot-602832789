export {};
const { Buffer } = require('node:buffer');

/**
 * 宿主传输的共享状态。
 *
 * 提前到文件顶部声明：worker 侧最早在发送 RPC（约 500 行）时就要用它，
 * 声明留在原处会让「使用早于定义」在静态检查里报警，运行期虽然没事，但读代码的人
 * 得一直往下翻才能确认它不是 undefined。
 */
const hostState: {
    client: any;
    adapter: HostSocketAdapter | null;
    session: any;
    stateTimer: any;
    lastStateJson: string;
} = { client: null, adapter: null, session: null, stateTimer: null, lastStateJson: '' };
const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { util: protobufUtil } = require('protobufjs');
const { CONFIG } = require('../config/config');
const { getClientVersion, getLoginDeviceInfo, isWechatPlatform } = require('./client-profile');
const { createScheduler } = require('../services/scheduler');
const { updateStatusFromLogin, updateStatusGold, updateStatusLevel } = require('../services/status');
const { recordOperation } = require('../services/stats');
const { invalidateLandForecast } = require('../services/level-forecast');
const { types } = require('./proto');
const { toLong, toNum, syncServerTime, getServerTimeSec, formatDateKeyInTimeZone, log, logWarn, sleep } = require('./utils');
const cryptoWasm = require('./crypto-wasm');
const { GatewayTokenProvider } = require('./gateway-token');
const { MAX_HEARTBEAT_MISSES, shouldTerminateForHeartbeat, shouldTerminateForSilence } = require('./keepalive-policy');
const { countBlockingQueuedRequests, shouldLogRequestPressure } = require('./request-pressure');
const { HostClient } = require('../host/host-client');
const {
    checkRequest: checkRequestBudget,
    recordSent: recordRequestSent,
    recordOutcome: recordRequestOutcome,
    getGovernorStats,
} = require('./request-governor');
const {
    LOW_PRIORITY_IDLE_POLL_MS,
    LOW_PRIORITY_IDLE_WAIT_MAX_MS,
    LOW_PRIORITY_QUEUE_WAIT_MS,
    isGatewayIdleForLowPriority,
} = require('./low-priority-gate');
const {
    describeRequestClassLabel,
    isClassQueueFull,
    maxQueuedForClass,
    resolveRequestClass,
    selectDispatchIndex,
} = require('./request-priority');
const {
    EMPTY_LIST_TEXT,
    describeBudgetReasonZh,
    describeFlowModeZh,
    formatDurationZh,
    formatGatewayCounts,
    formatInflightSegment,
    formatPendingItem,
    formatQueuedItem,
    formatRequestPressureZh,
    joinListZh,
} = require('./net-diagnosis-text');
const { getAmbientRequestClass } = require('./request-context');
const { isInActivityRound, readActivityRound } = require('./activity-round');
const { startAceRuntime, stopAceRuntime, getAceDiagnostics } = require('../services/ace');

// ============ 事件发射器 (用于推送通知) ============
const networkEvents = new EventEmitter();

// ============ 内部状态 ============
type ConnectionPhase = 'connecting' | 'login' | 'online';
type RequestPriority = 'low' | 'normal' | 'high';
/** 请求班次，见 utils/request-priority.ts。 */
type RequestClass = 'critical' | 'foreground' | 'farm' | 'friend' | 'background';
type CriticalLane = 'heartbeat' | 'ace';

interface ConnectionContext {
    id: number;
    socket: WebSocket;
    phase: ConnectionPhase;
    intentionalClose: boolean;
    finalized: boolean;
    loginInitialized: boolean;
    clientVersion: string;
    startedMono?: number;
    onlineMono?: number;
    heartbeat?: { attempts: number; replies: number; failures: number };
}

interface SendMsgOptions {
    beforeSend?: () => Error | null;
    onSent?: () => void;
    timeoutMs?: number;
    expectedErrorCodes?: readonly number[];
    /** 兼容旧调用：high→critical、low→background、normal 视为「未表态」交给环境班次。 */
    priority?: RequestPriority;
    /** 显式指定班次，优先于 priority 与环境班次。 */
    requestClass?: RequestClass;
    criticalLane?: CriticalLane;
    expectReply?: boolean;
}

interface PendingRequest {
    // 回调允许是 async：handleMessage 走 invokePendingCallback 统一接管拒绝。
    callback: (err: Error | null, body?: Buffer, meta?: any) => void | Promise<void>;
    expectedErrorCodes: Set<number>;
    serviceName?: string;
    methodName?: string;
    startedMono?: number;
    requestClass: RequestClass;
    criticalLane?: CriticalLane;
}

interface QueuedRequest {
    beforeSend?: () => Error | null;
    onSent?: () => void;
    context: ConnectionContext;
    serviceName: string;
    methodName: string;
    bodyBytes: Buffer;
    expectedErrorCodes: Set<number>;
    resolve: (value: { body: Buffer; meta: any }) => void;
    reject: (reason: Error) => void;
    timeoutKey: string;
    queueWaitKey: string;
    seq: number | null;
    settled: boolean;
    requestClass: RequestClass;
    criticalLane?: CriticalLane;
    enqueuedAt: number;
    expectReply: boolean;
}

class GatewayError extends Error {
    code: number;
    serviceName: string;
    methodName: string;
    errorMessage: string;
    clientSeq: number;

    constructor(meta: any) {
        const code = toNum(meta && meta.error_code);
        const serviceName = String((meta && meta.service_name) || '');
        const methodName = String((meta && meta.method_name) || '');
        const errorMessage = String((meta && meta.error_message) || '');
        super(`${serviceName}.${methodName} 错误: code=${code} ${errorMessage}`.trim());
        this.name = 'GatewayError';
        this.code = code;
        this.serviceName = serviceName;
        this.methodName = methodName;
        this.errorMessage = errorMessage;
        this.clientSeq = toNum(meta && meta.client_seq);
    }
}

/** background 班次请求让路时抛出的错误：不是业务失败，而是「现在不该占用连接」。 */
class GatewayBusyError extends Error {
    /** 预算/排队让路时建议的等待时间，调度器用它给 tick 退避。 */
    retryAfterMs: number;

    constructor(message: string, retryAfterMs: number = 0) {
        super(message);
        this.name = 'GatewayBusyError';
        this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
    }
}

let ws: WebSocket | null = null;
let currentConnection: ConnectionContext | null = null;
let nextConnectionId = 1;
let clientSeq: number = 1;
let serverSeq: number = 0;
const pendingCallbacks = new Map<number, PendingRequest>();
const requestQueue: QueuedRequest[] = [];
// Gateway 是单连接复用，并发预算与班次优先级全部集中在 utils/request-priority.ts。
// 这里只保留日志里要展示多少条在途请求。
const MAX_DESCRIBED_PENDING_REQUESTS = 6;
let nextRequestId = 1;
let wsErrorState = { code: 0, at: 0, message: '' };
let lastRequestPressureLogAt = 0;
/** 预算拦截日志节流：超额时每个调用点都会命中，不节流会把日志刷爆。 */
const BUDGET_LOG_INTERVAL_MS = 30_000;
let lastBudgetLogAt = 0;
const networkScheduler = createScheduler('network');
const gatewayTokens = new GatewayTokenProvider();
let lastHeartbeatMono = performance.now();
let lastInboundMono = performance.now();
let heartbeatMissCount = 0;

function settleQueuedRequest(request: QueuedRequest, error?: Error, value?: { body: Buffer; meta: any }): void {
    if (request.settled) return;
    request.settled = true;
    networkScheduler.clear(request.timeoutKey);
    networkScheduler.clear(request.queueWaitKey);
    if (error) request.reject(error);
    else request.resolve(value!);
}

function pendingClassCount(requestClass: RequestClass): number {
    let count = 0;
    for (const pending of pendingCallbacks.values()) {
        if (pending.requestClass === requestClass) count += 1;
    }
    return count;
}

function pendingBusinessCount(): number {
    return pendingClassCount('foreground') + pendingClassCount('farm') + pendingClassCount('friend');
}

interface GatewayLoad {
    pending: number;
    queued: number;
    /** 队列里非 background 的请求数：只有这些代表「有人真的在等连接」。 */
    blockingQueued: number;
    criticalPending: number;
    businessPending: number;
    foregroundPending: number;
    backgroundPending: number;
    heartbeatMisses: number;
    oldestPendingAgeMs: number;
}

function oldestPendingAgeMs(): number {
    const now = performance.now();
    let oldest = 0;
    for (const pending of pendingCallbacks.values()) {
        if (pending.startedMono === undefined) continue;
        const age = Math.max(0, now - pending.startedMono);
        if (age > oldest) oldest = age;
    }
    return oldest;
}

/** 后台任务用来判断「现在该不该占用连接」的负载快照。 */
function getGatewayLoad(): GatewayLoad {
    return {
        pending: pendingCallbacks.size,
        queued: requestQueue.length,
        blockingQueued: countBlockingQueuedRequests(requestQueue),
        criticalPending: pendingClassCount('critical'),
        businessPending: pendingBusinessCount(),
        foregroundPending: pendingClassCount('foreground'),
        backgroundPending: pendingClassCount('background'),
        heartbeatMisses: heartbeatMissCount,
        oldestPendingAgeMs: oldestPendingAgeMs(),
    };
}

function isGatewayIdleForBackground(): boolean {
    return isGatewayIdleForLowPriority(getGatewayLoad());
}

/** 距上一次收到入站数据过去了多久（毫秒）。 */
function getInboundSilenceMs(): number {
    return Math.max(0, performance.now() - lastInboundMono);
}

/**
 * 网关是否已经「濒死」：在途请求堆着，同时最近一段时间没有任何入站数据。
 * 这种状态下继续塞可牺牲流量（ACE 上报、后台补数据）只会加速掉线，
 * 应该让路给心跳。
 */
function isGatewayStalling(): boolean {
    return pendingCallbacks.size >= 3 && getInboundSilenceMs() > 15000;
}

/**
 * 等网关空闲到可以插入后台请求；等不到就返回 false，由调用方整轮让路。
 * 只观察不排队，所以等待期间一点压力都不加给网关。
 */
async function waitForGatewayIdle(
    maxWaitMs: number = LOW_PRIORITY_IDLE_WAIT_MAX_MS,
    pollMs: number = LOW_PRIORITY_IDLE_POLL_MS,
): Promise<boolean> {
    const deadline = performance.now() + Math.max(0, Number(maxWaitMs) || 0);
    for (;;) {
        if (isGatewayIdleForBackground()) return true;
        if (performance.now() >= deadline) return false;
        await sleep(Math.max(20, Number(pollMs) || LOW_PRIORITY_IDLE_POLL_MS));
    }
}

/**
 * 挑出下一个可发送的请求。分层与容量规则全部在 utils/request-priority.ts 里，
 * 这里只负责清掉已结算的队列项、把选中项摘出来。
 */
function takeDispatchableRequest(): QueuedRequest | null {
    for (let index = requestQueue.length - 1; index >= 0; index--) {
        if (requestQueue[index].settled) requestQueue.splice(index, 1);
    }
    if (requestQueue.length === 0) return null;
    const index = selectDispatchIndex(requestQueue, Array.from(pendingCallbacks.values()), performance.now());
    if (index < 0) return null;
    return requestQueue.splice(index, 1)[0];
}

function drainRequestQueue(): void {
    while (requestQueue.length > 0) {
        const request = takeDispatchableRequest();
        if (!request) break;

        if (!isCurrentConnection(request.context) || request.context.phase !== 'online') {
            settleQueuedRequest(request, new Error(`连接未打开：${request.methodName}`));
            continue;
        }

        const seq = clientSeq;
        request.seq = seq;
        const pending: PendingRequest | undefined = request.expectReply ? {
            serviceName: request.serviceName,
            methodName: request.methodName,
            startedMono: performance.now(),
            requestClass: request.requestClass,
            criticalLane: request.criticalLane,
            expectedErrorCodes: request.expectedErrorCodes,
            callback: (err, body, meta) => {
                if (err) settleQueuedRequest(request, err);
                else settleQueuedRequest(request, undefined, { body: body!, meta });
                drainRequestQueue();
            },
        } : undefined;
        sendMsg(request.context, request.serviceName, request.methodName, request.bodyBytes, pending, request.requestClass, request).then((sent) => {
            if (sent) {
                if (!request.expectReply) {
                    settleQueuedRequest(request, undefined, { body: Buffer.alloc(0), meta: {} });
                    drainRequestQueue();
                }
                return;
            }
            pendingCallbacks.delete(seq);
            settleQueuedRequest(request, new Error(`发送失败：${request.methodName}`));
            drainRequestQueue();
        }).catch((error: any) => {
            pendingCallbacks.delete(seq);
            settleQueuedRequest(request, error instanceof Error ? error : new Error(String(error)));
            drainRequestQueue();
        });
    }
}

function rejectAllQueuedRequests(reason: string): number {
    const entries = requestQueue.splice(0);
    for (const request of entries) settleQueuedRequest(request, new Error(reason));
    return entries.length;
}

/**
 * 统一调用响应回调。
 *
 * 登录回包的 callback 是 async 函数，同步 try/catch 拦不住它的 Promise 拒绝；
 * Node 20 把未处理拒绝当致命错误，会直接带走整个 worker 进程。所有调用点
 * 都走这里，把「同步抛错」和「异步拒绝」一起收敛成一条告警。
 */
function invokePendingCallback(
    callback: (err: Error | null, body?: Buffer, meta?: any) => void | Promise<void>,
    err: Error | null,
    body?: Buffer,
    meta?: any,
): void {
    try {
        const result: any = callback(err, body, meta);
        if (result && typeof result.then === 'function') {
            Promise.resolve(result).catch((error: any) => {
                logWarn('网络', `响应回调执行异常: ${String((error && error.message) || error)}`);
            });
        }
    } catch (error: any) {
        logWarn('网络', `响应回调执行异常: ${String((error && error.message) || error)}`);
    }
}

function rejectAllPendingRequests(reason = '请求被中断'): number {
    const entries = Array.from(pendingCallbacks.entries());
    pendingCallbacks.clear();
    for (const [, pending] of entries) {
        invokePendingCallback(pending.callback, new Error(reason));
    }
    return entries.length;
}

function describePendingRequests(): string {
    if (pendingCallbacks.size === 0) return EMPTY_LIST_TEXT;
    const now = performance.now();
    return joinListZh(Array.from(pendingCallbacks.entries())
        .slice(0, MAX_DESCRIBED_PENDING_REQUESTS)
        .map(([seq, pending]) => formatPendingItem(
            pending.methodName,
            seq,
            pending.startedMono === undefined ? 0 : Math.max(0, now - pending.startedMono),
        )));
}

function describeQueuedRequests(): string {
    if (requestQueue.length === 0) return EMPTY_LIST_TEXT;
    return joinListZh(requestQueue
        .slice(0, 8)
        .map(request => formatQueuedItem(request.methodName, describeRequestClassLabel(request))));
}

/** 画像日志里只保留 `PlantService.AllLands` 这种短名，避免整行被包名占满。 */
function shortMethod(key: string): string {
    const parts = String(key || '').split('.');
    if (parts.length < 2) return String(key || '');
    return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

function logRequestPressure(): void {
    const now = performance.now();
    if (!shouldLogRequestPressure(requestQueue, now, lastRequestPressureLogAt)) return;
    lastRequestPressureLogAt = now;
    logWarn('系统', formatRequestPressureZh({
        pending: pendingCallbacks.size,
        queued: requestQueue.length,
        active: describePendingRequests(),
        queuedMethods: describeQueuedRequests(),
    }));
}

// ============ 用户状态 (登录后设置) ============
const userState = {
    gid: 0,
    name: '',
    level: 0,
    gold: 0,
    exp: 0,
    coupon: 0,
    goldBean: 0,
    openId: '',
    avatarUrl: '',
    globalSceneId: 1,
    unlockedSceneIds: [] as number[],
};

function getUserState() { return userState; }

const shareInfoState = new Map<string, { shareCount: string; claimed: boolean; dateKey: string }>();
function applyShareInfos(infos: Record<string, any>): void {
    const dateKey = formatDateKeyInTimeZone(getServerTimeSec() * 1000, 'Asia/Shanghai');
    for (const [key, info] of Object.entries(infos)) {
        const id = /^\d+$/.test(key) ? key : protobufUtil.longFromHash(key, false).toString();
        shareInfoState.set(id, { shareCount: info.share_count.toString(), claimed: info.is_claimed, dateKey });
    }
}
function getDailyShareInfo(id: number): any {
    const dateKey = formatDateKeyInTimeZone(getServerTimeSec() * 1000, 'Asia/Shanghai');
    const state = shareInfoState.get(String(id));
    return state?.dateKey === dateKey ? { ...state } : { shareCount: '0', claimed: false, dateKey };
}

async function loginGameScene(globalSceneId: number): Promise<any> {
    const body = types.PlayerSceneLoginRequest.encode({ global_scene_id: globalSceneId }).finish();
    const response = await sendMsgAsync('gamepb.globalscenepb.GlobalSceneService', 'PlayerSceneLogin', body);
    const scene = types.PlayerSceneLoginReply.decode(response.body);
    const data = globalSceneId === 2 ? scene.big_farm_scene_ext_data : scene.farm_scene_ext_data;
    if (scene.global_scene_id !== globalSceneId || !data?.length) throw new Error('游戏场景登录回包不完整');
    userState.globalSceneId = globalSceneId;
    if (toNum(scene.server_time) > 0) syncServerTime(toNum(scene.server_time));
    return scene;
}
function getWsErrorState() { return { ...wsErrorState }; }
function setWsErrorState(code: number, message: string): void {
    wsErrorState = { code: Number(code) || 0, at: Date.now(), message: message || '' };
}
function clearWsErrorState(): void {
    wsErrorState = { code: 0, at: 0, message: '' };
}

function hasOwn(obj: any, key: string): boolean {
    return !!obj && Object.hasOwn(obj, key);
}

// 登录后获取用户设置
async function fetchUserSettings(): Promise<void> {
    try {
        const body = types.GetUserSettingsRequest.encode(types.GetUserSettingsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.userpb.UserService', 'GetUserSettings', body);
        const reply = types.GetUserSettingsReply.decode(replyBody);
        if (reply.settings) {
            log('系统', `用户设置已同步`);
        }
    } catch {
        // 忽略获取失败
    }
}

// ============ 消息编解码 ============
async function encodeMsg(serviceName: string, methodName: string, bodyBytes: Buffer, clientSeqValue: number): Promise<Buffer> {
    let finalBody = bodyBytes || Buffer.alloc(0);
    if (finalBody.length > 0) {
        finalBody = await cryptoWasm.encryptBuffer(finalBody);
    }
    const msg = types.GateMessage.create({
        meta: {
            service_name: serviceName,
            method_name: methodName,
            message_type: 1,
            client_seq: toLong(clientSeqValue),
            server_seq: toLong(serverSeq),
        },
        body: finalBody,
        token: gatewayTokens.next(),
    });
    return types.GateMessage.encode(msg).finish();
}

function isCurrentConnection(context: ConnectionContext): boolean {
    return currentConnection === context && ws === context.socket && !context.finalized;
}

async function sendMsg(
    context: ConnectionContext,
    serviceName: string,
    methodName: string,
    bodyBytes: Buffer,
    pending?: PendingRequest,
    requestClass: RequestClass = 'foreground',
    hooks?: Pick<SendMsgOptions, 'beforeSend' | 'onSent'>,
): Promise<boolean> {
    // 连接宿主模式：把**明文** body 交给宿主，加密 / token / 信封都在那边完成。
    if (isHostTransportEnabled()) {
        if (!isCurrentConnection(context) || (context.socket as any).readyState !== WebSocket.OPEN) {
            log('系统', '[WS] 连接未打开');
            return false;
        }
        const seq = clientSeq;
        clientSeq += 1;
        if (pending) pendingCallbacks.set(seq, pending);
        const blocked = hooks?.beforeSend?.();
        if (blocked) throw blocked;
        try {
            hostState.client.sendRpc(seq, serviceName, methodName, bodyBytes || Buffer.alloc(0));
            hooks?.onSent?.();
        } catch (err: any) {
            if (pending) {
                pendingCallbacks.delete(seq);
                invokePendingCallback(pending.callback, err);
            }
            return false;
        }
        try { recordRequestSent(serviceName, methodName, requestClass); } catch {}
        return true;
    }
    if (!isCurrentConnection(context) || context.socket.readyState !== WebSocket.OPEN) {
        log('系统', '[WS] 连接未打开');
        return false;
    }
    const seq = clientSeq;
    clientSeq += 1;
    // 加密前登记在途请求，确保排队器能准确计算并发槽位。
    if (pending) pendingCallbacks.set(seq, pending);
    const encoded = await encodeMsg(serviceName, methodName, bodyBytes, seq);
    if (pending && pendingCallbacks.get(seq) !== pending) return false;
    if (!isCurrentConnection(context) || context.socket.readyState !== WebSocket.OPEN) {
        if (pending) {
            pendingCallbacks.delete(seq);
            invokePendingCallback(pending.callback, new Error(`连接未打开：${methodName}`));
        }
        return false;
    }
    const blocked = hooks?.beforeSend?.();
    if (blocked) throw blocked;
    try {
        context.socket.send(encoded);
        hooks?.onSent?.();
    } catch (err: any) {
        if (pending) {
            pendingCallbacks.delete(seq);
            invokePendingCallback(pending.callback, err);
        }
        return false;
    }
    // 只有真正落到 socket 上的请求才登记；排队中被拒的不算。
    // 带上班次，前台请求与自动任务在画像里分开统计（前台不计入自动任务额度）。
    try { recordRequestSent(serviceName, methodName, requestClass); } catch {}
    return true;
}

/**
 * 活动轮次内可合并的纯读方法：活动组数据（GetGroup）与背包（Bag）。
 * 只在 withActivityRound 作用域内生效，面板/手动操作不在轮内，永远直连。
 */
function isActivityRoundRead(serviceName: string, methodName: string): boolean {
    if (methodName === 'GetGroup') return true;
    return methodName === 'Bag' && serviceName === 'gamepb.itempb.ItemService';
}

function sendMsgAsync(serviceName: string, methodName: string, bodyBytes: Buffer, timeoutOrOptions: number | SendMsgOptions = 20000): Promise<{ body: Buffer; meta: any }> {
    const options: SendMsgOptions = typeof timeoutOrOptions === 'number'
        ? { timeoutMs: timeoutOrOptions }
        : (timeoutOrOptions || {});
    // Infinity / NaN / 负数经 Math.max 会变成 0 或 1，下游 toDelayMs 再把非有限值
    // 折成 0 → 请求刚入队就被判超时。只接受有限正数，其余回落到 20 秒。
    const rawTimeoutMs = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0
        ? Math.max(1, Math.floor(rawTimeoutMs))
        : 20000;
    const expectedErrorCodes = new Set((options.expectedErrorCodes || []).map(Number).filter(Number.isFinite));
    const criticalLane: CriticalLane | undefined = options.criticalLane === 'heartbeat' || options.criticalLane === 'ace'
        ? options.criticalLane
        : undefined;
    const expectReply = options.expectReply !== false;
    // 班次由「显式 requestClass > priority 兼容映射 > 调度器注入的环境班次 > 前台」决定。
    const requestClass: RequestClass = resolveRequestClass(
        { priority: options.priority, requestClass: options.requestClass, criticalLane },
        getAmbientRequestClass(),
    );

    // 一轮只读一次组数据再分发：活动自动化一轮里，奶茶/宠物/七夕/天气等模块
    // 反复读同一份 GetGroup / Bag，这里按「服务+方法+请求体」合并成一次。
    // 写操作成功后由活动服务（milk-tea / share-reward）与活动自动化 op 层作废本轮快照。
    if (isInActivityRound() && isActivityRoundRead(serviceName, methodName)) {
        const key = `net:read:${serviceName}.${methodName}:${bodyBytes.toString('base64')}`;
        return readActivityRound(key, dispatch);
    }
    return dispatch();

    function dispatch(): Promise<{ body: Buffer; meta: any }> {
        return new Promise((resolve, reject) => {
        const context = currentConnection;
        if (!context || !isCurrentConnection(context) || context.socket.readyState !== WebSocket.OPEN) {
            reject(new Error(`连接未打开：${methodName}`));
            return;
        }
        if (context.phase !== 'online') {
            reject(new Error(`账号尚未登录：${methodName}`));
            return;
        }

        // 流量保险丝只约束自动任务：前台（用户点击）与心跳/ACE 永远放行。
        // 自动任务超额时按「网关闭塞」处理，让既有的退避逻辑接管而不是死等超时；
        // 上限随网关健康度自适应，网关卡住时会自动收紧到几乎停摆。
        const budget = checkRequestBudget(serviceName, methodName, Date.now(), {
            requestClass,
            health: {
                ...getGatewayLoad(),
                inboundSilenceMs: getInboundSilenceMs(),
            },
        });
        if (!budget.allowed) {
            const nowMono = performance.now();
            if (nowMono - lastBudgetLogAt >= BUDGET_LOG_INTERVAL_MS) {
                lastBudgetLogAt = nowMono;
                const stats = getGovernorStats();
                const top = Array.isArray(stats.topMethods) && stats.topMethods.length > 0
                    ? `，大头：${stats.topMethods.slice(0, 3).map((item: any) => `${shortMethod(item.method)}×${item.count}`).join(' ')}`
                    : '';
                logWarn(
                    '系统',
                    `自动任务请求已达流量上限，本轮让路：${methodName}（原因=${describeBudgetReasonZh(budget.reason)}，`
                    + `模式=${describeFlowModeZh(budget.mode)}，60 秒内已发 ${stats.sentInWindow}/${stats.totalLimit}，`
                    + `累计让路 ${stats.droppedTotal}${top}）`,
                );
            }
            reject(new GatewayBusyError(
                `自动任务请求已达流量上限，已让路：${methodName}（原因=${describeBudgetReasonZh(budget.reason)}，`
                + `模式=${describeFlowModeZh(budget.mode)}，${formatDurationZh(budget.retryAfterMs)}后可重试）`,
                budget.retryAfterMs,
            ));
            return;
        }

        // 每个班次有独立的排队配额：后台任务把自己的配额排满，也不会占掉前台/心跳的名额。
        if (isClassQueueFull(requestQueue, requestClass)) {
            reject(new Error(
                `请求等待队列已满：${methodName}（班次=${describeRequestClassLabel({ requestClass, criticalLane })}，`
                + `上限=${maxQueuedForClass(requestClass)} 个，`
                + `${formatGatewayCounts(pendingCallbacks.size, requestQueue.length)}）`,
            ));
            return;
        }

        const requestId = nextRequestId++;
        const request: QueuedRequest = {
            context,
            serviceName,
            methodName,
            bodyBytes,
            expectedErrorCodes,
            resolve,
            reject,
            timeoutKey: `request_timeout_${requestId}`,
            queueWaitKey: `request_queue_wait_${requestId}`,
            seq: null,
            settled: false,
            requestClass,
            criticalLane,
            enqueuedAt: performance.now(),
            expectReply,
            beforeSend: options.beforeSend,
            onSent: options.onSent,
        };
        requestQueue.push(request);
        networkScheduler.setTimeoutTask(request.timeoutKey, timeoutMs, () => {
            if (request.seq !== null) pendingCallbacks.delete(request.seq);
            const index = requestQueue.indexOf(request);
            if (index >= 0) requestQueue.splice(index, 1);
            const stage = request.seq === null ? 'queued' : 'pending';
            const stageText = stage === 'queued' ? '尚未排到连接' : '已发往网关但未回包';
            settleQueuedRequest(request, new Error(
                `请求超时：${methodName}（${stageText}；`
                + `${formatGatewayCounts(pendingCallbacks.size, requestQueue.length)}`
                + `${formatInflightSegment(describePendingRequests(), pendingCallbacks.size)}）`,
            ));
            drainRequestQueue();
        });
        if (requestClass === 'background') {
            // background 是「后台补数据」：拿不到空闲槽位就早点让路，而不是一路熬到请求超时——
            // 熬着既拖长队列，也会给调用方刷一堆看着像故障的超时日志。
            const queueWaitMs = Math.min(timeoutMs, LOW_PRIORITY_QUEUE_WAIT_MS);
            networkScheduler.setTimeoutTask(request.queueWaitKey, queueWaitMs, () => {
                if (request.settled || request.seq !== null) return;
                const index = requestQueue.indexOf(request);
                if (index >= 0) requestQueue.splice(index, 1);
                settleQueuedRequest(request, new GatewayBusyError(
                    `网关繁忙，后台请求已让路：${methodName}（已等待 ${formatDurationZh(queueWaitMs)}；`
                    + `${formatGatewayCounts(pendingCallbacks.size, requestQueue.length)}`
                    + `${formatInflightSegment(describePendingRequests(), pendingCallbacks.size)}）`,
                    Math.min(5000, LOW_PRIORITY_QUEUE_WAIT_MS),
                ));
            });
        }
        drainRequestQueue();
        logRequestPressure();
    });
    }
}

async function sendMsgNoReply(serviceName: string, methodName: string, bodyBytes: Buffer): Promise<void> {
    // 即使调用方不需要回包，也必须经过同一调度器，不能绕过心跳/ACE保护和并发上限。
    // 不写死班次，交给环境班次判定：后台任务发的通知不该被当成前台流量。
    await sendMsgAsync(serviceName, methodName, bodyBytes, { expectReply: false });
}

// ============ 消息处理 ============
function handleMessage(data: Buffer): void {
    try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const msg = types.GateMessage.decode(buf);
        lastInboundMono = performance.now();
        const meta = msg.meta;
        if (!meta) return;

        if (meta.server_seq) {
            const seq = toNum(meta.server_seq);
            if (seq > serverSeq) serverSeq = seq;
        }

        const msgType = meta.message_type;

        // Notify
        if (msgType === 3) {
            handleNotify(msg);
            return;
        }

        // Response
        if (msgType === 2) {
            const errorCode = toNum(meta.error_code);
            const clientSeqVal = toNum(meta.client_seq);

            const pending = pendingCallbacks.get(clientSeqVal);
            const expectedError = !!pending && pending.expectedErrorCodes.has(errorCode);
            if (errorCode !== 0 && !expectedError) {
                logWarn('错误', `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`);
            }
            // 画像：失败量与业务错误码无关，只用来定位「谁在吃预算 / 谁在报错」。
            try { recordRequestOutcome(meta.service_name, meta.method_name, errorCode === 0); } catch {}

            if (pending) {
                pendingCallbacks.delete(clientSeqVal);
                if (errorCode !== 0) {
                    invokePendingCallback(pending.callback, new GatewayError(meta));
                } else {
                    if ((meta.service_name === 'gamepb.plantpb.PlantService' && meta.method_name !== 'AllLands')
                        || (meta.service_name === 'gamepb.itempb.ItemService' && meta.method_name === 'Use')) {
                        invalidateLandForecast();
                        // 写操作成功后自家地块快照作废：下一次读取必须是新数据，
                        // 避免 TTL 快照把「刚收完的地」又读成「还没收」。
                        networkEvents.emit('landsDirty', meta.method_name);
                    }
                    invokePendingCallback(pending.callback, null, msg.body, meta);
                }
                
            }
        }
    } catch (err: any) {
        logWarn('解码', err.message);
    }
}

function handleNotify(msg: any): void {
    if (!msg.body || msg.body.length === 0) return;
    try {
        const event = types.EventMessage.decode(msg.body);
        const type = event.message_type || '';
        const eventBody = event.body;

        // 被踢下线
        if (type.includes('Kickout')) {
            log('推送', `被踢下线! ${type}`);
            try {
                const notify = types.KickoutNotify.decode(eventBody);
                const reasonCode = toNum(notify.reason);
                const diagnostics = getConnectionDiagnostics(currentConnection);
                log('推送', `原因: ${notify.reason_message || '未知'} (${reasonCode})`, { reasonCode, diagnostics });
                networkEvents.emit('kickout', {
                    type,
                    reason: notify.reason_message || '未知',
                    reasonCode,
                    diagnostics,
                });
            } catch {}
            return;
        }

        // 土地状态变化
        if (type.includes('LandsNotify')) {
            try {
                const notify = types.LandsNotify.decode(eventBody);
                const hostGid = toNum(notify.host_gid);
                const lands = notify.lands || [];
                if (lands.length > 0) {
                    if (hostGid === userState.gid || hostGid === 0) {
                        invalidateLandForecast();
                        networkEvents.emit('landsChanged', lands);
                    }
                }
            } catch {}
            return;
        }

        // 青蛙等农场级社交事件变化。与乌云不同，它不附着在 LandInfo 上。
        if (type.includes('FarmSocialEventsNotify')) {
            try {
                const notify = types.FarmSocialEventsNotify.decode(eventBody);
                const hostGid = toNum(notify.host_gid);
                if (hostGid === userState.gid || hostGid === 0) {
                    networkEvents.emit('farmSocialEventsChanged', notify.social_events || []);
                }
            } catch {}
            return;
        }

        // 特殊天气变化。通知携带天气所属农场 GID；空 weather 表示天气结束。
        if (type.includes('WeatherChangeNotify')) {
            try {
                const notify = types.WeatherChangeNotify.decode(eventBody);
                networkEvents.emit('weatherChanged', {
                    hostGid: toNum(notify.host_gid),
                    weather: notify.weather || null,
                });
            } catch {}
            return;
        }

        // 护主犬“同气连枝”主人侧待拾取礼包数量。
        if (type.includes('PendingGiftCountNotify')) {
            try {
                const notify = types.PendingGiftCountNotify.decode(eventBody);
                networkEvents.emit('dogSkillGiftPending', Math.max(0, toNum(notify.count)));
            } catch {}
            return;
        }

        // 守护日志新增通知的真实事件体为空，仅作为失效信号使用。
        if (type.includes('NewProtectLogNotify')) {
            networkEvents.emit('dogProtectLogChanged');
            return;
        }

        // 牧场设施变更（21 级棚待激活等）：只处理自己的设施通知。
        // 牧场集市轮换（上游集市即时唤醒）：开门 / 关门 / 换批时通知牧场例程。
        if (type === 'gamepb.shoppb.RotationShopNotify') {
            const rotation = types.RanchRotationShopNotify.decode(eventBody).shops.find((shop: any) => toNum(shop.shop_id) === 7);
            if (rotation) networkEvents.emit('ranchMarketVisitChanged', rotation);
            return;
        }

        if (type === 'gamepb.homesteadpb.FacilitiesNotify') {
            const notify = types.RanchFacilitiesNotify.decode(eventBody);
            const hostGid = toNum(notify.host_gid);
            if (hostGid > 0 && hostGid === userState.gid) networkEvents.emit('ranchFacilitiesChanged', notify.facilities);
            return;
        }

        // 物品变化通知
        if (type.includes('ItemNotify')) {
            try {
                const notify = types.ItemNotify.decode(eventBody);
                const items = notify.items || [];
                for (const itemChg of items) {
                    const item = itemChg.item;
                    if (!item) continue;
                    const id = toNum(item.id);
                    const count = toNum(item.count);
                    const delta = toNum(itemChg.delta);

                    if (id === 1101) {
                        if (count > 0) userState.exp = count;
                        else if (delta !== 0) userState.exp = Math.max(0, Number(userState.exp || 0) + delta);
                        updateStatusLevel(userState.level, userState.exp);
                    } else if (id === 1 || id === 1001) {
                        if (count > 0) {
                            userState.gold = count;
                        } else if (delta !== 0) {
                            userState.gold = Math.max(0, Number(userState.gold || 0) + delta);
                        }
                        updateStatusGold(userState.gold);
                    } else if (id === 1002) {
                        if (count > 0) {
                            userState.coupon = count;
                        } else if (delta !== 0) {
                            userState.coupon = Math.max(0, Number(userState.coupon || 0) + delta);
                        }
                    } else if ((id === 7002 || id === 1008) && delta > 0) {
                        // 集市货币到账后唤醒牧场例程，按最新余额和报价兑换（上游集市即时唤醒）。
                        networkEvents.emit('ranchMarketStockReady', { id, count, delta });
                    } else if (id === 1005) {
                        if (count > 0) {
                            userState.goldBean = count;
                        } else if (delta !== 0) {
                            userState.goldBean = Math.max(0, Number(userState.goldBean || 0) + delta);
                        }
                    }
                }
            } catch {}
            return;
        }

        // 基本信息变化
        if (type.includes('BasicNotify')) {
            try {
                const notify = types.BasicNotify.decode(eventBody);
                if (notify.basic) {
                    if (hasOwn(notify.basic, 'share_infos')) applyShareInfos(notify.basic.share_infos);
                    const oldLevel = userState.level;
                    if (hasOwn(notify.basic, 'level')) {
                        const nextLevel = toNum(notify.basic.level);
                        if (Number.isFinite(nextLevel) && nextLevel > 0) userState.level = nextLevel;
                    }
                    let shouldUpdateGoldView = false;
                    if (hasOwn(notify.basic, 'gold')) {
                        const nextGold = toNum(notify.basic.gold);
                        if (Number.isFinite(nextGold) && nextGold >= 0) {
                            userState.gold = nextGold;
                            shouldUpdateGoldView = true;
                        }
                    }
                    if (hasOwn(notify.basic, 'exp')) {
                        const exp = toNum(notify.basic.exp);
                        if (Number.isFinite(exp) && exp >= 0) {
                            userState.exp = exp;
                            updateStatusLevel(userState.level, exp);
                        }
                    }
                    if (shouldUpdateGoldView) {
                        updateStatusGold(userState.gold);
                    }
                    if (userState.level !== oldLevel) {
                        recordOperation('levelUp', 1);
                    }
                }
            } catch {}
            return;
        }

        // 好友申请通知
        if (type.includes('FriendApplicationReceivedNotify')) {
            try {
                const notify = types.FriendApplicationReceivedNotify.decode(eventBody);
                const applications = notify.applications || [];
                if (applications.length > 0) {
                    networkEvents.emit('friendApplicationReceived', applications);
                }
            } catch {}
            return;
        }

        // 好友添加成功通知
        if (type.includes('FriendAddedNotify')) {
            try {
                const notify = types.FriendAddedNotify.decode(eventBody);
                const friends = notify.friends || [];
                if (friends.length > 0) {
                    const names = friends.map((f: any) => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
                    log('好友', `新好友: ${names}`);
                }
            } catch {}
            return;
        }

        if (type.includes('GlobalSceneUnlockNotify')) {
            const notify = types.GlobalSceneUnlockNotify.decode(eventBody);
            userState.unlockedSceneIds = [...new Set([...userState.unlockedSceneIds, ...notify.unlocked_scenes])];
            return;
        }

        // 商品解锁通知
        if (type.includes('GoodsUnlockNotify')) {
            try {
                const notify = types.GoodsUnlockNotify.decode(eventBody);
                const goods = notify.goods_list || [];
                if (goods.length > 0) {
                    networkEvents.emit('goodsUnlockNotify', goods);
                }
            } catch {}
            return;
        }

        // 任务状态变化通知
        if (type.includes('TaskInfoNotify')) {
            try {
                const notify = types.TaskInfoNotify.decode(eventBody);
                if (notify.task_info) {
                    networkEvents.emit('taskInfoNotify', notify.task_info, { globalSceneId: userState.globalSceneId });
                }
            } catch {}
            return;
        }

        // VIP信息更新通知
        if (type.includes('VipInfoUpdatedNTF')) {
            try {
                const notify = types.VipInfoUpdatedNTF.decode(eventBody);
                networkEvents.emit('vipInfoUpdated', notify);
            } catch {}
            return;
        }

        // 商城需求通知
        if (type.includes('NeedNotify')) {
            try {
                const notify = types.NeedNotify.decode(eventBody);
                networkEvents.emit('mallNeedNotify', notify);
            } catch {}
            return;
        }

        // 商品变更通知
        if (type.includes('ProductsHasChangedNotify')) {
            try {
                const notify = types.ProductsHasChangedNotify.decode(eventBody);
                networkEvents.emit('productsChanged', notify);
            } catch {}
            return;
        }

        // 活动变更通知
        if (type.includes('ActiviesChangeNotify')) {
            try {
                const notify = types.ActiviesChangeNotify.decode(eventBody);
                networkEvents.emit('activitiesChanged', notify);
            } catch {}
            return;
        }

        // 头像框红点通知
        if (type.includes('AvatarFrameRedDotNotify')) {
            try {
                networkEvents.emit('avatarFrameRedDot');
            } catch {}
            return;
        }

        // 图鉴奖励红点通知
        if (type.includes('IllustratedRewardRedDotNotifyV2')) {
            try {
                const notify = types.IllustratedRewardRedDotNotifyV2.decode(eventBody);
                networkEvents.emit('illustratedRewardRedDot', notify);
                networkEvents.emit('ranchBookReward', 'normal', notify.ranch_reward_available);
            } catch {}
            return;
        }

        // 充值信息变更通知
        if (type.includes('RechargeInfoNotify')) {
            try {
                const notify = types.RechargeInfoNotify.decode(eventBody);
                networkEvents.emit('rechargeInfoChanged', notify);
            } catch {}
            return;
        }

        // 公告板变更通知
        if (type.includes('BulletinListChangedNTF')) {
            try {
                const notify = types.BulletinListChangedNTF.decode(eventBody);
                networkEvents.emit('bulletinListChanged', notify);
            } catch {}
            return;
        }

        // 皮肤变更通知
        if (type.includes('SkinChangeNotify')) {
            try {
                const notify = types.SkinChangeNotify.decode(eventBody);
                networkEvents.emit('skinChanged', notify);
            } catch {}
            
        }
    } catch (e: any) {
        logWarn('推送', `解码失败: ${e.message}`);
    }
}

// ============ 登录 ============
// QQ and WeChat 1.15 both authenticate the player before entering a farm scene.
// Historical versions retain their single-stage Login wire layout.
function usesPlayerSceneLogin(clientVersion = getClientVersion()): boolean {
    const version = /^(\d+)\.(\d+)/.exec(clientVersion);
    return !!version && (Number(version[1]) > 1 || (Number(version[1]) === 1 && Number(version[2]) >= 15));
}

function buildLoginBody(clientVersion = getClientVersion()): Buffer {
    const modern = usesPlayerSceneLogin(clientVersion);
    const requestType = modern ? types.PlayerLoginRequest : types.LoginRequest;
    return Buffer.from(requestType.encode(requestType.create({
        sharer_id: toLong(0),
        sharer_open_id: '',
        device_info: getLoginDeviceInfo(clientVersion),
        share_cfg_id: toLong(0),
        // A standalone WeChat Code does not supply its entry-dependent launch scene.
        scene_id: isWechatPlatform() ? undefined : '1234567',
        report_data: {
            ...(modern ? {} : { callback: '', cd_extend_info: '', click_id: '', clue_token: '', req_id: '', trackid: '' }),
            minigame_channel: isWechatPlatform() ? 'other' : 'other-qq',
            minigame_platid: 2,
        },
        ...(modern ? { share_key: '', game_scene_id: 1 } : { extra: Buffer.alloc(0) }),
    })).finish());
}

async function sendLogin(context: ConnectionContext, onLoginSuccess?: () => void | Promise<void>): Promise<void> {
    const modern = usesPlayerSceneLogin(context.clientVersion);
    const body = buildLoginBody(context.clientVersion);
    await sendMsg(context, 'gamepb.userpb.UserService', modern ? 'PlayerLogin' : 'Login', body, {
        expectedErrorCodes: new Set(),
        // 登录不走排队器（此时还没 online），按保命流量记账。
        requestClass: 'critical',
        callback: async (err, bodyBytes, _meta) => {
        if (!isCurrentConnection(context)) return;
        if (err) {
            log('登录', `失败: ${err.message}`);
            if (err.message.includes('code=')) {
                // 一次性 Code 被拒（已被消费 / 过期 / 版本不符）时不要把进程直接杀掉：
                // 走正常的断线收尾，让主进程拿到 account_disconnected，按平台补 Code 后重登。
                log('系统', '账号验证失败，交由主进程补 Code 后重试登录...');
            }
            finalizeConnection(context, { source: 'login_failed', reason: err.message });
            try { (context.socket as any).terminate(); } catch {}
            return;
        }

        let reply: any;
        try {
            reply = (modern ? types.PlayerLoginReply : types.LoginReply).decode(bodyBytes!);
        } catch (e: any) {
            // 畸形回包不会有第二次：只 return 会让连接停在 phase='login'，
            // 干等 20 秒的 login_timeout 才断开。走正常断线收尾让主进程立即补 Code 重登。
            logWarn('登录', `解码失败: ${e.message}`);
            finalizeConnection(context, { source: 'login_failed', reason: `登录回包解码失败: ${e.message}` });
            try { (context.socket as any).terminate(); } catch {}
            return;
        }
        if (!reply.basic) {
            logWarn('登录', '失败: 登录响应缺少账号信息');
            finalizeConnection(context, { source: 'login_failed', reason: '登录响应缺少账号信息' });
            try { (context.socket as any).terminate(); } catch {}
            return;
        }

        clearWsErrorState();
        userState.gid = toNum(reply.basic.gid);
        userState.name = reply.basic.name || '未知';
        userState.level = toNum(reply.basic.level);
        userState.gold = toNum(reply.basic.gold);
        userState.exp = toNum(reply.basic.exp);
        userState.openId = String(reply.basic.open_id || '').trim();
        userState.avatarUrl = String(reply.basic.avatar_url || '').trim();
        userState.unlockedSceneIds = modern ? (reply.unlocked_scene_ids || []).map(toNum) : [1];
        shareInfoState.clear();
        applyShareInfos(reply.basic.share_infos);

        updateStatusFromLogin({
            name: userState.name,
            level: userState.level,
            gold: userState.gold,
            exp: userState.exp,
            avatarUrl: userState.avatarUrl,
        });

        log('系统', `登录成功: ${userState.name} (Lv${userState.level})`);

        if (context.loginInitialized) return;
        context.loginInitialized = true;

        console.warn('');
        console.warn('========== 登录成功 ==========');
        console.warn(`  GID:    ${userState.gid}`);
        console.warn(`  昵称:   ${userState.name}`);
        console.warn(`  等级:   ${userState.level}`);
        console.warn(`  金币:   ${userState.gold}`);
        if (reply.time_now_millis) {
            syncServerTime(toNum(reply.time_now_millis));
            console.warn(`  时间:   ${new Date(toNum(reply.time_now_millis)).toLocaleString()}`);
        }
        console.warn('===============================');
        console.warn('');

        try {
            if (userState.openId && !isHostTransportEnabled()) {
                await cryptoWasm.bindUser(userState.openId);
                const initTokenLength = gatewayTokens.stageInitToken(cryptoWasm.getEncryptedInitInfo());
                if (initTokenLength > 0) {
                    log('ACE', `TSDK 初始化凭据已就绪: ${initTokenLength} 字符，将随下一条请求发送`);
                }
            }
            if (!isCurrentConnection(context)) return;
            networkScheduler.clear('login_timeout');
            context.phase = 'online';
            context.onlineMono = performance.now();
            if (isHostTransportEnabled()) {
                // 心跳 / ACE（TSDK）都在宿主：把会话参数交过去，由宿主接管。
                // 这样 worker 重启时连接、心跳、反作弊数据流都不中断。
                try {
                    hostState.client?.sendSession({
                        gid: userState.gid,
                        openId: userState.openId,
                        clientVersion: context.clientVersion,
                        heartbeatInterval: CONFIG.heartbeatInterval,
                        // 会话快照：热重启后新 worker 不必重新登录也能还原昵称/等级/场景。
                        state: buildHostSessionSnapshot(),
                    });
                } catch (error: any) {
                    logWarn('系统', `同步会话到宿主失败: ${error?.message || error}`);
                }
                startHostStateSync(context);
                // 心跳仍由 worker 驱动：网关对 client_seq 的连续性敏感，
                // worker 在线时就让它按自己的序号发；只有 worker 不在（热重启窗口）宿主才接管。
                startHeartbeat(context);
            } else {
                startAceRuntime((service: string, method: string, body: Buffer, timeoutMs?: number) => (
                    sendMsgAsync(service, method, body, { timeoutMs, priority: 'high', criticalLane: 'ace' })
                ));
                startHeartbeat(context);
            }
            // 登录引导阶段串行完成普通请求，避免和后续活动、背包初始化同时挤入 Gateway。
            await fetchUserSettings();
            if (!isCurrentConnection(context)) return;
            if (modern) {
                try {
                    await loginGameScene(1);
                } catch (e: any) {
                    const message = String((e && e.message) || e);
                    // 只有「请求超时」是可重试的瞬时故障：此时 phase 已 online、心跳与 ACE
                    // 都已启动，掐掉这条健康连接会形成「登录成功→立即断开→重登」死循环。
                    // 协议级错误（回包不完整 / 解码失败 / 连接被替换）仍交给外层 catch
                    // 按登录失败收尾，不能让不完整场景数据带进农场自动化。
                    if (!/超时|timeout|ETIMEDOUT/i.test(message)) throw e;
                    logWarn('登录', `场景登录请求超时（不影响在线状态）: ${message}`);
                }
                if (!isCurrentConnection(context)) return;
            }
            if (onLoginSuccess) await onLoginSuccess();
        } catch (e: any) {
            logWarn('登录', `登录初始化失败: ${e.message}`);
            finalizeConnection(context, {
                source: 'login_init_failed',
                reason: e.message,
            });
            try { (context.socket as any).terminate(); } catch {}
        }
        },
    }, 'critical');
}

// ============ 心跳 ============
/**
 * 心跳是几十字节的小包。官方客户端回包在秒级，20s 才判失败会白白拖长故障感知：
 * 一次 tick（25s）+ 20s 超时 = 45s 才记一次 miss，三次就是 95s 才肯下线。
 * 收到 8s 仍未回包，基本可以认定这条连接已经不收发了。
 */
const HEARTBEAT_REQUEST_TIMEOUT = 8000;
/**
 * 首次漏拍后的快速补发延迟。
 *
 * 原来的节奏：25s tick + 8s 超时 = 一次 miss 要 33s，三次就是 90s+ 才肯下线，
 * 期间所有自动任务都会被「心跳漏拍」闸门压住。而实际上单次丢包/抖动很常见，
 * 补发一次就能恢复，不必等到下一个 tick。补发仍失败才进入正常的 miss 计数。
 */
const HEARTBEAT_RETRY_DELAY = 3000;

function buildHeartbeatBody(gid: number, clientVersion = getClientVersion()): Buffer {
    return Buffer.from(types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
        gid: toLong(gid),
        client_version: clientVersion,
        field_3: toLong(0),
    })).finish());
}

function startHeartbeat(context: ConnectionContext): void {
    networkScheduler.clear('heartbeat_interval');
    networkScheduler.clear('heartbeat_retry');
    const heartbeat = { attempts: 0, replies: 0, failures: 0 };
    context.heartbeat = heartbeat;
    lastHeartbeatMono = performance.now();
    lastInboundMono = performance.now();
    heartbeatMissCount = 0;
    let inFlight = false;

    const beat = async (isRetry: boolean): Promise<void> => {
        if (inFlight) return;
        if (!isCurrentConnection(context) || context.phase !== 'online' || !userState.gid) return;
        inFlight = true;
        const body = buildHeartbeatBody(userState.gid, context.clientVersion);
        heartbeat.attempts += 1;
        try {
            const { body: replyBody } = await sendMsgAsync(
                'gamepb.userpb.UserService',
                'Heartbeat',
                body,
                { timeoutMs: HEARTBEAT_REQUEST_TIMEOUT, priority: 'high', criticalLane: 'heartbeat' },
            );
            if (!isCurrentConnection(context)) return;
            heartbeat.replies += 1;
            lastHeartbeatMono = performance.now();
            heartbeatMissCount = 0;
            networkScheduler.clear('heartbeat_retry');
            try {
                const reply = types.HeartbeatReply.decode(replyBody);
                if (reply.server_time) syncServerTime(toNum(reply.server_time));
            } catch {}
        } catch {
            if (!isCurrentConnection(context)) return;
            heartbeat.failures += 1;
            heartbeatMissCount += 1;

            // 第一次漏拍先快速补发：抖动通常补一次就好，补发成功则一切归零。
            if (heartbeatMissCount === 1 && !isRetry) {
                logWarn('心跳', `心跳未响应，${Math.round(HEARTBEAT_RETRY_DELAY / 1000)} 秒后补发一次`);
                networkScheduler.setTimeoutTask('heartbeat_retry', HEARTBEAT_RETRY_DELAY, () => { void beat(true); });
                return;
            }

            const now = performance.now();
            const inboundSilenceMs = Math.max(0, now - lastInboundMono);
            const heartbeatSilenceMs = Math.max(0, now - lastHeartbeatMono);
            logWarn(
                '心跳',
                `心跳未响应（漏拍 ${heartbeatMissCount}/${MAX_HEARTBEAT_MISSES}，`
                + `距上次心跳 ${Math.round(heartbeatSilenceMs / 1000)} 秒，`
                + `连接无入站数据 ${Math.round(inboundSilenceMs / 1000)} 秒，`
                + `${formatGatewayCounts(pendingCallbacks.size, requestQueue.length)}`
                + `${formatInflightSegment(describePendingRequests(), pendingCallbacks.size)}）`,
            );
            if (!shouldTerminateForHeartbeat(heartbeatMissCount, inboundSilenceMs)
                && !shouldTerminateForSilence(heartbeatMissCount, inboundSilenceMs)) return;

            log('心跳', `连续心跳超时且连接无入站数据，账号将停止运行（漏拍 ${heartbeatMissCount} 次，静默 ${Math.round(inboundSilenceMs / 1000)} 秒）...`);
            finalizeConnection(context, {
                source: 'heartbeat_timeout',
                reason: `${Math.round(inboundSilenceMs / 1000)} 秒无入站数据，连续 ${heartbeatMissCount} 次心跳失败`,
            });
            try { (context.socket as any).terminate(); } catch {}
        } finally {
            inFlight = false;
        }
    };

    networkScheduler.setIntervalTask('heartbeat_interval', CONFIG.heartbeatInterval, () => beat(false), { preventOverlap: true });
}

interface DisconnectDetails {
    source: string;
    code?: number;
    reason?: string;
}

function clearNetworkRuntime(reason: string): void {
    rejectAllQueuedRequests(`请求已中断：${reason}`);
    rejectAllPendingRequests(`请求已中断：${reason}`);
    networkScheduler.clearAll();
    stopAceRuntime(true);
    gatewayTokens.clear();
    invalidateLandForecast();
    stopHostStateSync();
    networkEvents.emit('landsDirty', 'runtime_reset');
    userState.gid = 0;
    userState.openId = '';
}

function getConnectionDiagnostics(context: ConnectionContext | null) {
    return {
        platform: CONFIG.platform,
        clientVersion: context?.clientVersion || getClientVersion(),
        connectionAgeMs: context?.startedMono !== undefined ? Math.max(0, performance.now() - context.startedMono) : 0,
        onlineAgeMs: context?.onlineMono !== undefined ? Math.max(0, performance.now() - context.onlineMono) : 0,
        heartbeat: context?.heartbeat ? { ...context.heartbeat } : null,
        ...getGatewayLoad(),
        lastInboundAgeMs: Math.max(0, performance.now() - lastInboundMono),
        lastHeartbeatAgeMs: Math.max(0, performance.now() - lastHeartbeatMono),
        heartbeatMissCount,
        requestBudget: getGovernorStats(Date.now(), {
            ...getGatewayLoad(),
            inboundSilenceMs: Math.max(0, performance.now() - lastInboundMono),
        }),
        pendingRequests: describePendingRequests(),
        queuedRequests: describeQueuedRequests(),
        ace: context?.phase === 'online' ? getAceDiagnostics() : null,
        tsdk: cryptoWasm.getDiagnostics(),
    };
}

function finalizeConnection(context: ConnectionContext, details: DisconnectDetails): void {
    if (context.finalized) return;
    context.finalized = true;
    const wasCurrent = currentConnection === context;
    const wasLoginReady = context.phase === 'online';
    // Snapshot before cleanup destroys TSDK state and clears request queues.
    const diagnostics = getConnectionDiagnostics(context);
    if (wasCurrent) {
        log('连接', '会话结束', {
            event: 'connection_summary',
            connectionId: context.id,
            source: details.source,
            disconnectCode: Number(details.code) || 0,
            phase: context.phase,
            intentionalClose: context.intentionalClose,
            diagnostics,
        });
        currentConnection = null;
        ws = null;
        clearNetworkRuntime(details.reason || details.source);
    }
    if (!wasCurrent || context.intentionalClose) return;
    networkEvents.emit('disconnected', {
        connectionId: context.id,
        source: details.source,
        code: Number(details.code) || 0,
        reason: details.reason || '',
        phase: context.phase,
        wasLoginReady,
        diagnostics,
        at: Date.now(),
    });
}

// ============ WebSocket 连接 ============
// ==================== 连接宿主（host）远程传输模式 ====================
//
// 开关：FARM_SOCKET_HOST=1 + FARM_HOST_PIPE + FARM_HOST_TOKEN（由主进程 fork 宿主时注入）。
// 开启后：
//   - WS 连接、心跳、上行加密（TSDK）、ACE 全部在宿主进程里，worker 只管业务；
//   - worker 重启（热更新）时宿主保持连接与心跳，新 worker attach 后可直接复用会话；
//   - 业务 proto / 调度 / 配置 / 数据 / UI 的变更不再导致掉线。
// 关闭（默认）时保持原有「worker 内直连」行为，完全不改现有部署。

function isHostTransportEnabled(): boolean {
    return String(process.env.FARM_SOCKET_HOST || '') === '1'
        && !!String(process.env.FARM_HOST_PIPE || '')
        && !!String(process.env.FARM_HOST_TOKEN || '');
}

/** 会话快照：宿主只存不解析，worker 热重启时原样回填，避免「记得住 gid、忘了昵称/场景」。 */
function buildHostSessionSnapshot(): any {
    return {
        name: userState.name,
        level: userState.level,
        gold: userState.gold,
        exp: userState.exp,
        coupon: userState.coupon,
        goldBean: userState.goldBean,
        avatarUrl: userState.avatarUrl,
        globalSceneId: userState.globalSceneId,
        unlockedSceneIds: Array.isArray(userState.unlockedSceneIds) ? [...userState.unlockedSceneIds] : [],
        serverTime: getServerTimeSec() * 1000,
        at: Date.now(),
    };
}

/** 把宿主回报的会话快照回填到 userState：字段缺失时保持默认值，不能把 0 当权威。 */
function applyHostSession(session: any): void {
    if (!session) return;
    const gid = toNum(session.gid);
    if (gid > 0) userState.gid = gid;
    if (session.openId) userState.openId = String(session.openId);
    const state = session.state;
    if (!state || typeof state !== 'object') return;
    if (state.name) userState.name = String(state.name);
    if (toNum(state.level) > 0) userState.level = toNum(state.level);
    if (Number.isFinite(Number(state.gold))) userState.gold = toNum(state.gold);
    if (Number.isFinite(Number(state.exp))) userState.exp = toNum(state.exp);
    if (Number.isFinite(Number(state.coupon))) userState.coupon = toNum(state.coupon);
    if (Number.isFinite(Number(state.goldBean))) userState.goldBean = toNum(state.goldBean);
    if (state.avatarUrl) userState.avatarUrl = String(state.avatarUrl);
    if (toNum(state.globalSceneId) > 0) userState.globalSceneId = toNum(state.globalSceneId);
    if (Array.isArray(state.unlockedSceneIds) && state.unlockedSceneIds.length) {
        const scenes: number[] = [];
        for (const raw of state.unlockedSceneIds as any[]) {
            const id = toNum(raw);
            if (id > 0 && !scenes.includes(id)) scenes.push(id);
        }
        if (scenes.length) userState.unlockedSceneIds = scenes;
    }
    if (toNum(state.serverTime) > 0) syncServerTime(toNum(state.serverTime));
    if (userState.name) {
        updateStatusFromLogin({
            name: userState.name,
            level: userState.level,
            gold: userState.gold,
            exp: userState.exp,
            avatarUrl: userState.avatarUrl,
        });
    }
}

/** 定期把 userState 的变化推给宿主：等级/场景解锁变化后，热重启回填的就不是旧值。 */
function startHostStateSync(context: ConnectionContext): void {
    stopHostStateSync();
    const push = (): void => {
        if (!isCurrentConnection(context) || !hostState.client) return;
        try {
            const snapshot = buildHostSessionSnapshot();
            const json = JSON.stringify({ ...snapshot, at: 0 });
            if (json === hostState.lastStateJson) return;
            hostState.lastStateJson = json;
            hostState.client.updateSessionState(snapshot);
        } catch {}
    };
    push();
    hostState.stateTimer = setInterval(push, 30000);
    hostState.stateTimer.unref?.();
}

function stopHostStateSync(): void {
    if (hostState.stateTimer) clearInterval(hostState.stateTimer);
    hostState.stateTimer = null;
    hostState.lastStateJson = '';
}

/**
 * 伪 WebSocket：只为让 connect() 里既有逻辑（readyState 判断 / 事件绑定 / terminate）成立。
 * 真正的字节收发都在宿主，所以 send() 直接抛错——remote 分支不会走到它。
 */
class HostSocketAdapter {
    readyState: number = 0;
    binaryType: string = 'arraybuffer';
    private listeners: Map<string, Array<(...args: any[]) => void>> = new Map();

    on(event: string, handler: (...args: any[]) => void): this {
        const list = this.listeners.get(event) || [];
        list.push(handler);
        this.listeners.set(event, list);
        return this;
    }

    once(event: string, handler: (...args: any[]) => void): this {
        const wrapper = (...args: any[]) => {
            this.off(event, wrapper);
            handler(...args);
        };
        return this.on(event, wrapper);
    }

    off(event: string, handler: (...args: any[]) => void): this {
        const list = this.listeners.get(event);
        if (!list) return this;
        this.listeners.set(event, list.filter(item => item !== handler));
        return this;
    }

    emit(event: string, ...args: any[]): void {
        for (const handler of [...(this.listeners.get(event) || [])]) {
            try { handler(...args); } catch (error: any) { logWarn('系统', `宿主事件处理失败(${event}): ${error?.message || error}`); }
        }
    }

    send(): void {
        throw new Error('远程传输模式下不应直接写 socket');
    }

    terminate(): void {
        this.readyState = 3;
        // 只关管道会把网关连接留成孤儿：先让宿主关掉游戏连接，再断开管道。
        try { hostState.client?.requestGatewayClose(); } catch {}
        try { hostState.client?.detach(); } catch {}
        this.emit('close', 0, 'terminated');
    }

    close(): void {
        this.terminate();
    }
}

/** 拿到（或创建）宿主客户端并完成 attach；返回宿主当前的连接/会话快照。 */
async function attachHostClient(): Promise<{ connected: boolean; session: any }> {
    if (hostState.client) {
        const info = await hostState.client.attach();
        return { connected: !!info?.connected, session: info?.session || null };
    }
    const client = new HostClient({
        pipeName: String(process.env.FARM_HOST_PIPE || ''),
        token: String(process.env.FARM_HOST_TOKEN || ''),
    });
    const info = await client.attach();
    hostState.client = client;
    return { connected: !!info?.connected, session: info?.session || null };
}

/** 宿主 → worker 的入站分发（remote 模式专用；本地模式仍走 handleMessage）。 */
function handleHostFrame(frame: { meta: any; body?: Buffer }): void {
    const meta = frame.meta || {};
    const context = currentConnection;
    const adapter = hostState.adapter;
    switch (String(meta.t || '')) {
        case 'open': {
            if (!context || !adapter) return;
            if (adapter.readyState !== 1) adapter.readyState = 1;
            adapter.emit('open');
            return;
        }
        case 'msg': {
            // 宿主转发来的网关回包等价于本地 handleMessage：必须刷新入站时间，
            // 否则「距上次入站」一直增长，健康度被误判成「连接无响应」，
            // 自动任务额度从 180/60s 收紧到 24/60s（点券礼包等低优先级任务全被让路）。
            lastInboundMono = performance.now();
            const seq = toNum(meta.seq);
            const errorCode = toNum(meta.errorCode);
            const pending = pendingCallbacks.get(seq);
            try { recordRequestOutcome(String(meta.service || ''), String(meta.method || ''), errorCode === 0); } catch {}
            if (!pending) return;
            pendingCallbacks.delete(seq);
            if (errorCode !== 0 && !pending.expectedErrorCodes.has(errorCode)) {
                invokePendingCallback(pending.callback, new GatewayError({
                    service_name: meta.service, method_name: meta.method,
                    error_code: errorCode, error_message: meta.errorMessage || '',
                } as any));
                return;
            }
            invokePendingCallback(pending.callback, null, frame.body || Buffer.alloc(0), meta);
            return;
        }
        case 'notify': {
            lastInboundMono = performance.now();
            // body 是 EventMessage 字节：事件类型随业务演进，解码留在 worker。
            // replay=true 表示这是 worker 离线期间宿主缓存下来的事件（热重启补发）。
            handleNotify({ body: frame.body || Buffer.alloc(0) });
            return;
        }
        case 'notify-gap': {
            const dropped = toNum(meta.dropped);
            if (dropped > 0) {
                logWarn('推送', `worker 离线期间有 ${dropped} 条推送被丢弃，触发一次全量校正`);
                networkEvents.emit('notifyGap', { dropped, at: Date.now() });
            }
            return;
        }
        case 'link-error': {
            if (!context) return;
            logWarn('系统', `与连接宿主的通道断开：${String(meta.message || '')}`);
            finalizeConnection(context, { source: 'host_link_lost', reason: String(meta.message || '连接宿主已断开') });
            adapter?.emit('close', 1006, 'host_link_lost');
            return;
        }
        case 'server-time': {
            lastInboundMono = performance.now();
            const serverTime = toNum(meta.serverTime);
            if (serverTime > 0) syncServerTime(serverTime);
            return;
        }
        case 'send-err': {
            const seq = toNum(meta.seq);
            const pending = pendingCallbacks.get(seq);
            if (!pending) return;
            pendingCallbacks.delete(seq);
            invokePendingCallback(pending.callback, new Error(String(meta.message || '发送失败')));
            return;
        }
        case 'close': {
            if (!context) return;
            finalizeConnection(context, { source: 'ws_close', reason: `远端连接关闭 code=${meta.code || 0}`, code: toNum(meta.code) } as any);
            adapter?.emit('close', toNum(meta.code), String(meta.reason || ''));
            return;
        }
        case 'dead': {
            if (!context) return;
            log('心跳', `宿主判定连接已死：${String(meta.reason || '')}`);
            finalizeConnection(context, { source: 'heartbeat_timeout', reason: String(meta.reason || '心跳超时') } as any);
            adapter?.emit('close', 1006, 'heartbeat_timeout');
            return;
        }
        case 'socket-error': {
            adapter?.emit('error', new Error(String(meta.message || '连接错误')));
            return;
        }
        case 'session-ok':
            log('系统', '宿主已接管会话（心跳 / ACE 由宿主持有）');
            break;
        default:
            break;
    }
}

/**
 * remote 模式的建连：握手参数仍由业务层构造（版本、平台、code 都是业务决策），
 * 宿主只负责实际握手 + 后续心跳/加密。
 */
async function connectViaHost(code: string | null, onLoginSuccess?: () => void | Promise<void>): Promise<void> {
    if (currentConnection && !currentConnection.finalized) throw new Error('WebSocket 连接已存在');

    clientSeq = 1;
    serverSeq = 0;
    lastInboundMono = performance.now();
    lastHeartbeatMono = performance.now();
    heartbeatMissCount = 0;

    const clientVersion = getClientVersion();
    const url = new URL(CONFIG.serverUrl);
    url.search = new URLSearchParams({
        platform: isWechatPlatform() ? 'wx' : CONFIG.platform,
        os: CONFIG.os,
        ver: clientVersion,
        code: String(code || '').trim(),
    }).toString();
    const di = CONFIG.deviceInfo || {};
    const headers = {
        'User-Agent': di.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
        'Origin': 'https://gate-obt.nqf.qq.com',
    };

    // 先 attach 再判断 Code：热重启时宿主已经有一条登录好的连接，
    // 这时手头的 Code 早就过期（甚至为空），不需要也不能再登录一次。
    let attached: { connected: boolean; session: any; bufferedNotifies?: number } = { connected: false, session: null };
    try {
        attached = await attachHostClient();
    } catch (error: any) {
        // 宿主不可用时本进程内降级为直连；必须关掉开关，否则 connect() 会再次进入远程分支形成死循环。
        process.env.FARM_SOCKET_HOST = '0';
        logWarn('系统', `连接宿主不可用，回退到 worker 内直连: ${error?.message || error}`);
        return connect(code, onLoginSuccess);
    }

    const adapter = new HostSocketAdapter();
    const context: ConnectionContext = {
        id: nextConnectionId++,
        socket: adapter as any,
        phase: 'connecting',
        intentionalClose: false,
        finalized: false,
        loginInitialized: false,
        clientVersion,
        startedMono: performance.now(),
    };
    currentConnection = context;
    ws = adapter as any;
    hostState.adapter = adapter;
    hostState.session = attached.session;

    hostState.client.resetHandlers();
    hostState.client.onFrame((frame: any) => {
        if (!isCurrentConnection(context)) return;
        handleHostFrame(frame);
    });

    // 宿主已有存活连接（worker 热重启）：直接复用会话，不重发 PlayerLogin。
    if (attached.connected && attached.session?.gid) {
        applyHostSession(attached.session);
        // 心跳要带「当初登录用的版本」：热重启后本地配置可能已经改过，
        // 版本号一变服务器就可能不认这条会话。
        if (attached.session.clientVersion) context.clientVersion = String(attached.session.clientVersion);
        adapter.readyState = 1;
        context.phase = 'online';
        context.onlineMono = performance.now();
        context.loginInitialized = true;
        log('系统', `已复用宿主存活连接（gid=${attached.session.gid}${userState.name ? `，${userState.name}` : ''}），无需重新登录`);
        startHostStateSync(context);
        try {
            await onLoginSuccess?.();
        } catch (error: any) {
            logWarn('系统', `会话恢复回调失败: ${error?.message || error}`);
        }
        return;
    }

    const authCode = String(code || '').trim();
    if (!authCode) throw new Error('连接缺少一次性 Code（宿主没有可复用的存活会话）');

    // 网关打开后仍由 worker 发 PlayerLogin：登录是业务协议，不能塞进只做传输的宿主。
    adapter.on('open', () => {
        if (!isCurrentConnection(context) || context.phase !== 'connecting') return;
        context.phase = 'login';
        networkScheduler.setTimeoutTask('login_timeout', 20000, () => {
            if (!isCurrentConnection(context) || context.phase !== 'login') return;
            logWarn('登录', '登录响应超时，账号将停止运行...');
            finalizeConnection(context, { source: 'login_timeout', reason: '登录响应超时' });
            try { (context.socket as any).terminate(); } catch {}
        });
        sendLogin(context, onLoginSuccess).catch((e: any) => {
            if (!isCurrentConnection(context)) return;
            finalizeConnection(context, { source: 'login_send_failed', reason: e.message });
            try { (context.socket as any).terminate(); } catch {}
        });
    });

    hostState.client.connectGateway(url.toString(), headers);
}

function connect(code: string | null, onLoginSuccess?: () => void | Promise<void>): void {
    if (isHostTransportEnabled()) {
        // 连接宿主模式：WS / 心跳 / 加密 / ACE 都在宿主，这里只把握手参数交过去。
        void connectViaHost(code, onLoginSuccess).catch((error: any) => {
            logWarn('系统', `远程建连失败: ${error?.message || error}`);
        });
        return;
    }
    const authCode = String(code || '').trim();
    if (!authCode) throw new Error('连接缺少一次性 Code');
    if (currentConnection && !currentConnection.finalized) throw new Error('WebSocket 连接已存在');

    clientSeq = 1;
    serverSeq = 0;
    lastInboundMono = performance.now();
    lastHeartbeatMono = performance.now();
    heartbeatMissCount = 0;
    const clientVersion = getClientVersion();
    const url = new URL(CONFIG.serverUrl);
    url.search = new URLSearchParams({
        platform: isWechatPlatform() ? 'wx' : CONFIG.platform,
        os: CONFIG.os,
        ver: clientVersion,
        code: authCode,
    }).toString();
    const di = CONFIG.deviceInfo || {};
    const socket = new WebSocket(url.toString(), {
        handshakeTimeout: 20000,
        headers: {
            'User-Agent': di.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
            'Origin': 'https://gate-obt.nqf.qq.com',
        },
    });
    const context: ConnectionContext = {
        id: nextConnectionId++,
        socket,
        phase: 'connecting',
        intentionalClose: false,
        finalized: false,
        loginInitialized: false,
        clientVersion,
        startedMono: performance.now(),
    };
    currentConnection = context;
    ws = socket;
    socket.binaryType = 'arraybuffer';

    (socket as any).on('open', () => {
        if (!isCurrentConnection(context)) return;
        context.phase = 'login';
        networkScheduler.setTimeoutTask('login_timeout', 20000, () => {
            if (!isCurrentConnection(context) || context.phase !== 'login') return;
            logWarn('登录', '登录响应超时，账号将停止运行...');
            finalizeConnection(context, { source: 'login_timeout', reason: '登录响应超时' });
            try { (socket as any).terminate(); } catch {}
        });
        sendLogin(context, onLoginSuccess).catch((e: any) => {
            if (!isCurrentConnection(context)) return;
            finalizeConnection(context, { source: 'login_send_failed', reason: e.message });
            try { (socket as any).terminate(); } catch {}
        });
    });

    (socket as any).on('message', (data: any, _isBinary: any) => {
        if (!isCurrentConnection(context)) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        handleMessage(buf);
    });

    (socket as any).on('close', (closeCode: any, closeReason: any) => {
        const reason = Buffer.isBuffer(closeReason) ? closeReason.toString('utf8') : String(closeReason || '');
        console.warn(`[WS] 连接关闭 (code=${closeCode})`);
        finalizeConnection(context, { source: 'ws_close', code: Number(closeCode) || 0, reason });
    });

    (socket as any).on('error', (err: any) => {
        if (!isCurrentConnection(context)) return;
        const message = err && err.message ? String(err.message) : '';
        logWarn('系统', `[WS] 错误: ${message}`);
        const match = message.match(/Unexpected server response:\s*(\d+)/i);
        if (match) {
            const errorCode = Number.parseInt(match[1], 10) || 0;
            if (errorCode) {
                setWsErrorState(errorCode, message);
                networkEvents.emit('ws_error', { code: errorCode, message });
            }
        }
    });
}

function cleanup(reason = '网络清理'): void {
    const context = currentConnection;
    if (isHostTransportEnabled()) {
        // 用户主动停号：让宿主关闭网关连接，否则会留下一条没有 worker 的孤儿连接。
        try { hostState.client?.requestGatewayClose(); } catch {}
    }
    if (!context) {
        clearNetworkRuntime(reason);
        return;
    }
    context.intentionalClose = true;
    finalizeConnection(context, { source: 'intentional_close', reason });
    try { context.socket.close(); } catch {}
}

function getWs(): WebSocket | null { return ws; }

/**
 * 只把「当前场景」标记为未知，保留连接。
 *
 * 牧场是全项目唯一会切场景的业务（进牧场 → 干活 → 切回农场）。切回失败时，
 * 连接本身往往还是健康的：心跳、ACE、其它业务回包都正常，只是那条
 * PlayerSceneLogin 没拿到回包。此时直接 terminate 的代价在两端并不对称：
 *   - 微信有 loginBuffer / refreshtoken，60 秒能换票回来，用户几乎无感；
 *   - QQ 只有一次性 Code，断一次就要外部补票，在容器里表现为「跑一会儿就掉线」。
 *
 * 连接到底死没死交给心跳判断（漏拍 + 静默双条件），这里只做场景降级：
 * 下一次牧场操作会重新 loginGameScene(2)，成功后 globalSceneId 自然复位。
 */
function markGameSceneUnknown(reason = '游戏场景状态未知，已保留连接待下次重新进入'): void {
    if (userState.globalSceneId === 0) return;
    userState.globalSceneId = 0;
    logWarn('牧场', reason);
}

/**
 * 连接已不可用时的兜底：结束连接，交给主进程补 Code 重登。
 * 只有确认「这条连接已经废了」才该走这里；场景状态对不上不算。
 */
function invalidateGameScene(reason = '游戏场景状态未知，需要重新登录'): void {
    const context = currentConnection;
    if (!context) return;
    finalizeConnection(context, { source: 'game_scene_unknown', reason });
    (context.socket as any).terminate();
}

module.exports = {
    connect, cleanup, getWs,
    buildLoginBody, buildHeartbeatBody,
    sendMsgAsync, sendMsgNoReply,
    getGatewayLoad, isGatewayIdleForBackground, waitForGatewayIdle,
    getInboundSilenceMs, isGatewayStalling,
    GatewayError, GatewayBusyError,
    getUserState, loginGameScene, invalidateGameScene, markGameSceneUnknown, applyShareInfos, getDailyShareInfo,
    getWsErrorState,
    networkEvents,
};
