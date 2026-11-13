/**
 * Shell 提权层：让 dsh web 的**终端命令本身就带 root / adb 权限**。
 *
 * ## 和「多一个工具」的区别
 *
 * 另一种做法是注册一个 `device_exec` 新工具。但那样 agent 要**选**用哪个工具 ——
 * 而用户的真实诉求是「ai 在 dsh 里敲的命令本来就有 root」：它会照常 `cat /data/adb/...`、
 * 照常 `pm list`、照常 `dumpsys`，不该被要求先判断「这条要不要换工具」。
 *
 * 所以这一层做的是**替换命令的执行者**，不是新增入口：模型看到的还是同一个
 * `bash` 工具、同一套参数，只是底下那条命令真的跑在 uid 0 / adb shell 里。
 *
 * ## 怎么做到的（关键，且不需要改 DSH）
 *
 * 读 `@deepseek-ai/dsh-bash-local` 的源码可见，它的 `execute()` 是：
 *
 * ```js
 * async execute(spec) {
 *   return this.executeArgv(spec, ['bash', '-c', spec.command]);
 * }
 * ```
 *
 * 注意 `'bash'` 是**字面量、不带路径** —— 由 `spawn` 走 `PATH` 查找。而
 * `spawnSpec()` 的 env 是 `{...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv}`，
 * 不覆盖 PATH。
 *
 * 于是：**把 PATH 的最前面插一个自己的目录，里面放一个叫 `bash` 的转接程序**，
 * 就能让所有终端命令都经由它。不改 DSH、不 patch 别人的包、不碰它的内部对象。
 *
 * 转接程序只做一件事：拿到 `-c <command>`，按配置套上执行器再交给真正的 bash：
 *
 * ```
 * root  → su -c "<command>"        （或 doas）
 * adb   → adb -s <serial> shell "<command>"
 * off   → 直接透传给真 bash（等于没装）
 * ```
 *
 * ## 为什么用 sh 脚本而不是再写一个 Node 进程
 *
 * 每条终端命令都会 spawn 一次转接程序。如果它是 `node xxx.js`，每条命令就多
 * 一次 ~40ms 的 Node 启动 —— 而模型一次会话能敲几十上百条命令。POSIX sh 的
 * 启动是微秒级，且不依赖环境里有 node（`dsh web` 可能是用别的 runtime 起的）。
 *
 * ## 安全边界
 *
 * - 默认 `off`：装上插件，终端命令的权限一点没变
 * - 只影响**跑着 dsh web 的那个进程树**，不动系统级 PATH，不动用户的 shell
 * - 卸载/关闭时把 PATH 原样还原（我们只插入自己的目录，移除时精确移除）
 * - 转接程序落在 `~/.dsh/dshgo-shim/`，权限 0700，内容可读可审
 */
import { mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 转接程序所在目录名（在 dsh home 下）。 */
const SHIM_DIR_NAME = 'dshgo-shim';
/** 转接程序文件名。必须叫 bash —— 那就是我们要拦的那个名字。 */
const SHIM_NAME = 'bash';

/** 支持的后端。`off` 表示不接管。 */
export const SHELL_BACKENDS = ['off', 'root', 'adb'];

/**
 * 生成转接脚本。
 *
 * 只处理 `-c <command>` 这一种形式（bash-local 只会用这一种）。其它形式
 * （`bash script.sh`、`bash -l`）原样透传给真 bash —— 我们不该改变
 * bash 的通用语义，只接管「执行一条命令字符串」这个明确的场景。
 *
 * @param {{backend: string, serial?: string, realBash: string, suPath?: string, adbPath?: string, suArgs?: string[]}} opts
 */
export function renderShim(opts) {
  const { backend, realBash, serial } = opts;
  const suPath = opts.suPath ?? 'su';
  const adbPath = opts.adbPath ?? 'adb';

  // 转接程序要能找到「真正的 bash」：把它的绝对路径写死。
  // 不这么做的后果是无穷递归 —— 我们插在 PATH 最前面，脚本里再 `exec bash`
  // 找到的还是自己。
  const real = quote(realBash);

  // ★ 命令要作为一个**整体**传给 su -c / adb shell。
  // 用 "$2" 而不是 $2：后者会把带空格的命令拆成多个参数，
  // `cat /data/adb/x y` 就变成了两个文件。
  let wrapper;
  if (backend === 'adb') {
    const serialArg = serial ? `-s ${quote(serial)} ` : '';
    wrapper = `exec ${quote(adbPath)} ${serialArg}shell "$cmd"`;
  } else if (backend === 'root') {
    wrapper = `exec ${quote(suPath)} -c "$cmd"`;
  } else {
    wrapper = `exec ${real} -c "$cmd"`;
  }

  return `#!/bin/sh
# dshgo shell 提权转接程序 —— 由 @xiazhi88/dshgo 自动生成，删了会被重建。
#
# 作用：把 dsh web 里每条终端命令改由 ${backend} 执行。
# 关闭方式：把 dshgo 配置里的 shell.backend 改回 off 并重启 dsh web
#          （插件会把 PATH 还原、把这个目录删掉）。
#
# 为什么拦的是 bash：@deepseek-ai/dsh-bash-local 的 execute() 固定 spawn
# ['bash', '-c', command]，且 PATH 不在它的 env 覆盖范围内 —— 于是
# 在 PATH 最前面放一个同名脚本就能接管全部终端命令，不用改 DSH 一行代码。
set -u

REAL_BASH=${real}

# 只接管 "bash -c <command>"。其它用法（bash script.sh / bash -l / 交互式）
# 原样交给真 bash，避免改变 bash 本来的语义。
if [ "$#" -ge 2 ] && [ "$1" = "-c" ]; then
  cmd=$2
  shift 2
else
  exec "$REAL_BASH" "$@"
fi

# 空命令：直接成功退出，不必惊动 su/adb（它们会因此弹一次授权框）。
if [ -z "$cmd" ]; then
  exit 0
fi

${wrapper}
`;
}

/**
 * 一处 shell 引号的实现。
 *
 * 只要参数里出现单引号就改用双引号包 + 转义 `$` `` ` `` `\` `"` —— 单引号
 * 内部无法转义，硬用 '' 拼接容易出错，这里选择更直白的路径。
 */
export function quote(value) {
  const text = String(value ?? '');
  if (!text.includes("'")) return `'${text}'`;
  return `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * 在 PATH 里找一个真正的 bash。
 *
 * 必须排除我们自己的 shim 目录，否则会找到转接程序自己 → 无限递归。
 *
 * ## 兜底只在 PATH 完全为空时才启用
 *
 * 一开始写的是「PATH 里找不到就去试 /bin/bash、/usr/bin/bash」。但那样有个
 * 问题：**如果调用方明确把 PATH 限定成 `/nope`，我们还去翻硬编码路径，等于
 * 绕过它的约束**。测试就是这么抓到的（期望 null，实际返回 /bin/bash）。
 *
 * 改成：PATH 有值 → 严格按它找，找不到就是找不到（返回 null，上层告警并降级）；
 * PATH 为空/未设 → 才去试几个常见位置，因为那说明环境本身没给出信息。
 */
export function findRealBash(env = process.env, shimDir = null) {
  const path = String(env.PATH ?? '');
  for (const dir of path.split(':')) {
    if (dir === '' || (shimDir !== null && dir === shimDir)) continue;
    const candidate = `${dir}/bash`;
    if (existsSync(candidate)) return candidate;
  }
  // PATH 完全没给信息时，才去翻常见位置
  if (path.trim() === '') {
    for (const candidate of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 装/卸转接程序，并维护 `process.env.PATH`。
 *
 * 这个类的实例是**进程级单例**（挂在插件 ctx.effect 上）：一个进程只该有
 * 一个 PATH 改动，否则嵌套 effect 会互相覆盖。
 */
export class ShellShim {
  /**
   * @param {{backend: string, serial?: string, suPath?: string, adbPath?: string, warn?: Function, home?: string}} config
   */
  constructor(config) {
    this.config = config;
    this.warn = config.warn ?? (() => {});
    this.home = config.home ?? join(homedir(), '.dsh');
    this.dir = join(this.home, SHIM_DIR_NAME);
    this.shimPath = join(this.dir, SHIM_NAME);
    /** 记下原始 PATH，以便精确还原（而不是「以为还原」）。 */
    this.originalPath = null;
    this.active = false;
  }

  /** 当前后端是否需要接管。 */
  get enabled() {
    const backend = this.config.backend ?? 'off';
    return backend !== 'off';
  }

  /**
   * 安装并激活。返回是否真的接管了。
   *
   * 任何一步失败都**降级成不接管**并打警告，而不是抛异常 —— 提权是附加能力，
   * 拿不到就不该让 `dsh web` 起不来。
   */
  install() {
    if (!this.enabled) return false;
    const backend = this.config.backend;

    const realBash = findRealBash(process.env, this.dir);
    if (realBash === null) {
      this.warn(`dshgo: shell 提权未生效 —— PATH 里找不到真正的 bash（backend=${backend}）`);
      return false;
    }

    // 后端依赖的可执行文件要提前探到绝对路径：转接程序是在子进程里跑的，
    // 那时候的 PATH 已经被我们改过，再去找 su/adb 容易找错。
    let suPath;
    let adbPath;
    if (backend === 'root') {
      suPath = findInPath('su', process.env, this.dir) ?? findInPath('doas', process.env, this.dir);
      if (suPath === null) {
        this.warn('dshgo: shell 提权未生效 —— backend=root 但 PATH 里没有 su / doas');
        return false;
      }
    } else if (backend === 'adb') {
      adbPath = this.config.adbPath || findInPath('adb', process.env, this.dir);
      if (!adbPath) {
        this.warn('dshgo: shell 提权未生效 —— backend=adb 但 PATH 里没有 adb（可配 shell.adbPath）');
        return false;
      }
    }

    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        this.shimPath,
        renderShim({
          backend,
          serial: this.config.serial,
          realBash,
          suPath,
          adbPath,
        }),
        { mode: 0o755 },
      );
      chmodSync(this.shimPath, 0o755);
    } catch (err) {
      this.warn(`dshgo: shell 提权未生效 —— 写转接程序失败：${err?.message ?? err}`);
      return false;
    }

    // ---- 改 PATH ----
    const current = process.env.PATH ?? '';
    if (this.originalPath === null) this.originalPath = current;
    if (!current.split(':').includes(this.dir)) {
      process.env.PATH = current === '' ? this.dir : `${this.dir}:${current}`;
    }
    this.active = true;
    return true;
  }

  /**
   * 撤掉：把 PATH 还原到装机前的样子，并删掉转接目录。
   *
   * 还原用的是**记录的原始值**，不是「把目录字符串删掉」——
   * 如果这期间别的插件也改过 PATH，字符串替换会把它们的改动搞坏。
   */
  uninstall() {
    if (this.originalPath !== null) {
      process.env.PATH = this.originalPath;
      this.originalPath = null;
    }
    this.active = false;
    try {
      if (existsSync(this.shimPath)) rmSync(this.shimPath, { force: true });
      if (existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
    } catch (err) {
      this.warn(`dshgo: 清理转接程序失败（不影响使用）：${err?.message ?? err}`);
    }
  }

  /** 给日志用的一行状态。 */
  describe() {
    if (!this.active) return '未接管（终端命令权限不变）';
    const backend = this.config.backend;
    if (backend === 'adb') {
      const dev = this.config.serial ? ` → ${this.config.serial}` : ' → 默认设备';
      return `已接管：终端命令经 adb shell 执行${dev}`;
    }
    return '已接管：终端命令以 root 执行';
  }
}

/** 在 PATH 里找一个可执行文件（跳过 shim 目录）。 */
function findInPath(name, env, shimDir) {
  const path = String(env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  for (const dir of path.split(':')) {
    if (dir === '' || dir === shimDir) continue;
    const candidate = `${dir}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
