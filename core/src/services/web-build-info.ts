export {};

/**
 * 前端构建信息：让后端知道「现在服务器上摆着的这份前端是哪个版本」。
 *
 * 用途只有一个——浏览器标签页里跑的 JS 可能是刷新之前加载的旧包。更新完成后后端会通过
 * socket 广播当前前端构建号，前端拿自己的构建号一比就知道要不要提示刷新，避免出现
 * 「更新成功但界面看起来没变」的错觉。
 */

const fs = require('node:fs');
const path = require('node:path');

export interface WebBuildInfo {
    buildId: string;
    appVersion: string;
    appBuild: number;
    builtAt: number;
}

let cached: { filePath: string; mtimeMs: number; size: number; info: WebBuildInfo | null } | null = null;

function resolveWebDistDir(repoRoot: string): string {
    return path.join(path.resolve(repoRoot), 'web', 'dist');
}

function readWebBuildInfo(repoRoot: string): WebBuildInfo | null {
    const filePath = path.join(resolveWebDistDir(repoRoot), 'version.json');
    try {
        const stat = fs.statSync(filePath);
        if (cached
            && cached.filePath === filePath
            && cached.mtimeMs === stat.mtimeMs
            && cached.size === stat.size) {
            return cached.info;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const buildId = typeof parsed?.buildId === 'string' ? parsed.buildId.trim() : '';
        const info: WebBuildInfo | null = buildId
            ? {
                buildId,
                appVersion: typeof parsed?.appVersion === 'string' ? parsed.appVersion.trim() : '',
                appBuild: Number(parsed?.appBuild) || 0,
                builtAt: Number(parsed?.builtAt) || 0,
            }
            : null;
        cached = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, info };
        return info;
    }
    catch {
        cached = null;
        return null;
    }
}

function getActiveWebBuildId(repoRoot: string): string {
    return readWebBuildInfo(repoRoot)?.buildId || '';
}

/**
 * 仓库根 `version.json`：项目真实版本（版本号单一真源）。
 *
 * 和 `readWebBuildInfo` 的区别很关键——那个读的是 `web/dist/version.json`，只在
 * `pnpm build:web` 时才刷新；而本函数读的是提交钩子每次 bump 的那份，所以只要进程重启
 * 或刷新页面就能看到新版本号，不需要重建前端。侧边栏版本号曾经写死成构建期常量
 * （`__APP_VERSION_LABEL__`），提交之后不重新 build 就永远显示旧版本。
 *
 * mtime 缓存：版本文件很小，但 `statSync` + 解析放在每个请求里也没必要；按 mtime/size
 * 命中即返回，文件一变立刻失效。
 */
export interface RepoVersionInfo {
    version: string;
    build: number;
    label: string;
    updatedAt: string;
}

let repoVersionCache: { filePath: string; mtimeMs: number; size: number; info: RepoVersionInfo | null } | null = null;

function readRepoVersion(repoRoot: string): RepoVersionInfo | null {
    const filePath = path.join(path.resolve(repoRoot), 'version.json');
    try {
        const stat = fs.statSync(filePath);
        if (repoVersionCache
            && repoVersionCache.filePath === filePath
            && repoVersionCache.mtimeMs === stat.mtimeMs
            && repoVersionCache.size === stat.size) {
            return repoVersionCache.info;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const version = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
        const info: RepoVersionInfo | null = version
            ? {
                version,
                build: Number(parsed?.build) || 0,
                label: Number(parsed?.build) > 0 ? `v${version} · 第 ${Number(parsed.build)} 次更新` : `v${version}`,
                updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '',
            }
            : null;
        repoVersionCache = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, info };
        return info;
    }
    catch {
        repoVersionCache = null;
        return null;
    }
}

module.exports = {
    readWebBuildInfo,
    getActiveWebBuildId,
    readRepoVersion,
};
