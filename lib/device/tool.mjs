/**
 * 把设备执行层注册成 DSH 工具。
 *
 * ## 为什么工具要单独一个文件
 *
 * `lib/index.js` 已经很满了（代理、闸门、密码、自描述端点），而工具注册是**另一条
 * 生命周期**：它依赖 `ctx.tools`，而 `ctx.tools` 由宿主组合决定（headless profile 里
 * 不一定有）。放一起的话，插件主体得为「有没有 tools」写一堆分支。
 *
 * 单独成文件之后：
 * - 没有 `tools` 服务 → 这一层整体不挂载，代理照常工作
 * - 没有 `@deepseek-ai/dsh-tools` → 打一行警告，不崩
 *
 * 两条降级都必须存在。dshgo 的本职是「让手机连得上」，设备执行是**附加能力**，
 * 它挂掉不能连累主链路。
 */
import { detectCapabilities, execOnDevice, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from './exec.mjs';

/** 工具名。带前缀是为了在工具列表里一眼看出归属。 */
export const EXEC_TOOL = 'device_exec';
export const STATUS_TOOL = 'device_status';

/** 能力探测结果缓存多久。太短会每次调用都跑一遍 `su`（会反复弹授权框）。 */
const CAPS_TTL_MS = 60_000;

/**
 * 造一个带 TTL 的能力探测器。
 *
 * ★ 这个缓存是**必需的**，不是优化：Android 的 `su` 管理器每次调用都可能弹一次
 * 「授予超级用户权限」。如果每条命令都探测一次，用户会被弹到怀疑人生，
 * 最后干脆去关掉开关 —— 那就等于这个功能白做。
 *
 * 但 TTL 也不能太长：用户可能在会话中途插上 USB、在手机上点了「允许调试」，
 * 一分钟内能感知到是合理的等待。
 */
export function createCapabilityProbe({ now = Date.now, detect = detectCapabilities, ttlMs = CAPS_TTL_MS } = {}) {
  let cached = null;
  let at = 0;
  let inflight = null;
  return async function probe(force = false) {
    const t = now();
    if (!force && cached !== null && t - at < ttlMs) return cached;
    // 并发调用合并成一次探测：工具可能被并行调用（模型可以一次发多条）
    if (inflight !== null) return inflight;
    inflight = (async () => {
      try {
        const caps = await detect();
        cached = caps;
        at = now();
        return caps;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

/** 把能力探测结果写成一行人类可读的摘要（终端日志与 status 工具共用）。 */
export function capabilitiesSummary(caps) {
  const parts = [];
  if (caps.adb?.available) {
    const devices = caps.adb.devices.filter((d) => d.state === 'device');
    const label = devices.map((d) => d.model ?? d.serial).join(', ');
    parts.push(`adb 可用（${devices.length} 台：${label}${caps.adb.rootShell ? '，adbd 已是 root' : ''}）`);
  } else if (caps.adb?.path) {
    const states = caps.adb.devices.map((d) => `${d.serial}=${d.state}`).join(', ');
    parts.push(`adb 有可执行文件但没好用的设备（${states || caps.adb.error || '列表为空'}）`);
  } else {
    parts.push('adb 不可用（没装 platform-tools 或不在 PATH）');
  }
  if (caps.root?.available) parts.push(`root 可用（${caps.root.method}，uid=0）`);
  else parts.push(`root 不可用（${caps.root?.error ?? '未知原因'}）`);
  return parts.join('；');
}

/**
 * 注册工具。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 * @param {object} config dshgo 的配置（用到 device 那一节）
 * @param {(msg: string) => void} warn 日志出口
 * @returns {Promise<{registered: string[], skipped: string}>} 注册结果，便于启动日志说明
 */
export async function registerDeviceTools(ctx, config, warn, deps = {}) {
  const device = config?.device ?? {};
  if (device.enable !== true) {
    return { registered: [], skipped: 'device.enable 未开启（默认关闭，需在配置里显式打开）' };
  }
  if (ctx.get('tools') === undefined) {
    return { registered: [], skipped: '宿主没有 tools 服务（headless profile？）' };
  }

  // 动态 import：包不在时给一句人话，而不是让整个插件加载失败。
  // 这里**不能**用静态 import —— ESM 的静态 import 失败是模块级错误，
  // 会让 `import('./lib/index.js')` 直接抛，连代理都起不来。
  //
  // `deps.defineTool` 是给测试用的注入点：`@deepseek-ai/dsh-tools` 由宿主提供，
  // 本包的 devDependencies 里没有它，所以单测/集成测试没法真的 import 到。
  // 注入之后，注册流程（ctx.effect + ctx.tools.register）照样走真实路径。
  let defineTool = deps.defineTool;
  if (defineTool === undefined) {
    try {
      ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
    } catch (err) {
      warn(`dshgo: 设备执行层未启用 —— 找不到 @deepseek-ai/dsh-tools（${err?.message ?? err}）`);
      return { registered: [], skipped: '缺少 @deepseek-ai/dsh-tools' };
    }
  }

  const probe = createCapabilityProbe({
    detect: () => detectCapabilities(process.env, { adbPath: device.adbPath }),
  });
  const registered = [];

  const backendSchema = {
    type: 'string',
    enum: ['adb', 'root', 'shell'],
    description: 'Which permission to use: "adb" (adb shell to the connected phone), "root" (su/doas on this machine), "shell" (plain /bin/sh, no privilege).',
  };

  // ---------------------------------------------------------------- device_exec
  const execTool = defineTool({
    name: EXEC_TOOL,
    description:
      'Run one shell command on the phone/device through an already-granted adb or root channel. '
      + 'Use it for inspecting or changing the device: dumpsys, settings, pm/am, logcat, /data/adb, app ops. '
      + 'It is NOT a general way to escalate privilege: the channel must already exist (device authorized '
      + 'for adb, or a su/doas that grants uid 0) and the command must match the allow-list. '
      + 'Prefer the narrowest backend that works; use "adb" before "root" when both work.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
      },
      command: {
        type: 'string',
        required: true,
        description: 'The shell command to run on the device. Shell syntax (pipes, redirects, quotes) is allowed.',
      },
      backend: backendSchema,
      serial: {
        type: 'string',
        description: 'For backend "adb": target device serial (from device_status). Omit when only one device is connected.',
      },
      timeoutMs: {
        type: 'number',
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, cap ${MAX_TIMEOUT_MS}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          backend: { type: 'string', required: true },
          command: { type: 'string', required: true },
          exitCode: { type: 'number' },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          stdoutTruncated: { type: 'boolean', required: true },
          stderrTruncated: { type: 'boolean', required: true },
          timedOut: { type: 'boolean', required: true },
          durationMs: { type: 'number', required: true },
          serial: { type: 'string' },
          refused: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.refused !== undefined) {
          return [{ type: 'text', text: `[${value.backend}] 未执行：${value.refused}` }];
        }
        const head = `[${value.backend}${value.serial ? ` ${value.serial}` : ''}] exit=${value.exitCode ?? 'null'} ${value.durationMs}ms`
          + (value.timedOut ? '（超时被杀）' : '');
        const body = value.stdout.trim();
        const err = value.stderr.trim();
        const notes = [];
        if (value.stdoutTruncated) notes.push('stdout 已截断');
        if (value.stderrTruncated) notes.push('stderr 已截断');
        return [{
          type: 'text',
          text: [
            head,
            body === '' ? '(stdout 为空)' : body,
            err === '' ? '' : `[stderr]\n${err}`,
            notes.length > 0 ? `[注意] ${notes.join('；')}` : '',
          ].filter((x) => x !== '').join('\n'),
        }];
      },
      presentationMeta: (_args, value) => ({ backend: value.backend, exitCode: value.exitCode ?? null }),
    },
    // 命令是**副作用**，不许和兄弟调用并行 —— 两条 adb 命令并发时输出会交错，
    // 而模型会把它当成一条命令的结果读。
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const caps = await probe();
      const result = await execOnDevice(
        {
          backend: args.backend ?? 'adb',
          command: args.command,
          serial: args.serial,
          timeoutMs: args.timeoutMs,
        },
        { capabilities: caps, config: device, signal: exec.signal },
      );
      // 被拒绝时清掉缓存：很可能是用户刚在手机上点了授权，或刚插上线。
      // 不清的话模型会连续几次撞同一面墙，然后把「adb 不可用」写进结论里。
      if (result.refused !== undefined && /不可用|没有/.test(result.refused)) void probe(true);
      return result;
    },
  });

  // ---------------------------------------------------------------- device_status
  const statusTool = defineTool({
    name: STATUS_TOOL,
    description:
      'Report which device channels are currently available: adb (path, devices and their states), '
      + 'root (su/doas and whether it really yields uid 0), and whether the allow-list will accept a command. '
      + 'Call this before device_exec when you are unsure which backend to use.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of why the status is needed, 5-10 words.',
      },
      refresh: {
        type: 'boolean',
        description: 'Force a fresh probe instead of the cached one (after plugging in a cable or granting su).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          adb: {
            type: 'object',
            additionalProperties: false,
            properties: {
              available: { type: 'boolean', required: true },
              path: { type: 'string' },
              rootShell: { type: 'boolean' },
              devices: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    serial: { type: 'string', required: true },
                    state: { type: 'string', required: true },
                    model: { type: 'string' },
                  },
                },
              },
              error: { type: 'string' },
            },
          },
          root: {
            type: 'object',
            additionalProperties: false,
            properties: {
              available: { type: 'boolean', required: true },
              method: { type: 'string' },
              uid: { type: 'number' },
              error: { type: 'string' },
            },
          },
          allow: { type: 'array', items: { type: 'string' } },
          allowAll: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [value.summary];
        lines.push(value.allowAll ? '白名单：全部放开（allowAll=true）' : `白名单：${(value.allow ?? []).join(', ') || '（空 —— 拒绝一切命令）'}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const caps = await probe(args.refresh === true);
      return {
        summary: capabilitiesSummary(caps),
        adb: {
          available: caps.adb?.available === true,
          ...(caps.adb?.path ? { path: caps.adb.path } : {}),
          ...(caps.adb?.rootShell !== undefined ? { rootShell: caps.adb.rootShell } : {}),
          devices: (caps.adb?.devices ?? []).map((d) => ({
            serial: d.serial,
            state: d.state,
            ...(d.model ? { model: d.model } : {}),
          })),
          ...(caps.adb?.error ? { error: String(caps.adb.error) } : {}),
        },
        root: {
          available: caps.root?.available === true,
          ...(caps.root?.method ? { method: caps.root.method } : {}),
          ...(caps.root?.uid !== null && caps.root?.uid !== undefined ? { uid: caps.root.uid } : {}),
          ...(caps.root?.error ? { error: String(caps.root.error) } : {}),
        },
        allow: Array.isArray(device.allow) ? device.allow : [],
        allowAll: device.allowAll === true,
      };
    },
  });

  // 两个工具一起注册；任一失败不影响另一个，但要各自报出来。
  for (const [tool, label] of [[execTool, EXEC_TOOL], [statusTool, STATUS_TOOL]]) {
    try {
      ctx.effect(() => ctx.tools.register(tool), `dshgo: ${label}`);
      registered.push(label);
    } catch (err) {
      warn(`dshgo: 注册工具 ${label} 失败 —— ${err?.message ?? err}`);
    }
  }

  if (registered.length > 0) {
    // 启动时主动探一次并把结论打出来。用户装完就重启 `dsh web`，这一行
    // 是他判断「到底有没有生效」的唯一线索 —— 不能等到第一次调用才说。
    const caps = await probe().catch(() => null);
    if (caps !== null) {
      warn(`dshgo: 设备执行层已启用（${registered.join(', ')}）—— ${capabilitiesSummary(caps)}`);
      if (!device.allowAll && (device.allow ?? []).length === 0) {
        warn('dshgo: 注意 config.device.allow 为空 —— 任何命令都会被拒绝，先填上要放行的命令名');
      }
    }
  }

  return { registered, skipped: null };
}