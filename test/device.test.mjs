// 设备执行层的契约测试。
//
// 钉死的是**安全边界**，不是实现细节：
//   · 空白名单必须拒绝一切（不能因为「没配」就放行）
//   · 白名单按第一个词匹配，`FOO=1 pm x` 也要认成 `pm`
//   · `*` 能通配，但不会偷偷等于 allowAll
//   · 后端不可用 / 命令不在白名单时返回 refused，而不是抛异常
//   · 输出超限要截断并标记；超时要被杀掉，不能挂着
//   · adb devices 的解析要认得 unauthorized / offline（否则会给错误的下一步建议）
//
// 跑法：node --test test/device.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findExecutable,
  parseAdbDevices,
  firstToken,
  matchPattern,
  isCommandAllowed,
  buildInvocation,
  runProcess,
  execOnDevice,
  MAX_OUTPUT_BYTES,
} from '../lib/device/exec.mjs';
import { createCapabilityProbe, capabilitiesSummary } from '../lib/device/tool.mjs';

// ---------------------------------------------------------------- 可执行文件查找
test('findExecutable 认得 PATH 里的命令，也认得绝对路径', () => {
  // /bin/sh 在任何 POSIX 环境都在；这是最小假设
  assert.equal(findExecutable('/bin/sh'), '/bin/sh');
  assert.equal(findExecutable('sh', { PATH: '/bin:/usr/bin' }), '/bin/sh');
});

test('findExecutable 找不到就返回 null，不抛异常', () => {
  assert.equal(findExecutable('dshgo-绝对不存在-xyz'), null);
  assert.equal(findExecutable('/nope/definitely/missing'), null);
  assert.equal(findExecutable(''), null);
  assert.equal(findExecutable(null), null);
});

// ---------------------------------------------------------------- adb devices 解析
test('parseAdbDevices 分出 serial 与 state，并挑出 model', () => {
  const text = [
    'List of devices attached',
    'R58M12ABCDE            device product:beyond1q model:SM_G9730 usb:1-1',
    'emulator-5554          device product:sdk_gphone64 model:sdk_gphone64',
    '192.168.1.9:5555       unauthorized',
    '',
  ].join('\n');
  const devices = parseAdbDevices(text);
  assert.equal(devices.length, 3);
  assert.deepEqual(devices[0], { serial: 'R58M12ABCDE', state: 'device', model: 'SM_G9730', product: 'beyond1q', usb: '1-1' });
  assert.equal(devices[2].state, 'unauthorized');
  // unauthorized 的那条没有 model 字段，不该凭空造一个
  assert.equal(devices[2].model, undefined);
});

test('parseAdbDevices 忽略表头、空行与 adb 的星号提示', () => {
  const text = 'List of devices attached\n* daemon not running; starting now at tcp:5037\n\n  \nA1\tdevice\n';
  const devices = parseAdbDevices(text);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].serial, 'A1');
});

test('parseAdbDevices 对垃圾输入返回空数组而不是崩', () => {
  assert.deepEqual(parseAdbDevices(''), []);
  assert.deepEqual(parseAdbDevices(null), []);
  assert.deepEqual(parseAdbDevices('totally-not-adb-output'), []);
});

// ---------------------------------------------------------------- 命令名提取
test('firstToken 取第一个词，跳过前缀环境变量赋值', () => {
  assert.equal(firstToken('pm list packages'), 'pm');
  assert.equal(firstToken('  dumpsys battery  '), 'dumpsys');
  assert.equal(firstToken('FOO=1 BAR=2 pm grant a b'), 'pm');
  assert.equal(firstToken(''), '');
  assert.equal(firstToken('   '), '');
});

test('firstToken 不会把取值里的等号误认成赋值', () => {
  assert.equal(firstToken('a=b realcmd'), 'realcmd');
  assert.equal(firstToken('1=2'), '1=2');
});

