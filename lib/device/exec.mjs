/**
 * 设备执行层：把「手机 / 本机」的 root 与 adb 权限交给 agent。
 *
 * ## 为什么需要它
 *
 * dshgo 现在只有一条链路：浏览器/App → 插件 → `dsh web`。这条链路里 agent 能做
 * 的一切都发生在**跑着 dsh web 的那台机器**上，而且受 DSH 自己的沙箱约束。
 * 而用户真正想要的常常是反过来的方向 —— 让 agent 去操作**手机本体**：
 * 看 `dumpsys`、改 `settings`、`pm grant`、装/卸应用、读写 `/data/adb`、抓 logcat。
 *
 * 这两件事的权限来源完全不同：
 *
 * | 后端 | 权限从哪来 | 典型命令 |
 * |---|---|---|
 * | `adb` | `adb` 客户端 + 一台已授权的设备（USB 或 `adb connect`） | `adb shell ...` |
 * | `root` | 本机已 root（`su -c` / `doas`），或 adbd 已经以 root 跑（`adb root`） | 直接跑、拿到 uid=0 |
 *
 * 所以这里做的不是「提权」，而是**把已经存在的权限接出来给 agent 用**：
 * 检测有什么、用最小必要的方式调用、把结果规范化。
 *
 * ## 安全边界（这是本模块最要紧的一段）
 *
 * 一旦注册成 DSH 工具，模型就能在这台机器上以 root 跑任意命令。所以：
 *
 * 1. **默认关闭**。`enable` 默认 false —— 装上插件不会凭空多出一条 root 通道。
 * 2. **只认本机**。执行入口注册在 `127.0.0.1` 上，且校验代理标记，
 *    与 `/__dshgo__/auth` 用同一套判据 —— 否则局域网里任何人都能远程 root。
 * 3. **单次命令要显式白名单**（`allow` 为空 = 拒绝一切），并且仍然走 DSH 的
 *    审批链（`dsh-user-approval`），所以用户在手机上也能点「允许 / 拒绝」。
 * 4. **超时与输出上限**。命令不许无限跑，输出不许无界写进会话。
 *
 * 换言之：不是给一个万能 shell，而是给一条**可审计、需审批、有白名单**的通道。
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

/** 单次执行默认超时。够跑 `dumpsys`，又不会把会话挂死。 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 超时上限。模型可以传更大的值，但不会被无限制接受。 */
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
/** 单流输出上限（字节）。超了截断并标记，避免把会话撑爆。 */
export const MAX_OUTPUT_BYTES = 128 * 1024;

/**
 * 一条命令的结果。
 *
 * `truncated` 是**两个流各自**的标志 —— 合并成一个的话，stdout 被截断时
 * 用户会以为 stderr 也没了。
 */
function emptyResult(backend, exitCode = null) {
  return {
    backend,
    exitCode,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 0,
    command: '',
  };
}

/**
 * 在 PATH 里找一个可执行文件。
 *
 * 不用 `which`：那是 shell 内建/外部命令，而这里要能在没 shell 的极简环境
 * （容器、busybox 裁剪版）里也工作。逐个目录 `accessSync` 就够了。
 */
