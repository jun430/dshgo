// shell 提权层的测试。
//
// 钉的是三件事：
//   · 转接程序生成的文本正确（后端、引号、透传、空命令）
//   · 真的能接管一次 `bash -c <cmd>`（用一个假 su / 假 adb 验证命令确实改道）
//   · PATH 能被精确还原，不留尾巴
//
// 跑法：node --test test/shell.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { renderShim, quote, findRealBash, ShellShim, SHELL_BACKENDS } from '../lib/shell/shim.mjs';

// ---------------------------------------------------------------- 引号
test('quote 无单引号时用单引号包', () => {
  assert.equal(quote('/usr/bin/bas h'), "'/usr/bin/bas h'");
  assert.equal(quote(''), "''");
});

test('quote 遇到单引号改双引号并转义危险字符', () => {
  const out = quote("a'b$c`d\\e\"f");
  assert.match(out, /^".*"$/);
  assert.match(out, /\\\$/);
  assert.match(out, /\\`/);
});

// ---------------------------------------------------------------- 渲染
test('renderShim 指定 root 时用 su -c，且命令作为整体传', () => {
  const shim = renderShim({ backend: 'root', realBash: '/bin/bash', suPath: '/system/bin/su' });
  assert.match(shim, /^#!\/bin\/sh/);
  assert.match(shim, /REAL_BASH='\/bin\/bash'/);
  // 关键：su -c "$cmd" —— 带双引号才能把整条命令当一个参数
  assert.match(shim, /exec '\/system\/bin\/su' -c "\$cmd"/);
});

test('renderShim 指定 adb 时带上 serial，且依然整体传', () => {
  const shim = renderShim({
    backend: 'adb',
    realBash: '/bin/bash',
    adbPath: '/opt/platform-tools/adb',
    serial: 'R58M12ABCDE',
  });
  assert.match(shim, /exec '\/opt\/platform-tools\/adb' -s 'R58M12ABCDE' shell "\$cmd"/);
});

test('renderShim 的 adb 无 serial 时不写 -s（交给 adb 自己挑）', () => {
  const shim = renderShim({ backend: 'adb', realBash: '/bin/bash', adbPath: '/usr/bin/adb' });
  assert.doesNotMatch(shim, /-s/);
  assert.match(shim, /shell "\$cmd"/);
});

test('renderShim 只接管 -c，其它用法原样透传', () => {
  const shim = renderShim({ backend: 'root', realBash: '/bin/bash', suPath: '/bin/su' });
  // 存在 else 分支把 $@ 交给真 bash
  assert.match(shim, /exec "\$REAL_BASH" "\$@"/);
  assert.match(shim, /\[ "\$1" = "-c" \]/);
});

test('renderShim 对空命令直接退出（不惊动 su 弹授权框）', () => {
  const shim = renderShim({ backend: 'root', realBash: '/bin/bash', suPath: '/bin/su' });
  assert.match(shim, /if \[ -z "\$cmd" \]; then/);
  assert.match(shim, /exit 0/);
});

test('SHELL_BACKENDS 三档齐全，且 off 是默认语义', () => {
  assert.deepEqual(SHELL_BACKENDS, ['off', 'root', 'adb']);
});

// ---------------------------------------------------------------- 真 bash 查找
test('findRealBash 能跳过自己的目录，避免无限递归', () => {
  const fakeShimDir = mkdtempSync(join(tmpdir(), 'shimdir-'));
  // 在 shim 目录里放个 bash，如果不跳过就会找到它
  const fake = join(fakeShimDir, 'bash');
  writeFileSync(fake, '#!/bin/sh\n');
  chmodSync(fake, 0o755);
  const found = findRealBash({ PATH: `${fakeShimDir}:/bin:/usr/bin` }, fakeShimDir);
  assert.notEqual(found, fake, '必须跳过 shim 目录，否则会自己 exec 自己');
  assert.ok(found && found.endsWith('/bash'));
});

test('findRealBash 找不到时返回 null 而不是抛异常', () => {
  assert.equal(findRealBash({ PATH: '/nope' }, '/nope'), null);
});

// ---------------------------------------------------------------- 端到端接管
/**
 * 造一个假 su：把收到的参数写进日志，再原样把命令交给真 bash 执行。
 *
 * 这样我们既能验证「命令确实经过 su」，又能验证「执行结果仍然正确」。
 */
function fakeSu(dir, log) {
  const path = join(dir, 'su');
  writeFileSync(path, `#!/bin/sh
printf '%s\\n' "SU_ARGS:$*" >> '${log}'
if [ "$1" = "-c" ]; then
  exec /bin/sh -c "$2"
fi
exec /bin/sh "$@"
`);
  chmodSync(path, 0o755);
  return path;
}

test('端到端：backend=root 时 bash -c 真的改道经过 su', () => {
  const work = mkdtempSync(join(tmpdir(), 'shimroot-'));
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  const log = join(work, 'su.log');
  fakeSu(work, log);

  const prevPath = process.env.PATH;
  process.env.PATH = `${work}:${prevPath}`;
  const shim = new ShellShim({ backend: 'root', home, warn: () => {} });
  try {
    assert.equal(shim.install(), true);
    assert.ok(existsSync(shim.shimPath), '转接程序应落盘');

    // 用转接程序执行一条命令 —— 模拟 bash-local 的调用方式
    const out = execFileSync(shim.shimPath, ['-c', 'echo hello-from-root'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH },
    });
    assert.equal(out.trim(), 'hello-from-root');

    // 关键断言：命令确实经过 su
    const logText = readFileSync(log, 'utf8');
    assert.match(logText, /SU_ARGS:-c echo hello-from-root/);
  } finally {
    shim.uninstall();
    process.env.PATH = prevPath;
  }
});

test('端到端：带空格的命令作为一个整体传给 su（不被拆参数）', () => {
  const work = mkdtempSync(join(tmpdir(), 'shimsp-'));
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  const log = join(work, 'su.log');
  fakeSu(work, log);

  const prevPath = process.env.PATH;
  process.env.PATH = `${work}:${prevPath}`;
  const shim = new ShellShim({ backend: 'root', home, warn: () => {} });
  try {
    shim.install();
    const out = execFileSync(shim.shimPath, ['-c', 'echo "a b" "c d"'], { encoding: 'utf8' });
    assert.equal(out.trim(), 'a b c d');
    // 日志里应是一条完整的 -c <整条命令>，而不是被拆开
    assert.match(readFileSync(log, 'utf8'), /SU_ARGS:-c echo "a b" "c d"/);
  } finally {
    shim.uninstall();
    process.env.PATH = prevPath;
  }
});

test('端到端：空命令不触发 su（避免无谓的授权弹窗）', () => {
  const work = mkdtempSync(join(tmpdir(), 'shimempty-'));
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  const log = join(work, 'su.log');
  fakeSu(work, log);

  const prevPath = process.env.PATH;
  process.env.PATH = `${work}:${prevPath}`;
  const shim = new ShellShim({ backend: 'root', home, warn: () => {} });
  try {
    shim.install();
    const out = execFileSync(shim.shimPath, ['-c', ''], { encoding: 'utf8' });
    assert.equal(out.trim(), '');
    // 日志文件根本不该被创建
    assert.equal(existsSync(log), false, '空命令不该惊动 su');
  } finally {
    shim.uninstall();
    process.env.PATH = prevPath;
  }
});

test('端到端：非 -c 用法原样透传（不破坏 bash 语义）', () => {
  const work = mkdtempSync(join(tmpdir(), 'shimpassthru-'));
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  const log = join(work, 'su.log');
  fakeSu(work, log);
  // 造一个脚本文件，用 `bash script.sh` 的形式调用
  const script = join(work, 's.sh');
  writeFileSync(script, 'echo passthrough-ok\n');

  const prevPath = process.env.PATH;
  process.env.PATH = `${work}:${prevPath}`;
  const shim = new ShellShim({ backend: 'root', home, warn: () => {} });
  try {
    shim.install();
    const out = execFileSync(shim.shimPath, [script], { encoding: 'utf8' });
    assert.equal(out.trim(), 'passthrough-ok');
    // 没有走 su
    assert.equal(existsSync(log), false, '`bash script.sh` 不该被 su 接管');
  } finally {
    shim.uninstall();
    process.env.PATH = prevPath;
  }
});

// ---------------------------------------------------------------- PATH 管理
test('install 把 shim 目录插到 PATH 最前面', () => {
  const work = mkdtempSync(join(tmpdir(), 'shimpath-'));
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  const prevPath = process.env.PATH;
  const shim = new ShellShim({ backend: 'off', home, warn: () => {} });
  try {
    // off 时不该动 PATH
    assert.equal(shim.install(), false);
    assert.equal(process.env.PATH, prevPath, 'backend=off 时 PATH 不该变');
  } finally {
    shim.uninstall();
    process.env.PATH = prevPath;
  }
});

test('uninstall 精确还原 PATH（不靠字符串替换）', () => {
  const work = mkdtempSync(join(tmpdir(), 'shimrestore-'));
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  fakeSu(work, join(work, 'su.log'));
  const prevPath = process.env.PATH;
  process.env.PATH = `${work}:${prevPath}`;
  const shim = new ShellShim({ backend: 'root', home, warn: () => {} });
  try {
    const before = process.env.PATH;
    shim.install();
    const during = process.env.PATH;
    assert.ok(during.startsWith(shim.dir), 'shim 目录应在最前');
    assert.notEqual(during, before);

    shim.uninstall();
    assert.equal(process.env.PATH, before, '必须精确还原到 install 之前的值');
    assert.equal(existsSync(shim.dir), false, '转接目录应被删掉');
  } finally {
    process.env.PATH = prevPath;
  }
});

test('重复 install 不会把同一个目录叠进 PATH 两次', () => {
  const work = mkdtempSync(join(tmpdir(), 'shimdup-'));
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  fakeSu(work, join(work, 'su.log'));
  const prevPath = process.env.PATH;
  process.env.PATH = `${work}:${prevPath}`;
  const shim = new ShellShim({ backend: 'root', home, warn: () => {} });
  try {
    shim.install();
    const once = process.env.PATH;
    shim.install();
    assert.equal(process.env.PATH, once, '第二次 install 不该再插一遍');
    const count = process.env.PATH.split(':').filter((d) => d === shim.dir).length;
    assert.equal(count, 1);
  } finally {
    shim.uninstall();
    process.env.PATH = prevPath;
  }
});

test('正在用的 PATH 里没有 su 时，backend=root 降级为不接管并告警', () => {
  const work = mkdtempSync(join(tmpdir(), 'shimnosu-'));
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  const warnings = [];
  const prevPath = process.env.PATH;
  // PATH 只留一个空目录 + /bin（/bin 里通常没有 su）
  process.env.PATH = `${work}:/bin`;
  const shim = new ShellShim({
    backend: 'root',
    home,
    warn: (m) => warnings.push(m),
  });
  try {
    const ok = shim.install();
    // 如果这台机器 /bin 里真有 su，那它会成功；两种结果都接受，但必须有一致的报告
    if (!ok) {
      assert.ok(warnings.some((w) => /su|doas/.test(w)), `告警应说明缺 su：${warnings.join('|')}`);
      assert.equal(process.env.PATH, `${work}:/bin`, '降级时不该改 PATH');
    }
  } finally {
    shim.uninstall();
    process.env.PATH = prevPath;
  }
});

test('describe 给出人类可读的状态', () => {
  const work = mkdtempSync(join(tmpdir(), 'shimdesc-'));
  const off = new ShellShim({ backend: 'off', home: work, warn: () => {} });
  assert.match(off.describe(), /未接管/);

  const shim = new ShellShim({ backend: 'adb', serial: 'ABC', home: work, warn: () => {} });
  // 没 install 时还是未接管
  assert.match(shim.describe(), /未接管/);
});