// ---------------------------------------------------------------- 通配匹配
test('matchPattern 支持前缀、后缀、中间通配与精确匹配', () => {
  assert.equal(matchPattern('pm', 'pm'), true);
  assert.equal(matchPattern('pm', 'am'), false);
  assert.equal(matchPattern('pmlist', 'pm*'), true);
  assert.equal(matchPattern('listpm', '*pm'), true);
  assert.equal(matchPattern('abcXYZdef', 'abc*def'), true);
  assert.equal(matchPattern('abc', 'abc*def'), false);
  assert.equal(matchPattern('anything', '*'), true);
});

// ---------------------------------------------------------------- 白名单（最关键）
test('空白名单拒绝一切 —— 不做「没配就放行」的默认', () => {
  assert.equal(isCommandAllowed('pm list packages', []), false);
  assert.equal(isCommandAllowed('pm list packages', undefined), false);
  assert.equal(isCommandAllowed('pm list packages', null), false);
});

test('白名单按第一个词匹配，允许同一条命令带任意参数', () => {
  const allow = ['pm', 'dumpsys'];
  assert.equal(isCommandAllowed('pm list packages -3', allow), true);
  assert.equal(isCommandAllowed('dumpsys battery', allow), true);
  assert.equal(isCommandAllowed('rm -rf /data', allow), false);
});

test('白名单支持通配但不会因为通配漏放', () => {
  assert.equal(isCommandAllowed('pmlist', ['pm*']), true);
  assert.equal(isCommandAllowed('amp', ['pm*']), false);
});

test('白名单匹配命令名，不匹配命令里的参数（防「参数里藏命令」）', () => {
  assert.equal(isCommandAllowed('sh -c "pm list packages"', ['pm']), false);
});

// ---------------------------------------------------------------- 命令拼装
test('buildInvocation 按后端拼出正确的可执行文件与参数', () => {
  const detection = { adbPath: '/usr/bin/adb', suPath: '/system/bin/su' };
  assert.deepEqual(
    buildInvocation('adb', 'pm list', detection),
    { file: '/usr/bin/adb', args: ['shell', 'pm list'] },
  );
  assert.deepEqual(
    buildInvocation('adb', 'pm list', detection, { serial: 'ABC' }),
    { file: '/usr/bin/adb', args: ['-s', 'ABC', 'shell', 'pm list'] },
  );
  assert.deepEqual(
    buildInvocation('root', 'id', detection),
    { file: '/system/bin/su', args: ['-c', 'id'] },
  );
  assert.deepEqual(
    buildInvocation('shell', 'id', detection),
    { file: '/bin/sh', args: ['-c', 'id'] },
  );
});

test('命令作为**单个参数**传下去，不做字符串拼接', () => {
  const inv = buildInvocation('root', 'echo "a b" ; id', { suPath: '/bin/su' });
  assert.equal(inv.args.length, 2);
  assert.equal(inv.args[0], '-c');
  assert.equal(inv.args[1], 'echo "a b" ; id');
});

// ---------------------------------------------------------------- 进程执行
test('runProcess 分开收集 stdout 与 stderr', async () => {
  const r = await runProcess('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3']);
  assert.equal(r.stdout.trim(), 'out');
  assert.equal(r.stderr.trim(), 'err');
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
});

