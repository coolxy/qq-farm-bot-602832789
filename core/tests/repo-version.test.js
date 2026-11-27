/**
 * 面板版本号的数据源。
 *
 * 背景：侧边栏版本号原来是 vite `define` 烘焙的常量，只有 `pnpm build:web` 才变。
 * 提交钩子每次提交都会 bump `version.json`，但前端不重建就永远显示旧版本——改完代码
 * 提交、后端也重启了，面板上还挂着上一版，以为改动没生效。
 *
 * 现在 `/api/version` 直接读仓库根的 `version.json`，所以这里钉三件事：
 *   1. 能读到真源里的版本号与更新次数；
 *   2. 文件变了能立刻反映（mtime 缓存不能变成永久缓存）；
 *   3. 读不到时返回 null 而不是抛错，调用方靠构建期常量兜底。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readRepoVersion } = require('../dist/services/web-build-info');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('读仓库根 version.json：版本号、更新次数与标签一致', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'version.json'), 'utf8'));
    const info = readRepoVersion(REPO_ROOT);
    assert.ok(info, '仓库根必须能读到版本文件');
    assert.equal(info.version, meta.version);
    assert.equal(info.build, meta.build);
    assert.equal(info.label, `v${meta.version} · 第 ${meta.build} 次更新`);
    assert.equal(info.updatedAt, meta.updatedAt || '');
});

test('version.json 改动后立刻反映，不被 mtime 缓存粘住', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-repo-version-'));
    try {
        const file = path.join(dir, 'version.json');
        fs.writeFileSync(file, JSON.stringify({ version: '9.1.0', build: 11, updatedAt: '2026-01-01T00:00:00.000Z' }));
        assert.equal(readRepoVersion(dir).label, 'v9.1.0 · 第 11 次更新');

        // 同一路径换内容：mtime/size 变化必须让缓存失效，否则面板要等进程重启才更新。
        fs.writeFileSync(file, JSON.stringify({ version: '9.2.1', build: 13, updatedAt: '2026-01-02T00:00:00.000Z' }));
        const next = readRepoVersion(dir);
        assert.equal(next.version, '9.2.1');
        assert.equal(next.build, 13);
        assert.equal(next.label, 'v9.2.1 · 第 13 次更新');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('缺文件或内容不合法时返回 null，交给前端兜底', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-repo-version-'));
    try {
        assert.equal(readRepoVersion(dir), null, '没有 version.json');
        fs.writeFileSync(path.join(dir, 'version.json'), '{ not json');
        assert.equal(readRepoVersion(dir), null, '坏 JSON 不能抛出去打死请求');
        fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ build: 3 }));
        assert.equal(readRepoVersion(dir), null, '没有 version 字段视为无效');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('没有更新次数时标签只显示版本号，不出现「第 0 次更新」', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-repo-version-'));
    try {
        fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.0.0' }));
        assert.equal(readRepoVersion(dir).label, 'v1.0.0');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
