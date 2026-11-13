// 模拟 @deepseek-ai/dsh-bash-local 的真实调用方式，验证接管链条真的成立。
//
// bash-local 的 execute() 是：
//   this.executeArgv(spec, ['bash', '-c', spec.command])
// 而 subprocess 用 spawn(argv[0], argv.slice(1), {env}) —— argv[0] 是裸名字，
// 走 PATH 查找。
//
// 这个脚本做一个等价的 spawn：spawn('bash', ['-c', cmd], {env})，然后检查：
//   1. 没有 shim 时，命令跑在普通用户下
//   2. 装了 shim（backend=root）后，命令经过 su
//   3. 卸载后，命令回到普通用户
//
// 跑法：node tools/verify-shim.mjs
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ShellShim } from '../lib/shell/shim.mjs';

/** 和 bash-local 一样的调用形态：裸 `bash` + 走 PATH。 */
function runLikeBashLocal(command, env) {
  const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', env });
  return { stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), status: r.status };
}

function fakeSu(dir, log) {
  const path = join(dir, 'su');
  writeFileSync(path, `#!/bin/sh
printf '%s\\n' "SU:$*" >> '${log}'
[ "$1" = "-c" ] && exec /bin/sh -c "$2"
exec /bin/sh "$@"
`);
  chmodSync(path, 0o755);
}

const work = mkdtempSync(join(tmpdir(), 'verify-shim-'));
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
const log = join(work, 'su.log');
fakeSu(work, log);

const prevPath = process.env.PATH;
process.env.PATH = `${work}:${prevPath}`;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  OK   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

console.log('[1] 基线：没有 shim，命令不经过 su');
const before = runLikeBashLocal('echo baseline-ok', { ...process.env });
check('命令能正常执行', before.stdout === 'baseline-ok', `stdout=${before.stdout} stderr=${before.stderr}`);
check('没有调用 su', existsSync(log) === false);

console.log('[2] 装 shim（backend=root）后，同样的调用应经过 su');
const shim = new ShellShim({ backend: 'root', home, warn: (m) => console.log(`  warn: ${m}`) });
const installed = shim.install();
check('install 成功', installed === true);
check('shim 文件已生成', existsSync(shim.shimPath));
check('PATH 首位是 shim 目录', process.env.PATH.split(':')[0] === shim.dir, process.env.PATH);

const during = runLikeBashLocal('echo via-root', { ...process.env });
check('命令仍能正常执行', during.stdout === 'via-root', `stdout=${during.stdout} stderr=${during.stderr}`);
const logText = existsSync(log) ? readFileSync(log, 'utf8') : '';
check('命令确实经过 su', /SU:-c echo via-root/.test(logText), `log=${logText}`);

console.log('[3] 引号与管道在接管后仍然正确');
const complex = runLikeBashLocal('echo "a b" | tr " " -', { ...process.env });
check('带引号管道的命令结果正确', complex.stdout === 'a-b', `stdout=${complex.stdout}`);

console.log('[4] 卸载后回到基线');
shim.uninstall();
check('PATH 已还原', process.env.PATH === `${work}:${prevPath}` || process.env.PATH === prevPath);
check('shim 目录已删除', existsSync(shim.dir) === false);

process.env.PATH = prevPath;

console.log('');
if (failures === 0) {
  console.log('全部通过 —— 终端命令的接管链条成立。');
  process.exit(0);
} else {
  console.log(`${failures} 项失败。`);
  process.exit(1);
}