test('runProcess 超时会把进程杀掉并标记 timedOut', async () => {
  const started = Date.now();
  const r = await runProcess('/bin/sh', ['-c', 'sleep 10'], { timeoutMs: 1000 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 6000, `耗时 ${Date.now() - started}ms，超时没生效`);
});

test('runProcess 输出超限会截断并标记', async () => {
  const bytes = MAX_OUTPUT_BYTES + 4096;
  const r = await runProcess('/bin/sh', ['-c', `head -c ${bytes} /dev/zero | tr '\\0' 'a'`]);
  assert.equal(r.stdoutTruncated, true);
  assert.ok(r.stdout.length <= MAX_OUTPUT_BYTES, `实际 ${r.stdout.length} 字节，没截断`);
});

test('runProcess 对不存在的可执行文件返回错误文本而不是抛异常', async () => {
  const r = await runProcess('/definitely/not/here', []);
  assert.equal(r.exitCode, null);
  assert.ok(r.stderr.length > 0);
});

// ---------------------------------------------------------------- execOnDevice 的拒绝路径
const capsNoAdb = {
  adb: { available: false, path: null, devices: [], error: '没找到 adb 可执行文件' },
  root: { available: false, path: null, method: null, uid: null, error: '没找到 su' },
};
const capsAllOk = {
  adb: { available: true, path: '/usr/bin/adb', devices: [{ serial: 'A1', state: 'device' }] },
  root: { available: true, path: '/system/bin/su', method: 'su', uid: 0 },
};

test('后端不可用时返回 refused，而不是抛异常', async () => {
  const r = await execOnDevice(
    { backend: 'adb', command: 'pm list packages' },
    { capabilities: capsNoAdb, config: { allow: ['pm'] } },
  );
  assert.match(r.refused, /adb 不可用/);
  assert.equal(r.stdout, '');
});

test('root 不可用时说明原因（su 存在但没授权是最常见的一种）', async () => {
  const r = await execOnDevice(
    { backend: 'root', command: 'id' },
    { capabilities: capsNoAdb, config: { allow: ['id'] } },
  );
  assert.match(r.refused, /root 不可用/);
  assert.match(r.refused, /没找到 su/);
});

test('命令不在白名单时拒绝，并且把命令名与白名单条数说清楚', async () => {
  const r = await execOnDevice(
    { backend: 'adb', command: 'rm -rf /data/local/tmp/x' },
    { capabilities: capsAllOk, config: { allow: ['pm', 'dumpsys'] } },
  );
  assert.match(r.refused, /rm/);
  assert.match(r.refused, /2 条/);
});

test('空命令直接拒绝', async () => {
  const r = await execOnDevice({ backend: 'adb', command: '   ' }, { capabilities: capsAllOk, config: { allowAll: true } });
  assert.match(r.refused, /为空/);
});

test('超长命令拒绝（避免把整段脚本塞进一条命令）', async () => {
  const r = await execOnDevice(
    { backend: 'adb', command: 'a'.repeat(9000) },
    { capabilities: capsAllOk, config: { allowAll: true } },
  );
  assert.match(r.refused, /过长/);
});

test('allowAll 打开时不再走白名单', async () => {
  // 不断言「真的执行了」（那要连设备），只断言它**过了白名单那关**：
  // adb 路径是假的，最终会以「启动失败」返回，而不是 refused。
  const r = await execOnDevice(
    { backend: 'adb', command: 'whatever-cmd' },
    { capabilities: capsAllOk, config: { allowAll: true } },
  );
  assert.equal(r.refused, undefined);
});

// ---------------------------------------------------------------- 能力探测缓存
test('能力探测有 TTL 缓存，避免反复弹 su 授权框', async () => {
  let calls = 0;
  let clock = 1000;
  const probe = createCapabilityProbe({
    now: () => clock,
    ttlMs: 1000,
    detect: async () => {
      calls += 1;
      return { adb: { available: false, devices: [] }, root: { available: false } };
    },
  });
  await probe();
  await probe();
  assert.equal(calls, 1, 'TTL 内应复用缓存');
  clock += 2000;
  await probe();
  assert.equal(calls, 2, 'TTL 过了应重新探测');
  await probe(true);
  assert.equal(calls, 3, 'force 应绕过缓存');
});

test('并发探测会合并成一次（模型可能一次发多条命令）', async () => {
  let calls = 0;
  const probe = createCapabilityProbe({
    detect: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { adb: { available: false, devices: [] }, root: { available: false } };
    },
  });
  await Promise.all([probe(), probe(), probe()]);
  assert.equal(calls, 1);
});

test('capabilitiesSummary 把 unavailable 的原因写成人话', () => {
  const s = capabilitiesSummary(capsNoAdb);
  assert.match(s, /adb 不可用/);
  assert.match(s, /root 不可用/);
  assert.match(s, /没找到 su/);
});

test('capabilitiesSummary 在 adb 有设备时列出型号', () => {
  const s = capabilitiesSummary({
    adb: { available: true, path: '/usr/bin/adb', devices: [{ serial: 'A1', state: 'device', model: 'SM_G9730' }] },
    root: { available: true, method: 'su', uid: 0 },
  });
  assert.match(s, /SM_G9730/);
  assert.match(s, /uid=0/);
});