export function findExecutable(name, env = process.env) {
  if (typeof name !== 'string' || name === '') return null;
  // 带路径的直接测，别去翻 PATH —— 用户可能写 /usr/local/bin/adb
  if (name.includes('/')) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  const path = String(env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  for (const dir of path.split(':')) {
    if (dir === '') continue;
    const candidate = `${dir}/${name}`;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/**
 * 跑一个进程，收集两个流，带超时。
 *
 * 为什么不用 `exec`/`execSync`：它们把两个流合流或者只给一个。
 * stdout 和 stderr 分开是**必须的** —— `adb` 把设备错误写 stderr 而命令输出写
 * stdout，合在一起会让模型分不清「命令没输出」和「设备没连上」。
 *
 * @param {string} file 可执行文件绝对路径
 * @param {string[]} args 参数数组（**绝不拼字符串**，避免 shell 注入面）
 * @param {{timeoutMs?: number, signal?: AbortSignal, cwd?: string, env?: object}} [opts]
 * @returns {Promise<{stdout: string, stderr: string, stdoutTruncated: boolean, stderrTruncated: boolean, exitCode: number|null, timedOut: boolean, durationMs: number}>}
 */
export function runProcess(file, args, opts = {}) {
  const timeoutMs = Math.min(
    Math.max(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000),
    MAX_TIMEOUT_MS,
  );
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        // ★ 独立进程组。这不是可选项。
        //
        // 只 kill 直接子进程是不够的：`sh -c 'logcat | grep x'` 里真正的
        // 长命进程是管道里的那一个，它继承了 stdout/stderr 的管道写端。
        // sh 死了但子进程还活着 → 管道不关闭 → 'close' 事件永远不来 →
        // 我们的 Promise 挂着，用户看到的是「超时了但命令还占着终端」。
        //
        // detached 让子进程成为新进程组的组长，于是可以用 kill(-pid) 一锅端。
        // 实测（test/device.test.mjs 的「超时会把进程杀掉」）就是这个场景。
        detached: true,
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: `无法启动 ${file}：${err?.message ?? err}`,
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const out = { chunks: [], bytes: 0, truncated: false };
    const err = { chunks: [], bytes: 0, truncated: false };

    /** 边收边计字节，超上限就停止累积（但仍然把流读空，否则子进程会阻塞在写）。 */
    const collector = (bucket) => (chunk) => {
      const room = MAX_OUTPUT_BYTES - bucket.bytes;
      if (room <= 0) {
        bucket.truncated = true;
        return;
      }
      if (chunk.length > room) {
        bucket.chunks.push(chunk.subarray(0, room));
        bucket.bytes += room;
        bucket.truncated = true;
        return;
      }
      bucket.chunks.push(chunk);
      bucket.bytes += chunk.length;
    };

    child.stdout?.on('data', collector(out));
    child.stderr?.on('data', collector(err));

    /**
     * 杀**整个进程组**。返回是否杀成功。
     *
     * 先按组杀（-pid），失败（比如 detached 没生效、或 pid 已回收）再退回
     * 杀单进程。两层都要有：只在 POSIX 有进程组语义，而代码不该假设平台。
     */
    const killTree = (signal) => {
      const pid = child.pid;
      if (typeof pid !== 'number') return;
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          /* 组不存在或已退出，退回单进程 */
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* 已经没了 */
      }
    };

    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let hardStop = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      // 给 2 秒收尾（它可能要把 buffer 刷完）；还赖着就 SIGKILL
      killTimer = setTimeout(() => {
        killTree('SIGKILL');
        // 最后一层保险：SIGKILL 之后管道理论上会关，但如果某个孙进程把自己
        // setsid 出去了，'close' 仍然可能不来。这时宁可返回已经收到的输出，
        // 也不能让调用方无限等待 —— 超时保护的意义就是「一定有结果」。
        hardStop = setTimeout(() => finish(null), 1500);
      }, 2000);
    }, timeoutMs);

    // 外部取消（DSH 的 exec.signal）：同样走「先温和后强硬」
    const onAbort = () => {
      killTree('SIGTERM');
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (hardStop !== null) clearTimeout(hardStop);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve({
        stdout: Buffer.concat(out.chunks).toString('utf8'),
        stderr: Buffer.concat(err.chunks).toString('utf8'),
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (error) => {
      err.chunks.push(Buffer.from(String(error?.message ?? error)));
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * 按 backend 拼真正的命令行。
 *
 * 三种后端：
 * - `adb`  → `adb -s <serial> shell <command>`（serial 省略则交给 adb 自己挑）
 * - `root` → `su -c <command>`，找不到 su 时退回 `doas`
 * - `shell`→ 直接交给 `/bin/sh -c`（无提权，仅本机普通用户）
 *
 * ★ 用 `['-c', command]` 数组形式而不是拼成一整条字符串：command 里允许有
 * 引号、管道、重定向（那是 shell 语法，本来就该由 sh 解释），但**可执行文件
 * 和它的参数边界**不能由用户控制。
 */
export function buildInvocation(backend, command, detection, options = {}) {
  if (backend === 'adb') {
    const adb = detection.adbPath;
    const args = [];
    if (options.serial) args.push('-s', String(options.serial));
    args.push('shell', command);
    return { file: adb, args };
  }
  if (backend === 'root') {
    const su = detection.suPath;
    return { file: su, args: ['-c', command] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

/**
 * 探测这台机器上「有哪些权限可用」。
 *
 * 只做**只读**探测，不改任何状态（不会去 `adb root`、不会去装 su）。
 * 探测失败一律降级成「不可用」，而不是抛异常 —— 插件启动不能因为
 * 没有 adb 就整个挂掉。
 *
 * @returns {Promise<{adb: {available: boolean, path: string|null, devices: Array<{serial: string, state: string, model?: string}>}, root: {available: boolean, path: string|null, method: string|null, uid: number|null}, user: {uid: number|null}}>}
 */
export async function detectCapabilities(env = process.env, opts = {}) {
  // 用户可以在配置里指定 adb 路径（例如 platform-tools 没进 PATH 的情况）。
  // 指定了就直接用，但仍要能执行 —— 否则等于给了个坏路径还不知道。
  const adbPath = (typeof opts.adbPath === 'string' && opts.adbPath !== '')
    ? findExecutable(opts.adbPath, env)
    : findExecutable('adb', env);
  const suPath = findExecutable('su', env) ?? findExecutable('doas', env);
  const rootMethod = suPath === null ? null : suPath.endsWith('/doas') ? 'doas' : 'su';

  const result = {
    adb: { available: false, path: adbPath, devices: [], error: null },
    root: { available: false, path: suPath, method: rootMethod, uid: null, error: null },
    user: { uid: typeof process.getuid === 'function' ? process.getuid() : null },
  };

  // ---- adb：有可执行文件还不够，得真的有 authorized 的设备 ----
  if (adbPath !== null) {
    const r = await runProcess(adbPath, ['devices', '-l'], { timeoutMs: 8000 });
    if (r.exitCode === 0) {
      result.adb.devices = parseAdbDevices(r.stdout);
      // 只有 "device" 状态才算可用；"unauthorized"/"offline" 要明确说出来，
      // 因为这两种的下一步动作完全不同（手机上点授权 vs 重插线/重启 adbd）
      result.adb.available = result.adb.devices.some((d) => d.state === 'device');
    } else {
      result.adb.error = (r.stderr || r.stdout).trim().slice(0, 300) || `adb 退出码 ${r.exitCode}`;
    }
  } else {
    result.adb.error = '没找到 adb 可执行文件（PATH 里没有，也没配 adbPath）';
  }

  // ---- root：真的跑一条命令看是不是 uid=0 ----
  if (suPath !== null) {
    const probe = rootMethod === 'doas'
      ? ['-n', 'id', '-u']
      : ['-c', 'id -u'];
    const r = await runProcess(suPath, probe, { timeoutMs: 8000 });
    const line = (r.stdout || '').trim().split('\n').pop() ?? '';
    if (r.exitCode === 0 && /^\d+$/.test(line.trim())) {
      const uid = Number(line.trim());
      result.root.uid = uid;
      result.root.available = uid === 0;
      if (!result.root.available) result.root.error = `提权成功但 uid=${uid}（不是 0）`;
    } else {
      // 最常见的一种：su 存在但没人授权过 / 弹窗被拒
      const why = (r.stderr || r.stdout).trim().slice(0, 300);
      result.root.error = why || `su 退出码 ${r.exitCode}`;
    }
  } else {
    result.root.error = '没找到 su / doas 可执行文件（这台机器没有 root 通道）';
  }

  // ---- 如果 adbd 本身以 root 跑，那 `adb shell` 出来就是 uid=0 ----
  // 这在「开发机 + 工程 sample」这种场景里很常见，值得单独标出来：
  // 它意味着不需要 su，但仍然需要 adb（不需要 root 手机）。
  if (result.adb.available) {
    const serial = result.adb.devices.find((d) => d.state === 'device')?.serial;
    const args = serial ? ['-s', serial, 'shell', 'id', '-u'] : ['shell', 'id', '-u'];
    const r = await runProcess(adbPath, args, { timeoutMs: 8000 });
    const uid = Number((r.stdout || '').trim());
    result.adb.shellUid = Number.isFinite(uid) ? uid : null;
    result.adb.rootShell = result.adb.shellUid === 0;
  }

  return result;
}

/**
 * 解析 `adb devices -l` 的输出。
 *
 * 格式（一份实测样例）：
 * ```
 * List of devices attached
 * R58M12ABCDE            device product:beyond1q model:SM_G9730 usb:1-1
 * emulator-5554          device product:sdk_gphone64 model:sdk_gphone64
 * 192.168.1.9:5555       unauthorized
 * ```
 * 第一行是表头，空行忽略。第二列是状态，其余 `k:v` 是属性。
 */
export function parseAdbDevices(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('List of devices')) continue;
    if (line.startsWith('*')) continue; // adb 的提示行（如 * daemon started）
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [serial, state, ...rest] = parts;
    const item = { serial, state };
    for (const token of rest) {
      const idx = token.indexOf(':');
      if (idx <= 0) continue;
      const key = token.slice(0, idx);
      const value = token.slice(idx + 1);
      if (key === 'model') item.model = value;
      else if (key === 'product') item.product = value;
      else if (key === 'usb') item.usb = value;
    }
    out.push(item);
  }
  return out;
}

/**
 * 白名单匹配。
 *
 * 设计取向是**宁可让人多写一行，也不要放过没写的那条**：
 *
 * - 空清单 = 全拒（不是全放）
 * - 支持 `*` 通配（`pm *`、`am *`），但 `*` **不能单独出现** ——
 *   那等于关掉白名单，必须显式写 `"allow": ["*"]` 并同时把 `allowAll` 打开，
 *   让「全部放开」这件事在配置里留下一处可搜索的痕迹。
 * - 比较的是命令的**第一个词**（可执行名）。`pm grant x y` 匹配 `pm`。
 */
export function isCommandAllowed(command, allowList) {
  if (!Array.isArray(allowList) || allowList.length === 0) return false;
  const first = firstToken(command);
  if (first === '') return false;
  return allowList.some((pattern) => matchPattern(first, pattern));
}

/** 取命令的第一个词。跳过前导空白与环境变量赋值（`FOO=1 pm ...` 仍算 `pm`）。 */
export function firstToken(command) {
  const text = String(command ?? '').trim();
  if (text === '') return '';
  for (const raw of text.split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue; // 前缀赋值
    return raw;
  }
  return '';
}

/** `*` 通配的单模式匹配。用自己写的而不是正则：避免模式里的元字符意外生效。 */
export function matchPattern(value, pattern) {
  const v = String(value);
  const p = String(pattern);
  if (p === '*') return true;
  const star = p.indexOf('*');
  if (star < 0) return v === p;
  if (star === p.length - 1) return v.startsWith(p.slice(0, -1));
  if (star === 0) return v.endsWith(p.slice(1));
  const head = p.slice(0, star);
  const tail = p.slice(star + 1);
  return v.length >= head.length + tail.length && v.startsWith(head) && v.endsWith(tail);
}

/**
 * 执行一次设备命令。这是工具 `execute` 真正调的东西。
 *
 * 所有拒绝都返回 `{refused: reason}` 而不是抛异常 —— 抛异常会让模型看到
 * 一坨堆栈，而它需要的是「为什么没跑」这一句话。
 *
 * @param {{backend?: 'adb'|'root'|'shell', command: string, serial?: string, timeoutMs?: number}} args
 * @param {{capabilities: object, config: object, signal?: AbortSignal}} ctx
 */
export async function execOnDevice(args, ctx) {
  const config = ctx.config ?? {};
  const caps = ctx.capabilities ?? {};
  const backend = args.backend ?? 'adb';
  const command = String(args.command ?? '').trim();

  if (command === '') {
    return { ...emptyResult(backend), command, refused: '命令为空' };
  }
  if (command.length > 8000) {
    return { ...emptyResult(backend), command: command.slice(0, 200), refused: '命令过长（上限 8000 字符）' };
  }

  // ---- 后端可用性 ----
  if (backend === 'adb') {
    if (!caps.adb?.available) {
      const hint = caps.adb?.error
        ? caps.adb.error
        : '没有处于 device 状态的 adb 设备（unauthorized 需要先在手机上点允许）';
      return { ...emptyResult(backend), command, refused: `adb 不可用：${hint}` };
    }
  } else if (backend === 'root') {
    if (!caps.root?.available) {
      return {
        ...emptyResult(backend),
        command,
        refused: `root 不可用：${caps.root?.error ?? '未检测到可用的 su/doas'}`,
      };
    }
  }

  // ---- 白名单 ----
  const allowAll = config.allowAll === true;
  if (!allowAll && !isCommandAllowed(command, config.allow)) {
    return {
      ...emptyResult(backend),
      command,
      refused: `命令 '${firstToken(command)}' 不在白名单里（config.allow 现在有 ${(config.allow ?? []).length} 条；空清单表示拒绝一切）`,
    };
  }

  // ---- 拼命令并跑 ----
  const detection = {
    adbPath: caps.adb?.path ?? null,
    suPath: caps.root?.path ?? null,
  };

  /**
   * adb 的 serial 选择。
   *
   * 模型通常不传 serial（「就跑在连着的那台」）。这时**我们主动补上唯一那台**，
   * 而不是留给 adb 自己挑，理由有两个：
   *
   * 1. 日志可追溯。`adb shell x` 和 `adb -s ABC shell x` 在 `adb devices` 输出
   *    变化之后行为不同 —— 前者会突然改连另一台，后者不会。
   * 2. 多设备时给一句人话。让 adb 自己报
   *    `more than one device/emulator` 也行，但模型拿到那句话不知道该填什么；
   *    我们直接把候选 serial 列出来，它下一次调用就能改对。
   */
  let serial = args.serial;
  if (backend === 'adb' && (serial === undefined || serial === '')) {
    const ready = (caps.adb?.devices ?? []).filter((d) => d.state === 'device');
    if (ready.length === 1) {
      serial = ready[0].serial;
    } else if (ready.length > 1) {
      return {
        ...emptyResult(backend),
        command,
        refused: `连了 ${ready.length} 台设备（${ready.map((d) => d.serial).join(', ')}），必须用 serial 指定一台`,
      };
    }
  }

  const invocation = buildInvocation(backend, command, detection, { serial });
  if (!invocation.file) {
    return { ...emptyResult(backend), command, refused: `后端 ${backend} 缺少可执行文件` };
  }

  const r = await runProcess(invocation.file, invocation.args, {
    timeoutMs: args.timeoutMs,
    signal: ctx.signal,
  });

  return {
    backend,
    command,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    stdoutTruncated: r.stdoutTruncated,
    stderrTruncated: r.stderrTruncated,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    serial: backend === 'adb' ? args.serial ?? null : null,
  };
}
