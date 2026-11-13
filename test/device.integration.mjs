// 端到端集成验证：不需要真手机、不需要 root。
//
// 做法：造一个假的 `adb` 可执行文件放进临时 PATH，然后走**真实的**
// detectCapabilities → registerDeviceTools → device_exec 链路，
// 确认：
//   1. 能力探测能从 `adb devices` 输出里认出设备
//   2. 工具真的注册进了 ctx.tools
//   3. 命令真的经由 adb 跑（假 adb 会把参数写进日志）
//   4. 白名单外的命令被拒，且**没有**调用到 adb
//   5. device.enable=false 时一个工具都不注册
//
// 跑法：node test/device.integration.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectCapabilities } from '../lib/device/exec.mjs';
import { registerDeviceTools, EXEC_TOOL, STATUS_TOOL } from '../lib/device/tool.mjs';

/**
 * 造一个假 adb。
 *
 * 它会：
 * - `devices -l` → 打印一台已授权设备
 * - `-s X shell <cmd>` → 把 cmd 追加进 calls.log，并回一段固定输出
 * - `shell id -u` → 回 2000（adbd 不是 root，这是最常见的情况）
 */
function fakeAdb() {
  const dir = mkdtempSync(join(tmpdir(), 'dshgo-adb-'));
  const log = join(dir, 'calls.log');
  const bin = join(dir, 'adb');
  const script = `#!/bin/sh
LOG="${log}"
echo "ARGV:$*" >> "$LOG"
case "$1" in
  devices) printf 'List of devices attached\\nFAKESERIAL   device product:test model:FakePhone usb:1-1\\n' ; exit 0 ;;
  -s)
    shift 2
    case "$1" in
      shell)
        shift
        if [ "$*" = "id -u" ]; then echo 2000; exit 0; fi
        echo "ran: $*"
        exit 0 ;;
    esac ;;
  shell)
    shift
    if [ "$*" = "id -u" ]; then echo 2000; exit 0; fi
    echo "ran: $*"
    exit 0 ;;
esac
echo "unexpected argv: $*" >&2
exit 2
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { dir, bin, log };
}

/** 最小可用的 ctx：只需要 effect / get / tools.register。 */
function fakeCtx() {
  const registered = new Map();
  const disposers = [];
  return {
    registered,
    get(name) {
      if (name === 'tools') return { register: () => () => {} };
      return undefined;
    },
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return () => {};
    },
    tools: {
      register(def) {
        registered.set(def.name, def);
        return () => registered.delete(def.name);
      },
    },
  };
}

/**
 * 测试用的 defineTool 替身。
 *
 * `@deepseek-ai/dsh-tools` 由 DSH 宿主提供，本包的依赖里没有它，测试环境
 * import 不到。这里只做一件事：把 options 原样包成 `{name, execute, ...}`，
 * 因为我们断言的是**注册链路与执行结果**，不是 schema 编译。
 *
 * schema 编译本身由 DSH 侧保证（`defineTool` 的实现），不归这个 PR 管。
 */
const stubDefineTool = (options) => ({
  name: options.name,
  description: options.description,
  parameters: options.parameters,
  output: options.output,
  isConcurrencySafe: options.isConcurrencySafe,
  execute: options.execute,
});

test('假 adb 的能力探测：认出设备，且 adbd 非 root', async () => {
  const adb = fakeAdb();
  const caps = await detectCapabilities({ PATH: `${adb.dir}:/usr/bin:/bin` });
  assert.equal(caps.adb.available, true);
  assert.equal(caps.adb.devices[0].serial, 'FAKESERIAL');
  assert.equal(caps.adb.devices[0].model, 'FakePhone');
  // adbd 是 shell uid，不是 root —— rootShell 必须是 false
  assert.equal(caps.adb.rootShell, false);
});

test('端到端：注册后能通过 device_exec 真的跑命令', async () => {
  const adb = fakeAdb();
  const prevPath = process.env.PATH;
  process.env.PATH = `${adb.dir}:/usr/bin:/bin`;
  try {
    const ctx = fakeCtx();
    const result = await registerDeviceTools(
      ctx,
      { device: { enable: true, allow: ['dumpsys'], adbPath: '' } },
      () => {},
      { defineTool: stubDefineTool },
    );
    assert.deepEqual(result.registered.sort(), [EXEC_TOOL, STATUS_TOOL].sort());
    assert.equal(ctx.registered.size, 2);

    const tool = ctx.registered.get(EXEC_TOOL);
    assert.ok(tool, 'device_exec 必须注册上');

    const value = await tool.execute(
      { description: '查看电池', command: 'dumpsys battery', backend: 'adb' },
      { signal: new AbortController().signal },
    );
    assert.equal(value.refused, undefined, `不该被拒：${value.refused}`);
    assert.match(value.stdout, /ran: dumpsys battery/);
    assert.equal(value.exitCode, 0);
    // 关键：真的经由假 adb 走了 -s SERIAL shell
    assert.ok(existsSync(adb.log));
    assert.match(readFileSync(adb.log, 'utf8'), /-s FAKESERIAL shell dumpsys battery/);
  } finally {
    process.env.PATH = prevPath;
  }
});

test('端到端：白名单外的命令被拒，且**没有**调用 adb', async () => {
  const adb = fakeAdb();
  const prevPath = process.env.PATH;
  process.env.PATH = `${adb.dir}:/usr/bin:/bin`;
  try {
    const ctx = fakeCtx();
    await registerDeviceTools(
      ctx,
      { device: { enable: true, allow: ['pm'] } },
      () => {},
      { defineTool: stubDefineTool },
    );
    const tool = ctx.registered.get(EXEC_TOOL);
    const value = await tool.execute(
      { description: '删点东西', command: 'rm -rf /data/local/tmp/x', backend: 'adb' },
      { signal: new AbortController().signal },
    );
    assert.ok(value.refused, '必须被拒绝');
    assert.match(value.refused, /rm/);
    // 日志里只有探测产生的那几条，绝不能出现 rm
    const log = existsSync(adb.log) ? readFileSync(adb.log, 'utf8') : '';
    assert.doesNotMatch(log, /rm -rf/, '白名单拒绝后不该真的调用 adb');
  } finally {
    process.env.PATH = prevPath;
  }
});

test('端到端：device.enable=false 时一个工具都不注册（默认安全）', async () => {
  const adb = fakeAdb();
  const prevPath = process.env.PATH;
  process.env.PATH = `${adb.dir}:/usr/bin:/bin`;
  try {
    const ctx = fakeCtx();
    const result = await registerDeviceTools(ctx, { device: {} }, () => {}, { defineTool: stubDefineTool });
    assert.deepEqual(result.registered, []);
    assert.equal(ctx.registered.size, 0);
    assert.match(result.skipped, /未开启/);
    // 也不该去跑 adb（白白弹一次 adb daemon 是没意义的）
    assert.equal(existsSync(adb.log), false);
  } finally {
    process.env.PATH = prevPath;
  }
});

test('device_status 能把能力与白名单一起报出来', async () => {
  const adb = fakeAdb();
  const prevPath = process.env.PATH;
  process.env.PATH = `${adb.dir}:/usr/bin:/bin`;
  try {
    const ctx = fakeCtx();
    await registerDeviceTools(
      ctx,
      { device: { enable: true, allow: ['pm', 'dumpsys'] } },
      () => {},
      { defineTool: stubDefineTool },
    );
    const tool = ctx.registered.get(STATUS_TOOL);
    const value = await tool.execute({ description: '看看有什么权限' });
    assert.equal(value.adb.available, true);
    assert.equal(value.allowAll, false);
    assert.deepEqual(value.allow, ['pm', 'dumpsys']);
    assert.match(value.summary, /adb 可用/);
    assert.match(value.summary, /FakePhone/);
  } finally {
    process.env.PATH = prevPath;
  }
});