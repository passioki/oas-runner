// OAS Runner（使用端）UI。
// 独立于 Studio 的编辑器脚本：不加载构建/流程/素材模块，也不调用创作或构建接口。
// PR7 起队列页也写 scheduler.json（条目/队列/高级 JSON）和 /scheduler/reset；
// 所有请求统一经过 runnerFetchJson（超时、HTTP 错误、JSON 错误归一化）。
'use strict';

(function () {
  const RUNNER_FETCH_TIMEOUT_MS = 8000;
  const RUNNER_RUNS_LIMIT = 100;
  const RUNNER_RECENT_LIMIT = 5;
  // PR6：队列页调度状态轮询 + 临时运行结果轮询。
  const RUNNER_SCHED_POLL_MS = 5000;
  const RUNNER_RUN_POLL_MS = 500;
  // seq151：60s 不是失败阈值，只是历史提示线；轮询指数退避到 2s 并持续到
  // running=false。seq196：运行中可随时点「停止运行」（后端在步骤边界退出）。
  const RUNNER_RUN_POLL_MAX_DELAY_MS = 2000;
  const RUNNER_RUN_ELAPSED_WARN_MS = 60000;
  // P0-1a：页面可见时轮询 Studio 发布通知（exchange）；
  // 页面隐藏时暂停计时器（见 init() 中的 visibilitychange 处理）。
  const RUNNER_UPDATES_POLL_MS = 5000;
  const RUNNER_RUN_LOG_TAIL = 20;
  // POST /runner/scheduler/stop 在 3 秒内应答（长尝试收尾时返回 `timeout:true`）；
  // UI 随后自行轮询调度状态：1 秒一次，30 秒预算，
  // 30 s budget, so a long attempt is shown as "停止中" instead of "停止失败".
  const RUNNER_STOP_POLL_MS = 1000;
  const RUNNER_STOP_POLL_MAX_MS = 30000;
  const RUNNER_PAGES = ['overview', 'tasks', 'packages', 'queue', 'runs', 'settings'];
  const RUNNER_PAGE_LABELS = {
    overview: '概览',
    tasks: '已安装任务',
    packages: '安装包',
    queue: '队列与调度',
    runs: '运行记录',
    settings: '设置',
  };
  const RUNNER_API = {
    health: '/runner/health',
    tasks: '/runner/tasks',
    packages: '/runner/packages',
    install: '/runner/install',
    uninstall: '/runner/uninstall',
    packagesActivate: '/runner/packages/activate',
    updates: '/runner/updates',
    updatesAck: '/runner/updates/ack',
    updatesInstall: '/runner/updates/install',
    schedulerStatus: '/scheduler/status',
    schedulerConfig: '/scheduler/config',
    schedulerStart: '/runner/scheduler/start',
    schedulerStop: '/runner/scheduler/stop',
    schedulerThreadStatus: '/runner/scheduler/status',
    run: '/runner/run',
    runStatus: '/runner/run/status',
    runStop: '/runner/run/stop',
    schedulerRuns: '/runs/scheduler',
    schedulerReset: '/scheduler/reset',
    config: '/config',
    instance: '/instance',
  };

  const state = {
    page: 'overview',
    busy: false,
    queued: false,
    health: null,
    tasks: null,
    packages: null,
    updates: null,
    recentRuns: null,
    recentRunsError: '',
    scheduler: null,
    runnerScheduler: null,
    schedConfig: null,
    runs: null,
    config: null,
    instance: null,
  };

  const el = {};

  // PR2: 当前打开的任务配置对话框状态（运行值保存在 Runner 本机）。
  let configTask = '';
  let configParams = [];
  let configLoaded = false;
  let configBusy = false;
  // P2：当前打开任务的已保存值（决定使用开关默认值与提示）。
  let configValues = {};

  // PR5: 安装/卸载/回滚是串行操作；期间禁用安装按钮并拒绝重复提交。
  let packagesBusy = false;

  // P0-1a: 新发布（exchange）的安装/忽略/轮询也是串行的，且轮询只在页面可见时跑。
  let updatesBusy = false;
  let updatesPollTimer = null;

  // PR6：调度启动/停止、临时运行与 scheduler.json 保存均为串行操作；
  // 计时器是唯一长期存在的状态。
  let schedBusy = false;
  let schedStopping = false;
  let runBusy = false;
  // seq196：停止请求已发出、等 worker 在步骤边界退出。
  let runStopping = false;
  let runPollTimer = null;
  let runPollStartedMs = 0;
  // seq151：当前轮询退避间隔（500ms→1s→2s cap）与恢复请求去重。
  let runPollDelayMs = RUNNER_RUN_POLL_MS;
  let runRecoverInFlight = false;
  let queuePollTimer = null;
  let stopPollTimer = null;
  let stopPollStartedMs = 0;

  // --- 纯格式化辅助（无 DOM 依赖；ui_pure_test 会单独抽取验证） ---------------

  function runnerValueText(value) {
    if (value === undefined || value === null || value === '') return '—';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      const text = JSON.stringify(value);
      return text == null ? '—' : text;
    } catch (e) {
      return String(value);
    }
  }

  function runnerTimeText(ms) {
    if (ms === undefined || ms === null || ms === '') return '—';
    const n = Number(ms);
    if (!isFinite(n) || n <= 0) return '—';
    try {
      return new Date(n).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      return String(ms);
    }
  }

  function runnerDurationText(ms) {
    if (ms === undefined || ms === null || ms === '') return '—';
    const n = Number(ms);
    if (!isFinite(n) || n < 0) return '—';
    if (n < 1000) return Math.round(n) + 'ms';
    if (n < 60000) return (n / 1000).toFixed(1) + 's';
    const total = Math.round(n / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return h + 'h' + m + 'm';
    return m + 'm' + s + 's';
  }

  function runnerRunDurationMs(run) {
    const r = run || {};
    const direct = Number(r.duration_ms);
    if (r.duration_ms !== undefined && r.duration_ms !== null && r.duration_ms !== '' &&
        isFinite(direct) && direct >= 0) {
      return direct;
    }
    const start = Number(r.started_ms);
    const end = Number(r.finished_ms);
    if (r.started_ms !== undefined && r.started_ms !== null && r.started_ms !== '' &&
        r.finished_ms !== undefined && r.finished_ms !== null && r.finished_ms !== '' &&
        isFinite(start) && isFinite(end) && end >= start) {
      return end - start;
    }
    return null;
  }

  function runnerErrorText(error) {
    if (error === undefined || error === null) return '';
    if (typeof error === 'string') return error.trim();
    if (typeof error === 'number' || typeof error === 'boolean') return String(error);
    if (typeof error === 'object' && error.message) return String(error.message);
    try {
      const text = JSON.stringify(error);
      return text == null ? '' : text;
    } catch (e) {
      return String(error);
    }
  }

  function runnerErrorSummary(error, maxLen) {
    const text = runnerErrorText(error).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const limit = Number(maxLen) > 0 ? Math.floor(Number(maxLen)) : 80;
    return text.length > limit ? text.slice(0, Math.max(0, limit - 1)) + '…' : text;
  }

  function runnerRunsErrorText(reason) {
    const text = String(reason === undefined || reason === null ? '' : reason).trim();
    return '运行记录读取失败：' + (text || '未知错误');
  }

  function runnerParamKeys(params) {
    if (params === undefined || params === null) return [];
    if (Array.isArray(params)) {
      return params.map(function (p) {
        if (p && typeof p === 'object') return String(p.key === undefined || p.key === null ? '' : p.key).trim();
        return String(p === undefined || p === null ? '' : p).trim();
      }).filter(Boolean);
    }
    if (typeof params === 'object') return Object.keys(params);
    return [];
  }

  function runnerFlagText(value) {
    if (value === true) return '有';
    if (value === false) return '无';
    return '—';
  }

  function runnerTaskStatusText(task) {
    const t = task || {};
    return t.unmanaged === false ? '已安装' : '未托管/本机目录';
  }

  function runnerOutcomeClass(outcome) {
    const key = String(outcome === undefined || outcome === null ? '' : outcome).trim().toLowerCase();
    if (key === 'done' || key === 'success') return 'ok';
    if (key === 'failed' || key === 'fatal' || key === 'error') return 'err';
    if (key === 'exhausted' || key === 'resource' || key === 'blocked' || key === 'retryable') return 'warn';
    return 'kind';
  }

  function runnerLockText(lock) {
    if (lock === undefined || lock === null) return '调度锁 空闲';
    if (typeof lock === 'boolean') return '调度锁 ' + (lock ? '占用' : '空闲');
    if (typeof lock === 'number') return '调度锁 占用（pid ' + lock + '）';
    if (typeof lock === 'string') {
      const text = lock.trim();
      return text ? '调度锁 ' + text : '调度锁 空闲';
    }
    if (typeof lock === 'object') {
      const held = lock.held !== undefined ? lock.held
        : (lock.running !== undefined ? lock.running : undefined);
      const pid = lock.pid !== undefined ? lock.pid : lock.lock_pid;
      if (held === false) return '调度锁 空闲';
      if (pid !== undefined && pid !== null && pid !== '') return '调度锁 占用（pid ' + pid + '）';
      if (held === true) return '调度锁 占用';
      return '调度锁 空闲';
    }
    return '调度锁 —';
  }

  function runnerLockClass(lock) {
    const text = runnerLockText(lock);
    if (text.indexOf('占用') >= 0) return 'warn';
    if (text.indexOf('空闲') >= 0) return 'ok';
    return 'kind';
  }

  function runnerRunningText(running) {
    if (running === undefined || running === null || running === '') return '空闲';
    if (typeof running === 'string') return running;
    if (typeof running !== 'object') return String(running);
    const bits = [];
    if (running.entry_id) bits.push(String(running.entry_id));
    if (running.task) bits.push(String(running.task));
    if (running.pass !== undefined && running.pass !== null && running.pass !== '') {
      bits.push('pass ' + running.pass);
    }
    if (running.attempt !== undefined && running.attempt !== null && running.attempt !== '') {
      bits.push('attempt ' + running.attempt);
    }
    if (running.since_local) bits.push('自 ' + running.since_local);
    return bits.length ? bits.join(' · ') : '执行中';
  }

  function runnerGuardText(guards) {
    if (!guards || typeof guards !== 'object') return '—';
    if (guards.blocked) {
      return '已阻断' + (guards.blackout_reason ? '（' + guards.blackout_reason + '）' : '');
    }
    const active = Array.isArray(guards.active_hours) ? guards.active_hours.length : 0;
    const blackouts = Array.isArray(guards.blackouts) ? guards.blackouts.length : 0;
    return '正常（时段 ' + active + ' · 屏蔽 ' + blackouts + '）';
  }

  function runnerEntryStateText(entry) {
    const e = entry || {};
    let text = e.enabled === false ? '停用' : (e.enabled === true ? '启用' : '—');
    if (e.blocked_reason) text += ' · 等待 ' + e.blocked_reason;
    else if (e.runnable_now === true) text += ' · 可运行';
    return text;
  }

  function runnerQueueRoundsText(queue) {
    const q = queue || {};
    const total = Number(q.total_rounds);
    const done = Number(q.rounds_completed);
    const completed = isFinite(done) && done >= 0 ? Math.floor(done) : 0;
    if (!isFinite(total) || total <= 0) return completed + '/∞';
    return completed + '/' + Math.floor(total);
  }

  function runnerClicksText(value) {
    if (value === undefined || value === null || value === '') return '—';
    if (typeof value === 'number' || typeof value === 'string') return String(value);
    return runnerValueText(value);
  }

  function runnerExitText(run) {
    const r = run || {};
    if (r.exit_code !== undefined && r.exit_code !== null && r.exit_code !== '') {
      return runnerValueText(r.exit_code);
    }
    if (r.exit !== undefined && r.exit !== null && r.exit !== '') return runnerValueText(r.exit);
    return '—';
  }

  function runnerMemberText(value) {
    if (value === undefined || value === null || value === '') return '—';
    const n = Number(value);
    if (isFinite(n) && n >= 0) return '成员 ' + (Math.floor(n) + 1);
    return String(value);
  }

  // --- PR2: 任务配置值（纯函数，ui_pure_test 单独抽取执行） -------------------
  // schema 来自发布包的 meta.params（Studio 定义）；这里只负责生成表单、
  // 收集/转换本机运行值并拼 API URL。不依赖 DOM。

  function runnerConfigFieldKind(param) {
    const p = param && typeof param === 'object' ? param : {};
    const type = String(p.type === undefined || p.type === null ? '' : p.type).trim().toLowerCase();
    if (type === 'bool' || type === 'boolean') return 'bool';
    // P2：数值类型同样优先按枚举处理（修复“数字输入 + 提示”界面）；
    // 成员合法性仍由服务端校验。
    if (Array.isArray(p.enum) && p.enum.length) return 'select';
    if (type === 'int' || type === 'integer' || type === 'float' || type === 'number') {
      return 'number';
    }
    return 'text';
  }

  function runnerConfigIsIntegerType(param) {
    const p = param && typeof param === 'object' ? param : {};
    const type = String(p.type === undefined || p.type === null ? '' : p.type).trim().toLowerCase();
    return type === 'int' || type === 'integer';
  }

  function runnerConfigInitialValue(param, values) {
    const p = param && typeof param === 'object' ? param : {};
    const key = p.key === undefined || p.key === null ? '' : String(p.key).trim();
    const src = values && typeof values === 'object' ? values : {};
    if (key && Object.prototype.hasOwnProperty.call(src, key)) {
      const current = src[key];
      if (current !== undefined && current !== null) return current;
    }
    if (p.default !== undefined && p.default !== null) return p.default;
    return runnerConfigFieldKind(p) === 'bool' ? false : '';
  }

  // fieldValues 保存控件原始字符串。可选的 `useFlags` 映射记录
  // P2 per-key「使用」switch: false = 不注入（回退 default）。Missing useFlags keeps
  // 保持 v1 行为（每个已提供字段都会提交）。
  function runnerConfigCollectValues(params, fieldValues, useFlags) {
    const list = Array.isArray(params) ? params : [];
    const fields = fieldValues && typeof fieldValues === 'object' ? fieldValues : {};
    const flags = useFlags && typeof useFlags === 'object' ? useFlags : null;
    const values = {};
    const errors = [];
    for (const param of list) {
      if (!param || typeof param !== 'object' || Array.isArray(param)) continue;
      const key = param.key === undefined || param.key === null ? '' : String(param.key).trim();
      if (!key) continue;
      const rawLabel = param.label === undefined || param.label === null ? '' : String(param.label).trim();
      const label = rawLabel || key;
      const kind = runnerConfigFieldKind(param);
      const hasDefault = param.default !== undefined && param.default !== null;
      if (flags && flags[key] === false) {
        // 取消使用 = 不注入；required 且无默认值时本地就拦下（否则运行期缺参）。
        if (param.required === true && !hasDefault) {
          errors.push('「' + label + '」是必填项（不能留空或不使用）');
        }
        continue;
      }
      const raw = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
      let present = true;
      let value;
      if (kind === 'bool') {
        // P2: 三态（未设置 / 是 / 否）；'' = 未设置 ⇒ 不写入 values。
        const tri = runnerParamBoolTri(raw);
        if (!tri) {
          present = false;
        } else {
          value = tri === 'true';
        }
      } else if (kind === 'number') {
        const text = raw === undefined || raw === null ? '' : String(raw).trim();
        if (!text) {
          present = false;
        } else {
          const num = Number(text);
          if (!isFinite(num)) {
            errors.push('「' + label + '」必须是数字（当前：' + text + '）');
            continue;
          }
          if (runnerConfigIsIntegerType(param) && !Number.isInteger(num)) {
            errors.push('「' + label + '」必须是整数');
            continue;
          }
          // min/max/enum 以服务端为准：直接提交值，
          // 由 400 错误指出字段名 + 范围/选项（对话框逐行
          // 原样展示服务端错误）。本地检查仅限
          // 类型转换，不让 UI 掩盖真实 API 契约。
          value = num;
        }
      } else {
        const text = raw === undefined || raw === null ? '' : String(raw);
        if (!text) {
          present = false;
        } else {
          const options = Array.isArray(param.enum) ? param.enum.map(String) : [];
          // P2：数值枚举改用下拉框；保持 JSON 数字类型，
          // 以便服务端 schema（type=int/number）仍接受该值。数值
          // 枚举成员合法性仍由服务端判定（本地不提前拦截 400）。
          const paramType = String(param.type === undefined || param.type === null ? '' : param.type)
            .trim()
            .toLowerCase();
          const numericType = paramType === 'int' || paramType === 'integer' ||
            paramType === 'float' || paramType === 'number';
          if (!numericType && options.length && options.indexOf(text) < 0) {
            errors.push('「' + label + '」必须是以下之一：' + options.join(' / '));
            continue;
          }
          if (numericType) {
            const num = Number(text);
            if (!isFinite(num)) {
              errors.push('「' + label + '」必须是数字（当前：' + text + '）');
              continue;
            }
            if (runnerConfigIsIntegerType(param) && !Number.isInteger(num)) {
              errors.push('「' + label + '」必须是整数');
              continue;
            }
            value = num;
          } else {
            value = text;
          }
        }
      }
      if (!present) {
        if (param.required === true && !hasDefault) {
          errors.push('「' + label + '」是必填项（不能留空或不使用）');
        }
        continue;
      }
      values[key] = value;
    }
    return { ok: errors.length === 0, values: values, errors: errors };
  }

  function runnerConfigUrl(task) {
    const name = String(task === undefined || task === null ? '' : task).trim();
    return '/runner/tasks/' + encodeURIComponent(name) + '/config';
  }

  // --- P2: Runner 参数页（纯函数，ui_pure_test 单独抽取执行） ------------------
  // 按 meta.params[].group 分节 + 每参「使用」开关 + 留空=不注入 + bool 三态。
  // 用户 D2 澄清：不做预设值集合管理，分组只用 meta.params 的 group 字段。

  function runnerParamDefaultText(param) {
    const p = param && typeof param === 'object' ? param : {};
    if (p.default === undefined || p.default === null) return '';
    if (p.default === '') return '（空字符串）';
    if (typeof p.default === 'string') return p.default;
    if (typeof p.default === 'number' || typeof p.default === 'boolean') return String(p.default);
    try {
      return JSON.stringify(p.default);
    } catch (e) {
      return String(p.default);
    }
  }

  // Declared order preserved; empty/missing group falls into 「通用」. Groups are
  // ordered by first appearance in meta.params. 派生参数行（带 asset_id，来自
  // ocr_var 素材）永远进入最前面的独立分组「使用端OCR文字配置项」（Lead 裁决 8：
  // UI 全名；行内短标「识别文字配置」）；旧任务 role=ocr_text 但无 asset_id 的行
  // 仍按自己的 group 分节（兼容，不破坏旧行为）。

  // 完整分组模型：一个前置 ocr_var 分区 + 常规分组分区。
  // `kind` 让渲染/测试无需字符串匹配即可区分两者。
  function runnerParamGroupsEx(params) {
    const list = Array.isArray(params) ? params : [];
    const groups = [];
    const index = {};
    const derived = { group: '使用端OCR文字配置项', kind: 'ocr_var', params: [] };
    for (const param of list) {
      if (!param || typeof param !== 'object' || Array.isArray(param)) continue;
      const assetId = param.asset_id === undefined || param.asset_id === null
        ? ''
        : String(param.asset_id).trim();
      if (assetId) {
        derived.params.push(param);
        continue;
      }
      const raw = param.group === undefined || param.group === null ? '' : String(param.group).trim();
      const group = raw || '通用';
      if (!Object.prototype.hasOwnProperty.call(index, group)) {
        index[group] = groups.length;
        groups.push({ group: group, kind: 'group', params: [] });
      }
      groups[index[group]].params.push(param);
    }
    return derived.params.length ? [derived].concat(groups) : groups;
  }

  // 供汇总/收集器/渲染器使用的向后兼容视图。
  function runnerParamGroups(params) {
    return runnerParamGroupsEx(params).map(function (group) {
      return { group: group.group, params: group.params };
    });
  }

  // D 批（去参数 UI）：Runner 只显示/收集「使用端OCR文字配置项」（asset_id 派生行）；
  // 通用参数组隐藏（代码保留，服务端 meta.params 派生模型不动）。
  function runnerParamOcrVarOnly(params) {
    const list = Array.isArray(params) ? params : [];
    return list.filter(function (param) {
      if (!param || typeof param !== 'object' || Array.isArray(param)) return false;
      const assetId = param.asset_id === undefined || param.asset_id === null
        ? ''
        : String(param.asset_id).trim();
      return !!assetId;
    });
  }

  // --- V2.0c：Runner「使用端变量」分节（meta.variables；替换 meta.params 派生行） --
  // 只显示 runner_editable && scope=input 的变量；ocr_text 在前（识别文字变量），
  // 其余（literal）按 group 分节（空组=通用）。
  function runnerVariableEditable(variable) {
    const v = variable && typeof variable === 'object' && !Array.isArray(variable) ? variable : null;
    if (!v) return false;
    if (v.runner_editable === false) return false;
    const scope = String(v.scope === undefined || v.scope === null ? 'input' : v.scope).trim();
    return scope !== 'runtime';
  }

  function runnerVariableRows(variables) {
    const list = Array.isArray(variables) ? variables : [];
    return list.filter(runnerVariableEditable);
  }

  function runnerVariableGroups(variables) {
    const rows = runnerVariableRows(variables);
    const ocr = [];
    const literal = [];
    for (const v of rows) {
      const source = String(v.value_source === undefined || v.value_source === null
        ? 'literal' : v.value_source).trim();
      if (source === 'ocr_text') ocr.push(v);
      else literal.push(v);
    }
    const groups = [];
    if (ocr.length) groups.push({ group: '识别文字变量', kind: 'ocr_text', variables: ocr });
    const index = {};
    for (const v of literal) {
      const raw = String(v.group === undefined || v.group === null ? '' : v.group).trim();
      const group = raw || '通用';
      if (!Object.prototype.hasOwnProperty.call(index, group)) {
        index[group] = { group: group, kind: 'literal', variables: [] };
        groups.push(index[group]);
      }
      index[group].variables.push(v);
    }
    return groups;
  }

  function runnerVariableSummary(variables, values) {
    const rows = runnerVariableRows(variables);
    const src = values && typeof values === 'object' ? values : {};
    let filled = 0;
    for (const v of rows) {
      const key = String(v.key === undefined || v.key === null ? '' : v.key);
      if (key && Object.prototype.hasOwnProperty.call(src, key) && src[key] !== null) filled += 1;
    }
    if (!rows.length) return '0 个使用端变量';
    return rows.length + ' 个使用端变量 · 已填 ' + filled + ' · 分组 ' +
      runnerVariableGroups(rows).length + ' 个';
  }

  function runnerParamRoleText(param) {
    const p = param && typeof param === 'object' ? param : {};
    const assetId = String(p.asset_id === undefined || p.asset_id === null ? '' : p.asset_id).trim();
    if (assetId) return '识别文字配置';
    const role = String(p.role === undefined || p.role === null ? '' : p.role).trim().toLowerCase();
    return role === 'ocr_text' ? '识别文字' : '';
  }

  // 派生行的副标题：「素材 <asset_id> · 当前默认「<default>」」（任务 U-T6）。
  // 空 = 普通用户参数（不渲染副标题）。
  function runnerParamAssetSubtitle(param) {
    const p = param && typeof param === 'object' ? param : {};
    const assetId = String(p.asset_id === undefined || p.asset_id === null ? '' : p.asset_id).trim();
    if (!assetId) return '';
    let text = '素材 ' + assetId;
    if (p.default !== undefined && p.default !== null) {
      text += ' · 当前默认「' + runnerParamDefaultText(p) + '」';
    }
    return text;
  }

  function runnerParamTypeText(param) {
    const p = param && typeof param === 'object' ? param : {};
    const type = String(p.type === undefined || p.type === null ? '' : p.type).trim().toLowerCase();
    const kind = runnerConfigFieldKind(p);
    if (kind === 'bool') return '布尔';
    if (Array.isArray(p.enum) && p.enum.length) return '枚举';
    if (type === 'int' || type === 'integer') return '整数';
    if (type === 'float') return '小数';
    if (type === 'number') return '数字';
    return type || '文本';
  }

  // 仅已保存值（永不使用声明默认值）：对话框将默认值显示为
  // hints, not as pre-filled values, so 留空 really means "不注入".
  function runnerParamSavedValue(param, values) {
    const p = param && typeof param === 'object' ? param : {};
    const key = p.key === undefined || p.key === null ? '' : String(p.key).trim();
    const src = values && typeof values === 'object' ? values : {};
    if (!key || !Object.prototype.hasOwnProperty.call(src, key)) return undefined;
    return src[key] === null ? undefined : src[key];
  }

  // P2 §4.4 bool tri-state: '' = 未设置（不入 values）, 'true'/'false' = JSON bool.
  function runnerParamBoolTri(value) {
    if (value === true) return 'true';
    if (value === false) return 'false';
    const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    if (text === 'true' || text === '1') return 'true';
    if (text === 'false' || text === '0') return 'false';
    return '';
  }

  // One row's state machine: used = 使用 switch; value = control raw string.
  // blocked = 必填 && 无默认值 &&（未启用/留空）-> 拒绝保存。
  function runnerParamUseState(param, rawValue, useFlag) {
    const p = param && typeof param === 'object' ? param : {};
    const kind = runnerConfigFieldKind(p);
    const raw = rawValue === undefined || rawValue === null
      ? ''
      : (kind === 'bool' ? runnerParamBoolTri(rawValue) : String(rawValue).trim());
    const hasValue = raw !== '';
    const hasDefault = p.default !== undefined && p.default !== null;
    const defaultText = hasDefault ? runnerParamDefaultText(p) : '';
    const enabled = useFlag === undefined ? hasValue : useFlag === true;
    let hint;
    if (!enabled) {
      hint = hasDefault
        ? '不使用（回退默认值：' + defaultText + '）'
        : '未提供（运行需要时失败）';
    } else if (!hasValue) {
      hint = hasDefault
        ? '留空 = 不使用（回退默认值：' + defaultText + '）'
        : '留空 = 不使用（未提供默认值）';
    } else {
      hint = '';
    }
    const blocked = p.required === true && !hasDefault && (!enabled || !hasValue);
    return {
      enabled: enabled,
      hasValue: hasValue,
      value: raw,
      hint: blocked ? '必填参数：不能留空或不使用' : hint,
      blocked: blocked,
      hasDefault: hasDefault,
      defaultText: defaultText,
    };
  }

  // 保存时收集：使用扩展收集器（useFlags + 三态 bool），
  // 并为顶部汇总增加页面计数。
  function runnerParamCollectUse(params, useFlags, rawValues) {
    const collected = runnerConfigCollectValues(params, rawValues, useFlags);
    const groups = runnerParamGroups(params);
    let totalCount = 0;
    for (const group of groups) totalCount += group.params.length;
    return {
      ok: collected.ok,
      values: collected.values,
      errors: collected.errors,
      setCount: Object.keys(collected.values).length,
      totalCount: totalCount,
      groupCount: groups.length,
    };
  }

  // Top summary: 「N/M 项已设置 · 分组 G 个」.
  function runnerParamSummary(params, values) {
    const groups = runnerParamGroups(params);
    const src = values && typeof values === 'object' ? values : {};
    let total = 0;
    let set = 0;
    for (const group of groups) {
      for (const param of group.params) {
        const key = param && param.key !== undefined && param.key !== null
          ? String(param.key).trim()
          : '';
        if (!key) continue;
        total += 1;
        if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
        const value = src[key];
        if (value === undefined || value === null) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        set += 1;
      }
    }
    return set + '/' + total + ' 项已设置 · 分组 ' + groups.length + ' 个';
  }

  // --- PR5: 安装包（纯函数，ui_pure_test 单独抽取执行） -----------------------
  // 安装、卸载与回滚都走 Runner-only 路由；这里只拼请求体、格式化和把服务端
  // 错误码翻成可执行的一句话。不依赖 DOM。

  // POST /runner/install 请求体。路径按输入原样展示/去空格：Runner
  // 是本地界面，不做盘符改写或平台猜测。
  function runnerInstallBody(path, force) {
    const text = String(path === undefined || path === null ? '' : path).trim();
    return { path: text, force: force === true };
  }

  // 单个已安装包的标准展示行。缺失字段显示为
  // '—' 而非 "undefined"；sha 仅展示时缩短（title 保留
  // 完整值）。
  function formatPackageRow(pkg) {
    const p = pkg && typeof pkg === 'object' ? pkg : {};
    const text = (v) => (v === undefined || v === null || v === '' ? '' : String(v));
    const packageId = text(p.package_id);
    const sha = text(p.sha256);
    return {
      task_id: text(p.task_id) || '—',
      version: text(p.version) || '—',
      package_id: packageId || '—',
      package_id_short: packageId && packageId.length > 28
        ? packageId.slice(0, 28) + '…'
        : (packageId || '—'),
      sha256: sha || '—',
      sha_short: sha ? (sha.length > 12 ? sha.slice(0, 12) + '…' : sha) : '—',
      installed_at_ms: p.installed_at_ms === undefined || p.installed_at_ms === null
        ? null
        : p.installed_at_ms,
      backup: text(p.backup) || '—',
    };
  }

  // 「已安装任务」行里的包信息徽标：已安装 vN / 未纳管。When the backend does
  // 完全未返回 installed/version/package_id/unmanaged 时保持中性。
  function runnerTaskPackageBadge(task) {
    const t = task && typeof task === 'object' ? task : {};
    const version = t.version === undefined || t.version === null || t.version === ''
      ? ''
      : String(t.version);
    const packageId = t.package_id === undefined || t.package_id === null
      ? ''
      : String(t.package_id).trim();
    if (t.unmanaged === true) {
      return {
        text: '未纳管',
        cls: 'warn',
        title: 'tasks/ 裸目录：未经安装包管理；可在「安装包」页查看',
      };
    }
    if (t.unmanaged === false || t.installed === true || packageId) {
      return {
        text: version ? '已安装 v' + version : '已安装',
        cls: 'ok',
        title: packageId ? 'package_id：' + packageId : '已由安装包管理',
      };
    }
    return { text: '—', cls: 'kind', title: '任务列表未返回包信息' };
  }

  // 将 Runner 安装/卸载错误映射为一行可执行的中文提示
  // （详情仍以服务端为准；这里只解释常见错误码）。
  function runnerPackagesErrorText(err) {
    let raw;
    if (err === undefined || err === null) raw = '';
    else if (typeof err === 'string') raw = err;
    else if (typeof err === 'number' || typeof err === 'boolean') raw = String(err);
    else if (err.message !== undefined && err.message !== null) raw = String(err.message);
    else {
      try {
        raw = JSON.stringify(err);
      } catch (e) {
        raw = String(err);
      }
    }
    const text = String(raw === undefined || raw === null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!text) return '未知错误';
    const lower = text.toLowerCase();
    if (lower.indexOf('dirty_task') >= 0 || text.indexOf('被修改') >= 0) {
      return '任务目录在本机被修改过（dirty_task）：确认要覆盖时勾选 force 后重试。';
    }
    if (lower.indexOf('flow_ops') >= 0) {
      return '安装包需要更新的 Runner：manifest.engine.flow_ops 超出当前 Runner 支持范围。';
    }
    if (lower.indexOf('checksum') >= 0 || lower.indexOf('sha256') >= 0 || text.indexOf('校验') >= 0) {
      return '安装包校验失败（checksum）：文件不完整或被修改，请重新发布后再安装。';
    }
    if (lower.indexOf('not found') >= 0 || lower.indexOf('enoent') >= 0 ||
        text.indexOf('找不到') >= 0) {
      return '找不到安装包文件：' + text;
    }
    if (lower.indexOf('exists') >= 0 || text.indexOf('已存在') >= 0) {
      return '任务已存在：' + text;
    }
    if (lower.indexOf('version') >= 0 || text.indexOf('版本') >= 0) {
      return '版本不满足：' + text;
    }
    if (lower.indexOf('depend') >= 0 || text.indexOf('依赖') >= 0) {
      return '依赖缺失：' + text;
    }
    return text;
  }

  // --- P0-1a: 新发布（Studio exchange → Runner 通知；纯函数，ui_pure_test 抽取）
  // GET /runner/updates 的字段全部按「后端可能缺失」处理：缺失时用安全默认
  // （未启用 / 未知兼容性 / 允许安装），不让安装包页因此报错。这里只做
  // 「数据 → 文案/布尔」的纯转换：不碰 DOM，也不发请求。

  // `enabled` 缺失表示旧后端未实现 exchange -> 视为
  // “未配置”（任务契约）。
  function updatesEnabled(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    return b.enabled === true;
  }

  function updatesList(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    return Array.isArray(b.updates) ? b.updates : [];
  }

  // 仅仍需决策的事件可操作：dismissed/installed
  // rows are hidden ("不再打扰") and an event without event_id cannot be acked.
  function updatesVisibleRows(list) {
    const rows = Array.isArray(list) ? list : [];
    return rows.filter(function (item) {
      const it = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
      if (!it) return false;
      if (it.status === 'dismissed' || it.status === 'installed') return false;
      const eventId = it.event_id === undefined || it.event_id === null
        ? ''
        : String(it.event_id).trim();
      return eventId !== '';
    });
  }

  function updatesBadgeCount(list) {
    return updatesVisibleRows(list).length;
  }

  function updatesActionLabel(action) {
    switch (String(action === undefined || action === null ? '' : action)) {
      case 'install': return '新任务';
      case 'upgrade': return '升级';
      case 'downgrade': return '降级';
      case 'reinstall': return '重装';
      default: return '新发布';
    }
  }

  function updatesCompatText(item) {
    const it = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    if (it.compatible === false) return '不兼容（安装会被拒绝）';
    if (it.compatible === true) return '兼容';
    return '兼容性未知';
  }

  function updatesPackageText(item) {
    const it = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    if (it.package_available === false) {
      return '包文件不存在（请让 Studio 重新发布，或手动选路径）';
    }
    if (it.package_available === true) return '包可用';
    return '包状态未知';
  }

  // P2: 发布源徽标。exchange（本地 Studio）→ 「本地 Studio」；feed 名原样显示；
  // 字段缺失（旧后端）降级为「未知来源」。
  function updatesSourceLabel(item) {
    const it = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const text = function (value) {
      return value === undefined || value === null ? '' : String(value).trim();
    };
    const source = text(it.source);
    const kind = text(it.source_kind).toLowerCase();
    if (kind === 'exchange' || source === 'exchange') return '本地 Studio';
    if (source) return source;
    if (kind === 'local') return '本地目录';
    if (kind === 'url') return '远程源';
    return '未知来源';
  }

  // P2: 远程/需下载事件仅用于文案（下载由后端 POST /runner/updates/install 做，
  // 不作安装按钮禁用条件）。
  function updatesDownloadHint(item) {
    const it = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    if (it.download_required === true) return '需下载';
    const kind = String(it.source_kind === undefined || it.source_kind === null ? '' : it.source_kind)
      .trim()
      .toLowerCase();
    if (kind === 'url') return '远程下载';
    return '';
  }

  // POST /runner/updates/install 请求体：只需事件 id，后端即可
  // 解析来源、按需下载、安装并回执 installed。
  function updatesInstallBody(eventId) {
    const id = String(eventId === undefined || eventId === null ? '' : eventId).trim();
    return { event_id: id };
  }

  function updatesIsDownloadable(item) {
    const it = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    if (it.download_required === true) return true;
    const kind = String(it.source_kind === undefined || it.source_kind === null ? '' : it.source_kind)
      .trim()
      .toLowerCase();
    return kind === 'url';
  }

  // 新安装接口只需 event_id（以及兼容的包）；
  // 本地事件若包文件已消失则不可安装，而远程
  // 事件仍可安装（后端负责下载）。
  function updatesCanInstall(item) {
    const it = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const eventId = it.event_id === undefined || it.event_id === null
      ? ''
      : String(it.event_id).trim();
    if (!eventId) return false;
    if (it.compatible === false) return false;
    if (updatesIsDownloadable(it)) return true;
    if (it.package_available === false) return false;
    return true;
  }

  function updatesInstallPath(item) {
    const it = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    if (!updatesCanInstall(it)) return '';
    return String(it.package_path).trim();
  }

  // One human sentence per event (also used as the row title): 任务 v版本 · 动作 ·
  // 发布时间 · 兼容性（· 包缺失提示）.
  function updateRowText(item) {
    const it = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const text = function (value) {
      return value === undefined || value === null || value === '' ? '' : String(value);
    };
    const task = text(it.task_id) || '（未知任务）';
    const version = text(it.task_version !== undefined ? it.task_version : it.version);
    const parts = [version ? task + ' v' + version : task];
    parts.push(updatesActionLabel(it.action));
    const published = runnerTimeText(it.published_at_ms);
    if (published && published !== '—') parts.push('发布 ' + published);
    parts.push(updatesCompatText(it));
    if (it.package_available === false) parts.push(updatesPackageText(it));
    const downloadHint = updatesDownloadHint(it);
    if (downloadHint) parts.push(downloadHint);
    return parts.join(' · ');
  }

  // POST /runner/updates/ack 请求体。只传两种已记录状态；
  // 空/未知状态降级为 "dismissed"，确保角标总能清除。
  function updatesAckBody(ids, status) {
    const list = Array.isArray(ids) ? ids : [];
    const eventIds = list
      .map(function (id) {
        return String(id === undefined || id === null ? '' : id).trim();
      })
      .filter(function (id) { return id !== ''; });
    return {
      event_ids: eventIds,
      status: status === 'installed' ? 'installed' : 'dismissed',
    };
  }

  // One status line for the 新发布 card: read error (fail-soft) > server index
  // 错误 > exchange 已禁用 > 空 > 数量。
  function updatesListStatusText(body, errorText) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    const err = String(errorText === undefined || errorText === null ? '' : errorText).trim();
    if (err) return '新发布读取失败：' + err + '（保留上次结果）';
    if (!b) return '（未加载）';
    const serverError = b.error === undefined || b.error === null
      ? ''
      : String(b.error).trim();
    if (serverError) return '发布索引读取异常：' + serverError;
    // P2：本地 exchange 禁用时 feed 事件仍可能存在，因此
    // 可操作行优先于“exchange 已禁用”提示。
    const rows = updatesVisibleRows(updatesList(b));
    if (rows.length) return '新发布 ' + rows.length + ' 条（安装或忽略后不再显示）';
    if (!updatesEnabled(b)) {
      return '未配置 exchange 目录（config/live.json → exchange.dir）';
    }
    return '暂无新发布';
  }

  // --- PR6: 调度启停 / 临时运行 / scheduler.json（纯函数，ui_pure_test 单独抽取）
  // 只做「请求体 + 文案」的纯转换：不碰 DOM，也不直接发请求。

  // POST /runner/run 请求体。task 必填；参数文本域
  // 可选。空文本或 `{}` 表示“使用 Runner 已保存值”
  // （config/values.json）；任一键覆盖已保存值。非
  // JSON 对象会在本地拒绝，不发送请求。
  function runnerRunBody(task, paramsText) {
    const name = String(task === undefined || task === null ? '' : task).trim();
    if (!name) return { ok: false, body: null, error: '请选择要运行的任务' };
    const raw = String(paramsText === undefined || paramsText === null ? '' : paramsText).trim();
    if (!raw) return { ok: true, body: { task: name }, error: '' };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        ok: false,
        body: null,
        error: '参数不是合法 JSON：' + (e && e.message ? e.message : String(e)),
      };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        body: null,
        error: '参数必须是 JSON 对象（如 {"关键词":"突破"}）',
      };
    }
    const body = { task: name };
    if (Object.keys(parsed).length) body.params = parsed;
    return { ok: true, body: body, error: '' };
  }

  // GET /runner/run/status 的一句话状态（running / finished / failed）。
  function runnerRunElapsedMs(startedMs, nowMs) {
    const started = Number(startedMs) || 0;
    if (!started) return 0;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    return Math.max(0, now - started);
  }

  function runnerRunElapsedText(startedMs, nowMs) {
    const ms = runnerRunElapsedMs(startedMs, nowMs);
    if (!ms) return '0s';
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? (m + 'm' + (s < 10 ? '0' : '') + s + 's') : (s + 's');
  }

  function runnerNextRunPollDelay(currentMs) {
    const n = Number(currentMs);
    const base = Number.isFinite(n) && n > 0 ? n : RUNNER_RUN_POLL_MS;
    return Math.min(RUNNER_RUN_POLL_MAX_DELAY_MS, Math.max(RUNNER_RUN_POLL_MS, base * 2));
  }

  function runnerRunStillRunning(status) {
    return !!(status && status.running === true);
  }

  // seq196：停止按钮文案（纯函数，便于纯测抽取）。
  function runnerRunStopButtonText(stopping) {
    return stopping === true ? '停止中…' : '停止运行';
  }

  // seq151：运行中状态行（含 elapsed），不再把 60s 当错误；seq196：运行中可停止。
  function runnerRunningStatusText(status) {
    const s = status && typeof status === 'object' ? status : {};
    const task = s.task === undefined || s.task === null || s.task === '' ? '—' : String(s.task);
    const started = Number(s.started_ms) || runPollStartedMs;
    const elapsedMs = runnerRunElapsedMs(started, Date.now());
    const elapsed = runnerRunElapsedText(started, Date.now());
    return '运行中：' + task + ' · 已运行 ' + elapsed +
      (elapsedMs >= RUNNER_RUN_ELAPSED_WARN_MS ? '（已超过 60s，仍在运行）' : '') +
      '（可点「停止运行」停止；停止在当前步骤结束后生效）';
  }

  // 同上：GET /runner/run/status 的一句话状态（running / finished / failed）。
  function runnerRunStatusText(status) {
    const s = status && typeof status === 'object' ? status : {};
    const task = s.task === undefined || s.task === null || s.task === '' ? '' : String(s.task);
    if (s.running === true) return '运行中：' + (task || '—');
    if (s.outcome !== undefined && s.outcome !== null && s.outcome !== '') {
      return '已结束：' + (task || '—') + ' · outcome=' + String(s.outcome);
    }
    if (s.error !== undefined && s.error !== null && s.error !== '') {
      return '失败：' + (task || '—') + ' · ' + runnerErrorSummary(s.error, 160);
    }
    if (s.finished_ms !== undefined && s.finished_ms !== null && s.finished_ms !== '') {
      return '已结束：' + (task || '—');
    }
    return '—';
  }

  // GET /runner/scheduler/status -> badge text (运行中 / 停止中 / 已停止).
  function runnerSchedStatusText(status) {
    const s = status && typeof status === 'object' ? status : null;
    if (!s) return '—';
    if (s.running === true) return s.stop_requested === true ? '停止中' : '运行中';
    if (s.stop_requested === true && s.thread_alive === true) return '停止中';
    return '已停止';
  }

  // 调度锁是跨进程文件锁；其 pid 是
  // 解释“谁在运行”的唯一信息（Runner 线程 vs `oasd scheduler`）。
  function runnerSchedLockPidText(status) {
    const s = status && typeof status === 'object' ? status : null;
    if (!s) return '—';
    const pid = s.lock_pid;
    if (pid === undefined || pid === null || pid === '') return '—';
    return String(pid);
  }

  function runnerSchedThreadText(status) {
    const s = status && typeof status === 'object' ? status : null;
    if (!s || s.thread_alive === undefined || s.thread_alive === null) return '—';
    return s.thread_alive === true ? '存活' : '已退出';
  }

  // POST /scheduler/config 请求体。文本域保存原始 scheduler.json
  // 文档；服务端形状为 {config: <object>}（与旧 Studio
  // 页面契约一致）。Runner 不在本地改写该文档。
  function runnerSchedJsonBody(text) {
    const raw = String(text === undefined || text === null ? '' : text).trim();
    if (!raw) return { ok: false, body: null, error: 'JSON 为空：请先载入或粘贴 scheduler.json' };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        ok: false,
        body: null,
        error: 'JSON 解析失败：' + (e && e.message ? e.message : String(e)),
      };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, body: null, error: '必须是 JSON 对象（scheduler.json 的顶层对象）' };
    }
    return { ok: true, body: { config: parsed }, error: '' };
  }

  // 每个服务端错误一行可执行提示（409 busy/lease 错误位于
  // body.errors，逐行原样展示）。
  function runnerErrorLines(error) {
    if (error && Array.isArray(error.details) && error.details.length) {
      return error.details.map(function (line) { return '· ' + String(line); });
    }
    return ['· ' + (runnerErrorText(error) || '未知错误')];
  }

  // --- HTTP：所有请求的唯一入口 ------------------------------------------------

  // 机器可读 409 错误码的人类可读标签。后端发送
  // `{ok:false,error:"device_busy"|"scheduler_locked"|"run_busy",errors:[...],
  // message:"..."}`；汇总必须保留错误码含义，
  // 不能用 `errors` 文本替换（P1-1）。
  function runnerErrorCodeLabel(code) {
    switch (String(code === undefined || code === null ? '' : code)) {
      case 'device_busy': return '设备被占用';
      case 'scheduler_locked': return '调度锁被占用';
      case 'run_busy': return '已有运行在进行';
      default: return '';
    }
  }

  function runnerBodyErrors(body) {
    if (!body || typeof body !== 'object') return '';
    const code = body.error === undefined || body.error === null ? '' : String(body.error);
    const message = body.message !== undefined && body.message !== null
      ? String(body.message).trim()
      : '';
    const label = runnerErrorCodeLabel(code);
    if (label) return message ? label + '：' + message : label;
    if (message) return message;
    if (code) return code;
    if (Array.isArray(body.errors) && body.errors.length) {
      return body.errors
        .filter(function (e) { return e !== undefined && e !== null && e !== ''; })
        .map(String)
        .join('；');
    }
    return '';
  }

  // POST /runner/scheduler/stop 请求体 -> 用户可见文本（P1-2）。超时是
  // “仍在停止”状态，不是失败：UI 轮询直到 running=false。
  function runnerStopText(body) {
    const b = body && typeof body === 'object' ? body : null;
    if (!b) return '已请求停止（等待调度线程退出）';
    if (b.already_stopped === true) return '调度本来就没在运行';
    if (b.timeout === true || b.stopping === true) return '停止中（当前任务跑完后退出）';
    if (b.stopped === true || b.running === false) return '调度已停止';
    return '已请求停止（等待调度线程退出）';
  }

  function runnerStopPending(body) {
    const b = body && typeof body === 'object' ? body : null;
    return !!b && (b.timeout === true || b.stopping === true);
  }

  // 仅在存在时展示调度历史行（`last_error` / `last_stop`
  // 解释自动启动失败或上次停止原因；P2 UI）。
  function runnerSchedHistoryRows(status) {
    const s = status && typeof status === 'object' ? status : null;
    const rows = [];
    if (!s) return rows;
    if (s.last_stop !== undefined && s.last_stop !== null &&
        String(s.last_stop).trim() !== '') {
      rows.push(['最后停止', String(s.last_stop)]);
    }
    if (s.last_error !== undefined && s.last_error !== null &&
        String(s.last_error).trim() !== '') {
      rows.push(['最后错误', String(s.last_error)]);
    }
    return rows;
  }

  async function runnerFetchJson(url, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const method = options.method ? String(options.method).toUpperCase() : 'GET';
    const headers = { Accept: 'application/json' };
    let payload;
    if (options.body !== undefined && options.body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, RUNNER_FETCH_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, {
        method: method,
        headers: headers,
        cache: 'no-store',
        body: payload,
        signal: controller ? controller.signal : undefined,
      });
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (e) {
        body = null;
      }
      const detail = runnerBodyErrors(body);
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status + (detail ? '：' + detail : ''));
        err.status = res.status;
        // 保留机器错误码（`device_busy` / `scheduler_locked` /
        // `run_busy`），便于调用方分支处理而非正则文本。
        if (body && typeof body === 'object' &&
            body.error !== undefined && body.error !== null && body.error !== '') {
          err.code = String(body.error);
        }
        if (body && Array.isArray(body.errors) && body.errors.length) {
          err.details = body.errors.map(String);
        }
        throw err;
      }
      if (!body || typeof body !== 'object') throw new Error('响应不是 JSON 对象');
      if (body.ok === false) {
        const err = new Error(detail || '服务端返回 ok=false');
        if (body.error !== undefined && body.error !== null && body.error !== '') {
          err.code = String(body.error);
        }
        if (Array.isArray(body.errors) && body.errors.length) {
          err.details = body.errors.map(String);
        }
        throw err;
      }
      return body;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('请求超时（' + Math.round(RUNNER_FETCH_TIMEOUT_MS / 1000) + ' 秒）');
      }
      throw e instanceof Error ? e : new Error(runnerErrorText(e) || '请求失败');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // --- DOM 辅助 ----------------------------------------------------------------

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function makeBadge(text, cls) {
    const span = document.createElement('span');
    span.className = 'runner-badge ' + (cls || 'kind');
    span.textContent = String(text === undefined || text === null ? '—' : text);
    return span;
  }

  function renderKv(host, rows) {
    if (!host) return;
    clearNode(host);
    if (!rows || !rows.length) {
      host.textContent = '—';
      return;
    }
    const dl = document.createElement('dl');
    dl.className = 'runner-kv';
    for (const pair of rows) {
      const dt = document.createElement('dt');
      dt.textContent = String(pair[0]);
      const dd = document.createElement('dd');
      dd.textContent = pair[1] === undefined || pair[1] === null ? '—' : String(pair[1]);
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    host.appendChild(dl);
  }

  function appendTableCell(tr, value) {
    const td = document.createElement('td');
    if (value && value.nodeType === 1) {
      td.appendChild(value);
    } else if (value && typeof value === 'object' && value.text !== undefined) {
      td.textContent = String(value.text);
      if (value.cls) td.className = value.cls;
      if (value.title) td.title = value.title;
    } else {
      td.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
    }
    tr.appendChild(td);
  }

  function renderTable(host, headers, rows, emptyText) {
    if (!host) return;
    clearNode(host);
    if (!rows || !rows.length) {
      host.textContent = emptyText || '（无数据）';
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'runner-table-wrap';
    const table = document.createElement('table');
    table.className = 'runner-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of headers) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const cell of row) appendTableCell(tr, cell);
      tbody.appendChild(tr);
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  function setBadge(node, text, cls) {
    if (!node) return;
    node.textContent = text;
    node.className = 'runner-badge ' + (cls || 'kind');
  }

  function setPageStatus(text, kind) {
    if (!el.pageStatus) return;
    el.pageStatus.textContent = text;
    el.pageStatus.className = 'muted small' + (kind ? ' ' + kind : '');
  }

  function updateLastRefresh() {
    if (!el.lastRefresh) return;
    const now = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    el.lastRefresh.textContent = '上次刷新 ' +
      pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  }

  function setFetching(busy) {
    state.busy = !!busy;
    const buttons = [
      el.refresh, el.healthRefresh, el.tasksRefresh, el.packagesRefresh,
      el.updatesRefresh,
      el.queueRefresh, el.runsRefresh, el.settingsRefresh, el.schedRefresh,
    ];
    for (const button of buttons) {
      if (button) button.disabled = !!busy;
    }
  }

  function bindElements() {
    el.pageStatus = document.getElementById('runner-page-status');
    el.refresh = document.getElementById('runner-refresh');
    el.connBadge = document.getElementById('runner-conn-badge');
    el.versionBadge = document.getElementById('runner-version-badge');
    el.portBadge = document.getElementById('runner-port-badge');
    el.lockBadge = document.getElementById('runner-lock-badge');
    el.lastRefresh = document.getElementById('runner-last-refresh');
    el.nav = document.getElementById('runner-nav');
    el.navButtons = el.nav
      ? Array.prototype.slice.call(el.nav.querySelectorAll('.app-nav-btn'))
      : [];
    el.pages = Array.prototype.slice.call(document.querySelectorAll('.app-page'));

    el.healthRefresh = document.getElementById('runner-health-refresh');
    el.overviewHealth = document.getElementById('overview-health');
    el.recentRuns = document.getElementById('overview-recent-runs');
    el.recentStatus = document.getElementById('overview-recent-status');

    el.tasksRefresh = document.getElementById('runner-tasks-refresh');
    el.tasksCount = document.getElementById('runner-tasks-count');
    el.tasksStatus = document.getElementById('runner-tasks-status');
    el.tasksList = document.getElementById('runner-tasks-list');

    el.packagesRefresh = document.getElementById('runner-packages-refresh');
    el.packagesSummary = document.getElementById('runner-packages-summary');
    el.packagesStatus = document.getElementById('runner-packages-status');
    el.packagesCount = document.getElementById('runner-packages-count');
    el.packagesList = document.getElementById('runner-packages-list');
    el.packagesUnmanagedStatus = document.getElementById('runner-packages-unmanaged-status');
    el.packagesUnmanaged = document.getElementById('runner-packages-unmanaged');
    el.installPath = document.getElementById('runner-install-path');
    el.installForce = document.getElementById('runner-install-force');
    el.installSubmit = document.getElementById('runner-install-submit');
    el.installStatus = document.getElementById('runner-install-status');
    el.installResult = document.getElementById('runner-install-result');
    el.installWarnings = document.getElementById('runner-install-warnings');
    el.installError = document.getElementById('runner-install-error');
    // P0-1a: Studio publish notifications (nav badge + 新发布 card).
    el.updatesBadge = document.getElementById('runner-updates-badge');
    el.updatesSection = document.getElementById('runner-updates-section');
    el.updatesSummary = document.getElementById('runner-updates-summary');
    el.updatesStatus = document.getElementById('runner-updates-status');
    el.updatesList = document.getElementById('runner-updates-list');
    el.updatesRefresh = document.getElementById('runner-updates-refresh');

    el.configDialog = document.getElementById('runner-config-dialog');
    el.configTitle = document.getElementById('runner-config-title');
    el.configSummary = document.getElementById('runner-config-summary');
    el.configForm = document.getElementById('runner-config-form');
    el.configFields = document.getElementById('runner-config-fields');
    el.configError = document.getElementById('runner-config-error');
    el.configStatus = document.getElementById('runner-config-status');
    el.configSave = document.getElementById('runner-config-save');
    el.configClose = document.getElementById('runner-config-close');

    el.queueRefresh = document.getElementById('runner-queue-refresh');
    el.queueStatus = document.getElementById('runner-queue-status');
    // PR6：调度控制 / 临时运行 / 高级 scheduler.json 编辑器。
    el.schedControl = document.getElementById('runner-sched-control');
    el.schedBadge = document.getElementById('runner-sched-badge');
    el.schedMeta = document.getElementById('runner-sched-meta');
    el.schedStart = document.getElementById('runner-sched-start');
    el.schedStop = document.getElementById('runner-sched-stop');
    el.schedRefresh = document.getElementById('runner-sched-refresh');
    el.schedStatus = document.getElementById('runner-sched-status');
    el.schedError = document.getElementById('runner-sched-error');
    el.runTask = document.getElementById('runner-run-task');
    el.runParams = document.getElementById('runner-run-params');
    el.runSubmit = document.getElementById('runner-run-submit');
    el.runStop = document.getElementById('runner-run-stop');
    el.runStopHint = document.getElementById('runner-run-stop-hint');
    el.runStatus = document.getElementById('runner-run-status');
    el.runError = document.getElementById('runner-run-error');
    el.runLog = document.getElementById('runner-run-log');
    el.overviewScheduler = document.getElementById('overview-scheduler');
    el.overviewGotoQueue = document.getElementById('overview-goto-queue');

    el.runsRefresh = document.getElementById('runner-runs-refresh');
    el.runsStatus = document.getElementById('runner-runs-status');
    el.runsList = document.getElementById('runner-runs-list');

    el.settingsRefresh = document.getElementById('runner-settings-refresh');
    el.settingsStatus = document.getElementById('runner-settings-status');
    el.settingsDevice = document.getElementById('settings-device');
    el.settingsPaths = document.getElementById('settings-paths');
    el.settingsServe = document.getElementById('settings-serve');
    el.settingsRunner = document.getElementById('settings-runner');
    el.settingsScheduler = document.getElementById('settings-scheduler');
    el.settingsInstance = document.getElementById('settings-instance');
    el.settingsConfigJson = document.getElementById('settings-config-json');
  }

  // --- 运行面健康 / 概览 --------------------------------------------------------

  function applyHealth(health) {
    const h = health || {};
    setBadge(el.connBadge, 'API 已连接', 'ok');
    if (el.connBadge) el.connBadge.removeAttribute('title');
    setBadge(el.versionBadge, '版本 ' + runnerValueText(h.version), 'kind');
    setBadge(el.portBadge, '端口 ' + runnerValueText(h.port), 'kind');
    setBadge(el.lockBadge, runnerLockText(h.lock), runnerLockClass(h.lock));
  }

  function applyHealthError(error) {
    setBadge(el.connBadge, 'API 连接失败', 'err');
    setBadge(el.versionBadge, '版本 —', 'kind');
    setBadge(el.portBadge, '端口 —', 'kind');
    setBadge(el.lockBadge, '调度锁 —', 'kind');
    if (el.connBadge) el.connBadge.title = runnerErrorText(error);
  }

  async function refreshHealth() {
    try {
      const health = await runnerFetchJson(RUNNER_API.health);
      state.health = health;
      applyHealth(health);
      // P0-1a：/runner/health 可能返回 pending_updates；仅作为
      // 权威 /runner/updates 列表加载前的角标初始值。
      if (!state.updates &&
          health && typeof health.pending_updates === 'number' && isFinite(health.pending_updates)) {
        updateNavBadge(health.pending_updates);
      }
      return '';
    } catch (e) {
      state.health = null;
      applyHealthError(e);
      return '健康检查读取失败：' + runnerErrorText(e);
    }
  }

  function renderOverviewHealth() {
    if (!state.health) {
      if (el.overviewHealth) el.overviewHealth.textContent = '—';
      return;
    }
    const h = state.health;
    const tasks = state.tasks && Array.isArray(state.tasks.tasks) ? state.tasks.tasks : null;
    const sched = h.scheduler && typeof h.scheduler === 'object' ? h.scheduler : null;
    renderKv(el.overviewHealth, [
      ['运行面', runnerValueText(h.surface)],
      ['版本', runnerValueText(h.version)],
      ['端口', runnerValueText(h.port)],
      ['调度模式', runnerValueText(h.scheduler_mode)],
      ['调度锁', runnerLockText(h.lock)],
      ['调度状态', sched ? runnerSchedStatusText(sched) : '—'],
      ['锁 pid', runnerSchedLockPidText(sched)],
      ['调度线程', runnerSchedThreadText(sched)],
      ['任务目录', runnerValueText(h.tasks_dir)],
      ['运行目录', runnerValueText(h.runs_dir)],
      ['状态文件', runnerValueText(h.state_path)],
      ['已安装任务数', tasks ? String(tasks.length) : '—'],
    ]);
  }

  function renderOverviewScheduler() {
    if (!el.overviewScheduler) return;
    const sched = state.runnerScheduler ||
      (state.health && state.health.scheduler && typeof state.health.scheduler === 'object'
        ? state.health.scheduler
        : null);
    if (!sched) {
      el.overviewScheduler.textContent = '—';
      return;
    }
    const passes = sched.passes === undefined || sched.passes === null ? '—' : String(sched.passes);
    renderKv(el.overviewScheduler, [
      ['调度状态', runnerSchedStatusText(sched)],
      ['调度线程', runnerSchedThreadText(sched)],
      ['锁 pid', runnerSchedLockPidText(sched)],
      ['停止请求', sched.stop_requested === true ? '已请求（当前任务跑完后停止）' : '无'],
      ['passes', passes],
      ['上次 pass', runnerTimeText(sched.last_pass_ms)],
    ].concat(runnerSchedHistoryRows(sched)));
  }

  function renderRecentRuns() {
    if (!el.recentRuns) return;
    if (state.recentRunsError) {
      el.recentRuns.textContent = '—';
      if (el.recentStatus) el.recentStatus.textContent = '最近运行读取失败：' + state.recentRunsError;
      return;
    }
    if (!state.recentRuns) {
      el.recentRuns.textContent = '（未加载）';
      if (el.recentStatus) el.recentStatus.textContent = '—';
      return;
    }
    const runs = Array.isArray(state.recentRuns.runs) ? state.recentRuns.runs : [];
    if (el.recentStatus) el.recentStatus.textContent = '最近 ' + runs.length + ' 条';
    if (!runs.length) {
      el.recentRuns.textContent = '暂无运行记录';
      return;
    }
    const rows = runs.map(function (run) {
      const r = run || {};
      return [
        runnerTimeText(r.started_ms),
        runnerValueText(r.task),
        runnerValueText(r.kind),
        makeBadge(runnerValueText(r.outcome), runnerOutcomeClass(r.outcome)),
        runnerExitText(r),
        runnerDurationText(runnerRunDurationMs(r)),
      ];
    });
    renderTable(el.recentRuns, ['时间', '任务', 'kind', 'outcome', 'exit_code', 'duration'], rows, '暂无运行记录');
  }

  function renderOverview() {
    renderOverviewHealth();
    renderOverviewScheduler();
    renderRecentRuns();
  }

  async function loadOverview() {
    const errors = [];
    try {
      state.tasks = await runnerFetchJson(RUNNER_API.tasks);
    } catch (e) {
      state.tasks = null;
      errors.push('任务列表读取失败：' + runnerErrorText(e));
    }
    try {
      state.recentRuns = await runnerFetchJson(
        RUNNER_API.schedulerRuns + '?limit=' + RUNNER_RECENT_LIMIT
      );
      state.recentRunsError = '';
    } catch (e) {
      state.recentRuns = null;
      state.recentRunsError = runnerErrorText(e);
      errors.push('最近运行读取失败：' + state.recentRunsError);
    }
    renderOverview();
    return errors;
  }

  // --- 已安装任务 --------------------------------------------------------------

  function renderTasks() {
    if (!el.tasksList) return;
    const body = state.tasks || {};
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    if (el.tasksCount) el.tasksCount.textContent = tasks.length + ' 个任务';
    const metaErrors = tasks.filter(function (t) {
      return t && t.meta_error;
    }).length;
    if (el.tasksStatus) {
      el.tasksStatus.textContent = '目录：' + runnerValueText(body.dir) +
        (metaErrors ? ' · 元数据异常 ' + metaErrors + ' 个' : '');
    }
    if (!tasks.length) {
      el.tasksList.textContent =
        '还没有任务：请到「安装包」页安装 .oaspkg，或把任务目录放到 tasks/ 下（未纳管）。';
      return;
    }
    const rows = tasks.map(function (task) {
      const t = task || {};
      const title = t.meta_error
        ? 'meta.json 读取失败：' + t.meta_error
        : (t.version !== undefined && t.version !== null ? '版本 ' + t.version : '');
      const packageBadge = runnerTaskPackageBadge(t);
      const badgeEl = makeBadge(packageBadge.text, packageBadge.cls);
      badgeEl.title = packageBadge.title;
      const actions = document.createElement('div');
      actions.className = 'runner-task-actions';
      if (t.has_meta === true) {
        const configBtn = document.createElement('button');
        configBtn.type = 'button';
        configBtn.className = 'runner-config-open';
        configBtn.textContent = '配置';
        configBtn.title = '编辑该任务的运行值（保存在本机 config/values.json）';
        configBtn.addEventListener('click', function () { openRunnerConfigDialog(t.task); });
        const schedBtn = document.createElement('button');
        schedBtn.type = 'button';
        schedBtn.textContent = '调度设置…';
        schedBtn.title = '编辑该任务的调度条目（加入/修改调度）';
        schedBtn.addEventListener('click', function () { openTaskScheduleDialog(t.task); });
        const taskRunsBtn = document.createElement('button');
        taskRunsBtn.type = 'button';
        taskRunsBtn.textContent = '运行记录';
        taskRunsBtn.title = '跳到队列页并按该任务筛选运行记录';
        taskRunsBtn.addEventListener('click', function () { showScheduleRunsForTask(t.task); });
        actions.append(configBtn, schedBtn, taskRunsBtn);
      } else {
        actions.textContent = '—';
      }
      return [
        { text: runnerValueText(t.task), title: title },
        runnerFlagText(t.has_flow),
        runnerFlagText(t.has_meta),
        runnerFlagText(t.has_assets),
        runnerParamKeys(t.params).join(', ') || '—',
        runnerTaskStatusText(t),
        badgeEl,
        actions,
      ];
    });
    renderTable(
      el.tasksList,
      ['任务', 'flow', 'meta', 'assets', '参数 key', '状态', '包', '操作'],
      rows,
      '（没有任务）'
    );
  }

  async function loadTasksPage() {
    try {
      state.tasks = await runnerFetchJson(RUNNER_API.tasks);
      renderTasks();
      return [];
    } catch (e) {
      state.tasks = null;
      const message = '任务列表读取失败：' + runnerErrorText(e);
      if (el.tasksCount) el.tasksCount.textContent = '—';
      if (el.tasksStatus) el.tasksStatus.textContent = message;
      if (el.tasksList) el.tasksList.textContent = message;
      return [message];
    }
  }

  // --- 安装包（安装 / 列表 / 卸载 / 回滚） -------------------------------------

  function setPackagesBusy(busy) {
    if (el.installSubmit) el.installSubmit.disabled = !!busy;
    if (el.packagesRefresh) el.packagesRefresh.disabled = !!busy;
  }

  function installErrorLines(error) {
    if (error && Array.isArray(error.details) && error.details.length) {
      return error.details.map(function (line) {
        return '· ' + runnerPackagesErrorText(line);
      });
    }
    return ['· ' + runnerPackagesErrorText(error)];
  }

  function renderInstallResult(body) {
    const b = body && typeof body === 'object' ? body : {};
    renderKv(el.installResult, [
      ['package_id', runnerValueText(b.package_id)],
      ['task', runnerValueText(b.task_id !== undefined ? b.task_id : b.task)],
      ['version', runnerValueText(b.version)],
      ['replaced', b.replaced === true ? '是（旧版本已备份）' : (b.replaced === false ? '否' : '—')],
      ['backup', runnerValueText(b.backup)],
    ]);
    const warnings = Array.isArray(b.warnings) ? b.warnings : [];
    if (el.installWarnings) {
      el.installWarnings.textContent = warnings.length
        ? 'warnings：\n' + warnings.map(function (w) { return '· ' + String(w); }).join('\n')
        : '';
    }
  }

  function packageRowActions(row) {
    const wrap = document.createElement('span');
    wrap.className = 'runner-package-actions';
    const task = row && row.task_id && row.task_id !== '—' ? row.task_id : '';
    const uninstall = document.createElement('button');
    uninstall.type = 'button';
    uninstall.textContent = '卸载';
    uninstall.title = '卸载该任务包（任务目录先备份到 packages/backup/）';
    uninstall.className = 'runner-package-uninstall';
    uninstall.disabled = !task;
    uninstall.addEventListener('click', function () { uninstallRunnerPackage(task); });
    const activate = document.createElement('button');
    activate.type = 'button';
    activate.textContent = '回滚';
    activate.title = '回滚到该任务最近一次备份（Phase 1）';
    activate.className = 'runner-package-activate';
    activate.disabled = !task;
    activate.addEventListener('click', function () { activateRunnerPackage(task); });
    wrap.appendChild(uninstall);
    wrap.appendChild(activate);
    return wrap;
  }

  function renderPackages(body) {
    const b = body && typeof body === 'object' ? body : {};
    const packages = Array.isArray(b.packages) ? b.packages
      : (Array.isArray(b.installed) ? b.installed : []);
    if (el.packagesCount) el.packagesCount.textContent = packages.length + ' 个包';
    if (el.packagesSummary) {
      el.packagesSummary.textContent = 'packages/installed.json · 共 ' + packages.length + ' 个包';
    }
    const rows = packages.map(function (pkg) {
      const row = formatPackageRow(pkg);
      return [
        row.task_id,
        row.version,
        { text: row.package_id_short, title: row.package_id === '—' ? '' : row.package_id },
        { text: row.sha_short, title: row.sha256 === '—' ? '' : row.sha256 },
        runnerTimeText(row.installed_at_ms),
        { text: row.backup, title: row.backup === '—' ? '' : row.backup },
        packageRowActions(row),
      ];
    });
    renderTable(
      el.packagesList,
      ['任务', '版本', 'package_id', 'sha256', '安装时间', '备份', '操作'],
      rows,
      '尚未安装任务包（可用上方「安装」导入 .oaspkg）'
    );
  }

  function renderUnmanaged(items) {
    const list = Array.isArray(items) ? items : [];
    if (el.packagesUnmanagedStatus) {
      el.packagesUnmanagedStatus.textContent = list.length
        ? list.length + ' 个未纳管任务'
        : '没有未纳管任务';
    }
    if (!el.packagesUnmanaged) return;
    clearNode(el.packagesUnmanaged);
    if (!list.length) {
      el.packagesUnmanaged.textContent = '没有未纳管任务';
      return;
    }
    for (const item of list) {
      const t = item && typeof item === 'object' ? item : { task: String(item) };
      const name = runnerValueText(t.task !== undefined ? t.task : (t.task_id || t.name));
      const row = document.createElement('div');
      row.className = 'runner-unmanaged-row';
      const strong = document.createElement('strong');
      strong.textContent = name;
      const note = document.createElement('span');
      note.className = 'muted small';
      note.textContent = ' 未纳管（裸目录）· tasks/' + name;
      row.appendChild(strong);
      row.appendChild(note);
      el.packagesUnmanaged.appendChild(row);
    }
  }

  async function loadPackagesPage() {
    const errors = [];
    try {
      const body = await runnerFetchJson(RUNNER_API.packages);
      state.packages = body;
      renderPackages(body);
      if (el.packagesStatus) {
        el.packagesStatus.textContent = '已安装清单读取自 /runner/packages';
        el.packagesStatus.className = 'muted small';
      }
    } catch (e) {
      state.packages = null;
      const message = '安装包列表读取失败：' + runnerErrorText(e);
      if (el.packagesSummary) el.packagesSummary.textContent = '—';
      if (el.packagesCount) el.packagesCount.textContent = '—';
      if (el.packagesList) el.packagesList.textContent = message;
      if (el.packagesStatus) {
        el.packagesStatus.textContent = message;
        el.packagesStatus.className = 'muted small err';
      }
      return [message];
    }
    let unmanaged = null;
    const pkgBody = state.packages || {};
    if (Array.isArray(pkgBody.unmanaged)) unmanaged = pkgBody.unmanaged;
    if (!unmanaged) {
      try {
        const tasksBody = await runnerFetchJson(RUNNER_API.tasks);
        state.tasks = tasksBody;
        const tasks = Array.isArray(tasksBody.tasks) ? tasksBody.tasks : [];
        unmanaged = tasks.filter(function (t) { return t && t.unmanaged === true; });
      } catch (e) {
        const message = '未纳管任务读取失败：' + runnerErrorText(e);
        unmanaged = [];
        errors.push(message);
      }
    }
    renderUnmanaged(unmanaged);
    return errors;
  }

  // --- P0-1a: 新发布（Studio → Runner）页面渲染 / 轮询 / 安装+ack ------------

  // 导航角标显示可操作数量；为 0 时隐藏（installed/dismissed
  // 事件不会让角标常驻）。
  function updateNavBadge(count) {
    if (!el.updatesBadge) return;
    const n = Number(count);
    const total = isFinite(n) && n > 0 ? Math.floor(n) : 0;
    el.updatesBadge.textContent = String(total);
    el.updatesBadge.title = total
      ? '有 ' + total + ' 条来自 Studio 的新发布（到「安装包」页查看）'
      : '';
    if (total > 0) el.updatesBadge.removeAttribute('hidden');
    else el.updatesBadge.setAttribute('hidden', '');
  }

  function setUpdatesStatus(text, kind) {
    if (!el.updatesStatus) return;
    el.updatesStatus.textContent = text;
    el.updatesStatus.className = 'muted small' + (kind ? ' ' + kind : '');
  }

  function updateActionBadgeClass(action) {
    switch (String(action === undefined || action === null ? '' : action)) {
      case 'install': return 'kind';
      case 'upgrade': return 'ok';
      case 'downgrade': return 'warn';
      case 'reinstall': return 'kind';
      default: return 'kind';
    }
  }

  function updateInstallHint(item) {
    const it = item && typeof item === 'object' ? item : {};
    if (!updatesCanInstall(it)) {
      if (it.compatible === false) return '不兼容：当前 Runner 引擎/包能力不足，安装会被拒绝';
      if (it.event_id === undefined || it.event_id === null || String(it.event_id).trim() === '') {
        return '缺少 event_id，无法安装';
      }
      if (it.package_available === false) return updatesPackageText(it);
      return '无法安装该发布事件';
    }
    const downloadHint = updatesDownloadHint(it);
    if (downloadHint) return downloadHint + '：由 Runner 后端按来源下载/安装并自动标记已安装';
    return '';
  }

  function updateSourceCell(item) {
    const it = item && typeof item === 'object' ? item : {};
    const cell = document.createElement('div');
    cell.className = 'runner-update-source';
    cell.appendChild(makeBadge(updatesSourceLabel(it), 'kind'));
    const downloadHint = updatesDownloadHint(it);
    if (downloadHint) {
      const hint = document.createElement('span');
      hint.className = 'runner-update-download';
      hint.textContent = downloadHint;
      cell.appendChild(hint);
    }
    return cell;
  }

  function updateCompatCell(item) {
    const it = item && typeof item === 'object' ? item : {};
    const cell = document.createElement('span');
    cell.textContent = updatesCompatText(it);
    // 可下载（远程）事件按设计没有本地包文件；仅
    // local events with a vanished file need the "包文件不存在" hint.
    if (it.package_available === false && !updatesDownloadHint(it)) {
      const hint = document.createElement('span');
      hint.className = 'runner-update-hint';
      hint.textContent = updatesPackageText(it);
      cell.appendChild(hint);
    }
    return cell;
  }

  function updateRowActions(item) {
    const it = item && typeof item === 'object' ? item : {};
    const wrap = document.createElement('div');
    wrap.className = 'runner-update-actions';
    const install = document.createElement('button');
    install.type = 'button';
    install.textContent = '安装';
    install.disabled = !updatesCanInstall(it);
    const hint = updateInstallHint(it);
    install.title = hint
      ? hint
      : '安装该发布（POST /runner/updates/install；后端按来源下载/安装并自动标记已安装）';
    install.addEventListener('click', function () { installUpdateEvent(it); });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = '忽略';
    dismiss.title = '把该发布标记为已忽略（POST /runner/updates/ack status=dismissed）';
    dismiss.addEventListener('click', function () { dismissUpdateEvent(it); });
    wrap.appendChild(install);
    wrap.appendChild(dismiss);
    return wrap;
  }

  function renderRunnerUpdates(body, errorText) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    const enabled = b ? updatesEnabled(b) : false;
    const rows = b ? updatesVisibleRows(updatesList(b)) : [];
    const serverError = b && b.error !== undefined && b.error !== null
      ? String(b.error).trim()
      : '';
    const err = String(errorText === undefined || errorText === null ? '' : errorText).trim();
    updateNavBadge(b ? updatesBadgeCount(updatesList(b)) : 0);
    if (el.updatesSummary) {
      el.updatesSummary.textContent = !b
        ? '—'
        : (rows.length
          ? (enabled ? 'exchange' : '发布源') + ' · ' + rows.length + ' 条新发布'
          : (enabled ? 'exchange · 暂无新发布' : 'exchange 未启用'));
    }
    const statusKind = err || serverError
      ? 'err'
      : (rows.length ? 'ok' : '');
    setUpdatesStatus(updatesListStatusText(b, err), statusKind);
    if (!el.updatesList) return;
    if (!b) {
      el.updatesList.textContent = '（未加载）';
      return;
    }
    if (!enabled && !rows.length) {
      el.updatesList.textContent = '未配置 exchange 目录（config/live.json → exchange.dir）';
      return;
    }
    const tableRows = rows.map(function (item) {
      const it = item && typeof item === 'object' ? item : {};
      const version = it.task_version === undefined || it.task_version === null || it.task_version === ''
        ? '—'
        : 'v' + String(it.task_version);
      return [
        { text: runnerValueText(it.task_id), title: updateRowText(it) },
        { text: version, cls: 'runner-update-version' },
        makeBadge(updatesActionLabel(it.action), updateActionBadgeClass(it.action)),
        updateSourceCell(it),
        runnerTimeText(it.published_at_ms),
        updateCompatCell(it),
        updateRowActions(it),
      ];
    });
    renderTable(
      el.updatesList,
      ['任务', '版本', '动作', '来源', '发布时间', '兼容性', '操作'],
      tableRows,
      '暂无新发布'
    );
  }

  async function loadRunnerUpdates() {
    try {
      const body = await runnerFetchJson(RUNNER_API.updates);
      state.updates = body;
      renderRunnerUpdates(body, '');
      return '';
    } catch (e) {
      const message = runnerErrorText(e);
      // 软失败：保留上次正常数据/列表；仅由状态
      // 行提示读取失败。
      renderRunnerUpdates(state.updates, message);
      return '新发布读取失败：' + message;
    }
  }

  function setUpdatesBusy(busy) {
    updatesBusy = !!busy;
    if (el.updatesRefresh) el.updatesRefresh.disabled = updatesBusy;
  }

  async function ackUpdateEvents(ids, status) {
    const body = updatesAckBody(ids, status);
    if (!body.event_ids.length) return '缺少 event_id，无法标记发布事件';
    try {
      await runnerFetchJson(RUNNER_API.updatesAck, { method: 'POST', body: body });
      return '';
    } catch (e) {
      return runnerErrorText(e);
    }
  }

  // P2：通过后端安装一条发布事件（后端解析来源、
  // 按需下载、安装并回执 installed）。旧后端没有
  // POST /runner/updates/install 时回退到旧本地路径安装 + 回执
  // （事件仍带 package_path 时）。
  async function installUpdateEvent(item) {
    if (updatesBusy || packagesBusy) return;
    const it = item && typeof item === 'object' ? item : {};
    const eventId = it.event_id === undefined || it.event_id === null
      ? ''
      : String(it.event_id).trim();
    if (!eventId) {
      setUpdatesStatus('无法安装：缺少 event_id', 'err');
      return;
    }
    if (it.compatible === false) {
      setUpdatesStatus('无法安装：' + updatesCompatText(it), 'err');
      return;
    }
    setUpdatesBusy(true);
    const downloadHint = updatesDownloadHint(it);
    setUpdatesStatus(
      downloadHint
        ? '下载并安装中…（由 Runner 按来源下载，完成后自动标记已安装）'
        : '安装中…（后端按来源安装并自动标记已安装）',
      ''
    );
    try {
      let result;
      try {
        result = await runnerFetchJson(RUNNER_API.updatesInstall, {
          method: 'POST',
          body: updatesInstallBody(eventId),
        });
      } catch (e) {
        // 对没有 /runner/updates/install 的后端优雅降级：
        // 只有 404 才能安全回退（表示“路由未实现”）。
        const legacyPath = updatesInstallPath(it);
        if (!(e && e.status === 404) || !legacyPath) throw e;
        result = await runnerFetchJson(RUNNER_API.install, {
          method: 'POST',
          body: runnerInstallBody(legacyPath, false),
        });
        const ackError = await ackUpdateEvents([it.event_id], 'installed');
        if (ackError) {
          result = Object.assign({}, result, { ack_error: ackError });
        }
      }
      // 识别两种响应形状：P2 安装接口返回
      // {installed:{task_id,...}, warning?}，旧版 /runner/install 返回
      // {task_id,...}。两者都归一为一条消息。
      const resultObj = result && typeof result === 'object' ? result : {};
      const installed = resultObj.installed && typeof resultObj.installed === 'object'
        ? resultObj.installed
        : resultObj;
      const rawTask = installed.task_id !== undefined && installed.task_id !== null
        ? installed.task_id
        : (installed.task !== undefined && installed.task !== null ? installed.task : '');
      const taskName = runnerValueText(
        rawTask !== undefined && rawTask !== null && rawTask !== '' ? rawTask : it.task_id
      );
      const warning = resultObj.ack_error
        ? String(resultObj.ack_error)
        : (resultObj.warning !== undefined && resultObj.warning !== null
          ? String(resultObj.warning)
          : '');
      await loadPackagesPage();
      await loadRunnerUpdates();
      await loadTasksPage();
      setUpdatesStatus(
        warning
          ? '已安装 ' + taskName + '，但标记发布事件失败：' + warning
          : '已安装 ' + taskName + '（发布事件已标记为已安装）',
        warning ? 'warn' : 'ok'
      );
      setPageStatus('已从新发布安装：' + taskName, 'ok');
      updateLastRefresh();
    } catch (e) {
      setUpdatesStatus('安装失败：' + runnerPackagesErrorText(e), 'err');
    } finally {
      setUpdatesBusy(false);
    }
  }

  async function dismissUpdateEvent(item) {
    if (updatesBusy) return;
    const it = item && typeof item === 'object' ? item : {};
    setUpdatesBusy(true);
    try {
      const ackError = await ackUpdateEvents([it.event_id], 'dismissed');
      if (ackError) {
        setUpdatesStatus('忽略失败：' + ackError, 'err');
        return;
      }
      await loadRunnerUpdates();
      setUpdatesStatus('已忽略：' + updateRowText(it), 'ok');
    } finally {
      setUpdatesBusy(false);
    }
  }

  // Runner UI 打开时每 5 秒轮询；页面隐藏时暂停，
  // 恢复可见时立即读一次。计时器不会超出页面生命周期。
  function stopUpdatesPolling() {
    if (updatesPollTimer !== null) {
      clearInterval(updatesPollTimer);
      updatesPollTimer = null;
    }
  }

  function startUpdatesPolling() {
    stopUpdatesPolling();
    if (!el.updatesSection) return;
    updatesPollTimer = setInterval(function () {
      pollRunnerUpdatesOnce();
    }, RUNNER_UPDATES_POLL_MS);
  }

  async function pollRunnerUpdatesOnce() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (state.busy || packagesBusy || updatesBusy) return;
    await loadRunnerUpdates();
  }

  async function installRunnerPackage() {
    if (packagesBusy) return;
    const body = runnerInstallBody(
      el.installPath ? el.installPath.value : '',
      el.installForce ? el.installForce.checked : false
    );
    if (!body.path) {
      if (el.installError) el.installError.textContent = '· 请填写本机 .oaspkg 路径';
      if (el.installStatus) {
        el.installStatus.textContent = '未安装';
        el.installStatus.className = 'muted small err';
      }
      return;
    }
    packagesBusy = true;
    setPackagesBusy(true);
    if (el.installError) el.installError.textContent = '';
    if (el.installWarnings) el.installWarnings.textContent = '';
    if (el.installResult) el.installResult.textContent = '安装中…';
    if (el.installStatus) {
      el.installStatus.textContent = '安装中…（sha256 / 解包 / 复检）';
      el.installStatus.className = 'muted small';
    }
    try {
      const result = await runnerFetchJson(RUNNER_API.install, { method: 'POST', body: body });
      renderInstallResult(result);
      if (el.installStatus) {
        el.installStatus.textContent = '安装成功';
        el.installStatus.className = 'muted small ok';
      }
      setPageStatus('已安装任务包：' + runnerValueText(result.task_id || result.task), 'ok');
      await loadPackagesPage();
    } catch (e) {
      if (el.installError) el.installError.textContent = installErrorLines(e).join('\n');
      if (el.installResult) el.installResult.textContent = '—';
      if (el.installStatus) {
        el.installStatus.textContent = '安装失败';
        el.installStatus.className = 'muted small err';
      }
    } finally {
      packagesBusy = false;
      setPackagesBusy(false);
    }
  }

  async function uninstallRunnerPackage(task) {
    if (packagesBusy || !task) return;
    if (typeof window.confirm === 'function' &&
        !window.confirm('卸载任务包「' + task + '」？\n\n任务目录会先备份到 packages/backup/，再从已安装清单移除。')) {
      return;
    }
    packagesBusy = true;
    setPackagesBusy(true);
    if (el.packagesStatus) {
      el.packagesStatus.textContent = '卸载中…';
      el.packagesStatus.className = 'muted small';
    }
    try {
      await runnerFetchJson(RUNNER_API.uninstall, { method: 'POST', body: { task_id: task } });
      setPageStatus('已卸载任务包：' + task, 'ok');
      await loadPackagesPage();
    } catch (e) {
      if (el.packagesStatus) {
        el.packagesStatus.textContent = '卸载失败：' + installErrorLines(e).join('；');
        el.packagesStatus.className = 'muted small err';
      }
    } finally {
      packagesBusy = false;
      setPackagesBusy(false);
    }
  }

  async function activateRunnerPackage(task) {
    if (packagesBusy || !task) return;
    if (typeof window.confirm === 'function' &&
        !window.confirm('回滚任务「' + task + '」到最近备份？\n\n当前任务目录会先备份。')) {
      return;
    }
    packagesBusy = true;
    setPackagesBusy(true);
    if (el.packagesStatus) {
      el.packagesStatus.textContent = '回滚中…';
      el.packagesStatus.className = 'muted small';
    }
    try {
      await runnerFetchJson(RUNNER_API.packagesActivate, { method: 'POST', body: { task_id: task } });
      setPageStatus('已回滚任务包：' + task, 'ok');
      await loadPackagesPage();
    } catch (e) {
      if (el.packagesStatus) {
        el.packagesStatus.textContent = '回滚失败：' + installErrorLines(e).join('；');
        el.packagesStatus.className = 'muted small err';
      }
    } finally {
      packagesBusy = false;
      setPackagesBusy(false);
    }
  }

  // --- 任务配置值（Runner 本机 config/values.json） ---------------------------

  function runnerConfigDefaultText(value) {
    if (value === '') return '（空字符串）';
    return runnerValueText(value);
  }

  function runnerConfigHintText(param, kind) {
    const p = param || {};
    const bits = [];
    if (kind === 'number') {
      const hasMin = p.min !== undefined && p.min !== null && p.min !== '' && isFinite(Number(p.min));
      const hasMax = p.max !== undefined && p.max !== null && p.max !== '' && isFinite(Number(p.max));
      if (hasMin && hasMax) bits.push('范围 ' + Number(p.min) + ' ~ ' + Number(p.max));
      else if (hasMin) bits.push('最小 ' + Number(p.min));
      else if (hasMax) bits.push('最大 ' + Number(p.max));
      if (runnerConfigIsIntegerType(p)) bits.push('整数');
    }
    if ((kind === 'select' || kind === 'number') && Array.isArray(p.enum) && p.enum.length) {
      bits.push('可选：' + p.enum.map(String).join(' / '));
    }
    if (p.default !== undefined && p.default !== null) {
      bits.push('默认：' + runnerConfigDefaultText(p.default));
    }
    return bits.join(' · ');
  }

  // P2：读取当前表单为 {useFlags, rawValues}，供保存/汇总使用。
  function readRunnerConfigForm() {
    const useFlags = {};
    const rawValues = {};
    if (!el.configFields) return { useFlags: useFlags, rawValues: rawValues };
    const uses = el.configFields.querySelectorAll('input[data-use]');
    for (const use of uses) {
      const key = use.getAttribute('data-use');
      if (key) useFlags[key] = use.checked;
    }
    const controls = el.configFields.querySelectorAll('input[data-key], select[data-key]');
    for (const control of controls) {
      const key = control.getAttribute('data-key');
      if (!key) continue;
      rawValues[key] = control.value;
    }
    return { useFlags: useFlags, rawValues: rawValues };
  }

  function runnerParamByKey(key) {
    for (const param of configParams) {
      if (!param || typeof param !== 'object') continue;
      const paramKey = param.key === undefined || param.key === null ? '' : String(param.key).trim();
      if (paramKey === key) return param;
    }
    return null;
  }

  // Refresh one row: 使用 switch disables the control; hint reflects
  // default/留空/required semantics; blocked rows are red.
  function refreshRunnerConfigRow(row) {
    if (!row) return;
    const use = row.querySelector('input[data-use]');
    const control = row.querySelector('input[data-key], select[data-key]');
    const hint = row.querySelector('.runner-config-row-hint');
    const err = row.querySelector('.runner-config-row-err');
    if (!use || !control) return;
    const key = row.getAttribute('data-key') || '';
    const param = runnerParamByKey(key) || {};
    const enabled = use.checked === true;
    row.classList.toggle('disabled', !enabled);
    control.disabled = !enabled;
    const state = runnerParamUseState(param, control.value, enabled);
    const base = runnerConfigHintText(param, runnerConfigFieldKind(param));
    // V2.0c: required 且无值 = 行内橙色提示（允许保存，运行前告警），不阻断。
    const requiredMissing = param && param.required === true && state.hasValue !== true;
    if (hint) {
      hint.textContent = [base, state.hint,
        requiredMissing ? '必填：使用端应填写（允许保存，运行前告警）' : ''].filter(Boolean).join(' · ');
    }
    row.classList.toggle('required-missing', !!requiredMissing);
    row.classList.toggle('blocked', !requiredMissing && (state.blocked || !!(err && err.textContent)));
  }

  function refreshAllRunnerConfigRows() {
    if (!el.configFields) return;
    const rows = el.configFields.querySelectorAll('.runner-config-row');
    for (const row of rows) refreshRunnerConfigRow(row);
  }

  // Top summary「N/M 项已设置 · 分组 G 个」from the enabled + non-blank controls.
  function updateRunnerConfigSummary() {
    if (!el.configSummary) return;
    const form = readRunnerConfigForm();
    const visible = {};
    for (const key of Object.keys(form.rawValues)) {
      if (form.useFlags[key] === false) continue;
      visible[key] = form.rawValues[key];
    }
    el.configSummary.textContent = runnerVariableSummary(configParams, visible);
  }

  function runnerParamTypeBadges(param) {
    const wrap = document.createElement('div');
    wrap.className = 'runner-config-types';
    wrap.appendChild(makeBadge(runnerParamTypeText(param), 'kind'));
    const roleText = runnerParamRoleText(param);
    if (roleText) wrap.appendChild(makeBadge(roleText, 'warn'));
    if (param && param.required === true) wrap.appendChild(makeBadge('必填', 'warn'));
    return wrap;
  }

  function buildRunnerConfigRow(param, index) {
    const p = param && typeof param === 'object' ? param : {};
    const key = p.key === undefined || p.key === null ? '' : String(p.key).trim();
    if (!key) return null;
    const rawLabel = p.label === undefined || p.label === null ? '' : String(p.label).trim();
    const labelText = rawLabel || key;
    const kind = runnerConfigFieldKind(p);
    const saved = runnerParamSavedValue(p, configValues);
    const controlId = 'runner-cfg-' + index;

    const row = document.createElement('div');
    row.className = 'runner-config-row';
    row.id = 'runner-config-row-' + index;
    row.setAttribute('data-key', key);
    row.setAttribute('data-label', labelText);

    const useLabel = document.createElement('label');
    useLabel.className = 'runner-config-use';
    const use = document.createElement('input');
    use.type = 'checkbox';
    use.id = 'runner-config-use-' + index;
    use.setAttribute('data-use', key);
    use.checked = saved !== undefined;
    useLabel.append(use, document.createTextNode(' 使用'));

    const meta = document.createElement('div');
    meta.className = 'runner-config-meta';
    const label = document.createElement('label');
    label.className = 'runner-config-label';
    label.setAttribute('for', controlId);
    label.textContent = labelText;
    const keyEl = document.createElement('span');
    keyEl.className = 'runner-config-key';
    keyEl.textContent = key;
    label.appendChild(keyEl);
    meta.appendChild(label);
    // U-T6：派生参数行（来自 ocr_var 素材）显示「素材 <id> · 当前默认「…」」，
    // 让使用端知道这一项改的是哪个素材的识别文字。
    const assetSubtitle = runnerParamAssetSubtitle(p);
    if (assetSubtitle) {
      const sub = document.createElement('div');
      sub.className = 'runner-config-asset-sub';
      sub.textContent = assetSubtitle;
      meta.appendChild(sub);
    }
    if (p.description !== undefined && p.description !== null && String(p.description).trim() !== '') {
      const desc = document.createElement('div');
      desc.className = 'runner-config-desc';
      desc.textContent = String(p.description);
      meta.appendChild(desc);
    }
    meta.appendChild(runnerParamTypeBadges(p));

    const controlWrap = document.createElement('div');
    controlWrap.className = 'runner-config-control';
    let control;
    if (kind === 'bool') {
      // P2: bool 三态（未设置 / 是 / 否）；'' = 未设置 ⇒ 不写入 values。
      control = document.createElement('select');
      control.id = 'runner-config-bool-' + index;
      const tri = saved === undefined ? '' : runnerParamBoolTri(saved);
      for (const [value, text] of [['', '未设置'], ['true', '是'], ['false', '否']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        control.appendChild(option);
      }
      control.value = tri;
    } else if (kind === 'number') {
      control = document.createElement('input');
      control.type = 'number';
      control.inputMode = 'decimal';
      control.step = runnerConfigIsIntegerType(p) ? '1' : 'any';
      if (p.min !== undefined && p.min !== null && p.min !== '' && isFinite(Number(p.min))) {
        control.min = String(Number(p.min));
      }
      if (p.max !== undefined && p.max !== null && p.max !== '' && isFinite(Number(p.max))) {
        control.max = String(Number(p.max));
      }
      control.value = saved === undefined ? '' : String(saved);
    } else if (kind === 'select') {
      control = document.createElement('select');
      const options = (Array.isArray(p.enum) ? p.enum : []).map(String);
      const emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = p.default !== undefined && p.default !== null
        ? '（默认：' + runnerParamDefaultText(p) + '）'
        : '（未设置）';
      control.appendChild(emptyOption);
      for (const optionText of options) {
        const option = document.createElement('option');
        option.value = optionText;
        option.textContent = optionText;
        control.appendChild(option);
      }
      const current = saved === undefined ? '' : String(saved);
      control.value = options.indexOf(current) >= 0 ? current : '';
    } else {
      control = document.createElement('input');
      control.type = 'text';
      control.value = saved === undefined ? '' : String(saved);
    }
    control.name = controlId;
    control.setAttribute('data-key', key);
    if (p.required === true) control.setAttribute('aria-required', 'true');
    controlWrap.appendChild(control);

    const actions = document.createElement('div');
    actions.className = 'runner-config-row-actions';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'runner-config-reset';
    reset.textContent = '重置';
    reset.title = '清空该参数的值（留空 = 不注入，回退默认值）';
    actions.appendChild(reset);

    const hint = document.createElement('div');
    hint.className = 'runner-config-row-hint';
    const rowErr = document.createElement('div');
    rowErr.className = 'runner-config-row-err';

    use.addEventListener('change', function () { refreshRunnerConfigRow(row); updateRunnerConfigSummary(); });
    control.addEventListener('change', function () {
      rowErr.textContent = '';
      refreshRunnerConfigRow(row);
      updateRunnerConfigSummary();
    });
    control.addEventListener('input', function () { refreshRunnerConfigRow(row); updateRunnerConfigSummary(); });
    reset.addEventListener('click', function () {
      control.value = '';
      rowErr.textContent = '';
      refreshRunnerConfigRow(row);
      updateRunnerConfigSummary();
      if (typeof control.focus === 'function') control.focus();
    });

    row.append(useLabel, meta, controlWrap, actions, hint, rowErr);
    return row;
  }

  function renderRunnerConfigFields(params, values) {
    if (!el.configFields) return;
    clearNode(el.configFields);
    el.configFields.className = '';
    configValues = values && typeof values === 'object' ? values : {};
    if (!params.length) {
      el.configFields.textContent = '该任务没有使用端可配置的变量';
      el.configFields.className = 'runner-config-empty';
      updateRunnerConfigSummary();
      return;
    }
    const groups = runnerVariableGroups(params);
    let index = 0;
    for (const group of groups) {
      const details = document.createElement('details');
      details.className = 'runner-config-group';
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = group.group;
      const count = document.createElement('span');
      count.className = 'runner-config-group-count';
      count.textContent = group.variables.length + ' 项';
      summary.appendChild(count);
      details.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'runner-config-group-body';
      for (const param of group.variables) {
        const row = buildRunnerConfigRow(param, index);
        index += 1;
        if (row) body.appendChild(row);
      }
      details.appendChild(body);
      el.configFields.appendChild(details);
    }
    refreshAllRunnerConfigRows();
    updateRunnerConfigSummary();
  }

  // 将服务端错误映射回对应行（400 错误会指出 key/label）。对应行
  // 高亮，并在行下方重复错误消息。
  function applyRunnerConfigRowErrors(errors) {
    if (!el.configFields) return;
    const rows = el.configFields.querySelectorAll('.runner-config-row');
    for (const row of rows) {
      const err = row.querySelector('.runner-config-row-err');
      if (err) err.textContent = '';
    }
    const lines = Array.isArray(errors) ? errors : [];
    for (const line of lines) {
      const text = String(line === undefined || line === null ? '' : line);
      if (!text) continue;
      for (const row of rows) {
        const key = row.getAttribute('data-key') || '';
        const label = row.getAttribute('data-label') || '';
        if (!((key && text.indexOf(key) >= 0) || (label && text.indexOf(label) >= 0))) continue;
        const err = row.querySelector('.runner-config-row-err');
        if (err && !err.textContent) err.textContent = text;
      }
    }
    refreshAllRunnerConfigRows();
  }


  function closeRunnerConfigDialog() {
    if (!el.configDialog) return;
    if (typeof el.configDialog.close === 'function') {
      if (el.configDialog.open) el.configDialog.close();
    } else {
      el.configDialog.removeAttribute('open');
    }
  }

  async function loadRunnerConfig(task) {
    configLoaded = false;
    try {
      const body = await runnerFetchJson(runnerConfigUrl(task));
      if (configTask !== task) return; // 已关闭/切换到别的任务，丢弃过期响应
      // V2.0c：新 API 返回 variables；旧 params 回退保证旧 Runner 仍可用。
      const variables = Array.isArray(body.variables) ? body.variables : [];
      const params = variables.length
        ? runnerVariableRows(variables)
        : runnerParamOcrVarOnly(Array.isArray(body.params) ? body.params : []);
      const values = body.values && typeof body.values === 'object' ? body.values : {};
      configParams = params;
      configLoaded = true;
      renderRunnerConfigFields(params, values);
      if (el.configError) el.configError.textContent = '';
      if (el.configStatus) {
        let statusText = '已加载 ' + params.length + ' 项使用端变量';
        if (body.updated_ms !== undefined && body.updated_ms !== null) {
          statusText += ' · 上次保存 ' + runnerTimeText(body.updated_ms);
        }
        el.configStatus.textContent = statusText;
        el.configStatus.className = 'muted small';
      }
      if (el.configSave) el.configSave.disabled = params.length === 0;
    } catch (e) {
      if (configTask !== task) return;
      const message = '配置读取失败：' + runnerErrorText(e);
      if (el.configError) el.configError.textContent = message;
      if (el.configStatus) {
        el.configStatus.textContent = '读取失败';
        el.configStatus.className = 'muted small err';
      }
      if (el.configFields) {
        clearNode(el.configFields);
        el.configFields.textContent = '（读取失败）';
        el.configFields.className = 'runner-config-empty';
      }
      if (el.configSave) el.configSave.disabled = true;
    }
  }

  function openRunnerConfigDialog(task) {
    const name = String(task === undefined || task === null ? '' : task).trim();
    if (!el.configDialog || !name) return;
    configTask = name;
    configParams = [];
    configValues = {};
    configLoaded = false;
    configBusy = false;
    if (el.configTitle) el.configTitle.textContent = '任务配置 · ' + name;
    if (el.configSummary) el.configSummary.textContent = '—';
    if (el.configStatus) {
      el.configStatus.textContent = '读取中…';
      el.configStatus.className = 'muted small';
    }
    if (el.configError) el.configError.textContent = '';
    if (el.configFields) {
      clearNode(el.configFields);
      el.configFields.textContent = '（读取中…）';
      el.configFields.className = 'runner-config-empty';
    }
    if (el.configSave) el.configSave.disabled = true;
    if (typeof el.configDialog.showModal === 'function') {
      if (!el.configDialog.open) el.configDialog.showModal();
    } else {
      el.configDialog.setAttribute('open', '');
    }
    loadRunnerConfig(name);
  }

  async function saveRunnerConfig() {
    if (configBusy || !configLoaded || !configTask) return;
    const task = configTask;
    const form = readRunnerConfigForm();
    const collected = runnerParamCollectUse(configParams, form.useFlags, form.rawValues);
    if (!collected.ok) {
      if (el.configError) {
        el.configError.textContent = collected.errors.map(function (line) {
          return '· ' + line;
        }).join('\n');
      }
      if (el.configStatus) {
        el.configStatus.textContent = '未保存：' + collected.errors.length + ' 处校验错误';
        el.configStatus.className = 'muted small err';
      }
      applyRunnerConfigRowErrors(collected.errors);
      return;
    }
    applyRunnerConfigRowErrors([]);
    configBusy = true;
    if (el.configSave) el.configSave.disabled = true;
    if (el.configError) el.configError.textContent = '';
    if (el.configStatus) {
      el.configStatus.textContent = '保存中…';
      el.configStatus.className = 'muted small';
    }
    try {
      const body = await runnerFetchJson(runnerConfigUrl(task), {
        method: 'PUT',
        // D 批：表单只编辑 ocr_var 派生行；未显示的通用参数值原样保留（不清空旧值）。
        body: { values: Object.assign({}, configValues, collected.values) },
      });
      const saved = body.values && typeof body.values === 'object' ? body.values : collected.values;
      const savedCount = Object.keys(saved).length;
      setPageStatus('已保存任务配置：' + task + '（' + savedCount + ' 项）', 'ok');
      closeRunnerConfigDialog();
      // 刷新列表（值本身不显示在列表里，但保持页面数据新鲜）。
      await loadTasksPage();
    } catch (e) {
      let message;
      if (e && e.status === 404) {
        message = '任务已不存在：' + task + '（可能已被卸载）';
      } else if (e && Array.isArray(e.details) && e.details.length) {
        message = '配置保存失败：\n' + e.details.map(function (line) {
          return '· ' + line;
        }).join('\n');
        applyRunnerConfigRowErrors(e.details);
      } else {
        message = '配置保存失败：' + runnerErrorText(e);
      }
      if (el.configError) el.configError.textContent = message;
      if (el.configStatus) {
        el.configStatus.textContent = '保存失败';
        el.configStatus.className = 'muted small err';
      }
    } finally {
      configBusy = false;
      if (el.configSave && configLoaded && configTask === task) {
        el.configSave.disabled = configParams.length === 0;
      }
    }
  }

  // =======================================================================
  // PR7：旧 Studio 调度 UI，已迁入 Runner 的 #page-queue。
  // 元素 id 保留 Studio 页面（84 个），以便 DOM 审计
  // 一一对应；仅适配 HTTP/日志/页面路由/角标/表格接缝。
  // =======================================================================

  // --- 旧 Studio 调度页元素常量（80 个；id 全部保留） -----------------------
  const pageSchedSummary = document.getElementById('page-sched-summary');
  const pageSchedEntries = document.getElementById('page-sched-entries');
  const pageSchedRefresh = document.getElementById('page-sched-refresh');
  const pageSchedReset = document.getElementById('page-sched-reset');
  const pageSchedMode = document.getElementById('page-sched-mode');
  const pageSchedPasses = document.getElementById('page-sched-passes');
  const pageSchedNextWake = document.getElementById('page-sched-next-wake');
  const pageSchedRunning = document.getElementById('page-sched-running');
  const pageSchedQuota = document.getElementById('page-sched-quota');
  const pageSchedConfigStatus = document.getElementById('page-sched-config-status');
  const pageSchedSave = document.getElementById('page-sched-save');
  const pageSchedReload = document.getElementById('page-sched-reload');
  const pageSchedAddEntry = document.getElementById('page-sched-add-entry');
  const pageSchedQueues = document.getElementById('page-sched-queues');
  const pageSchedAddQueue = document.getElementById('page-sched-add-queue');
  const pageSchedJson = document.getElementById('page-sched-json');
  const pageSchedJsonSave = document.getElementById('page-sched-json-save');
  const pageSchedJsonReload = document.getElementById('page-sched-json-reload');
  const pageSchedJsonStatus = document.getElementById('page-sched-json-status');
  const pageSchedRunsSummary = document.getElementById('page-sched-runs-summary');
  const pageSchedRunsRefresh = document.getElementById('page-sched-runs-refresh');
  const pageSchedRunsTask = document.getElementById('page-sched-runs-task');
  const pageSchedRunsOutcome = document.getElementById('page-sched-runs-outcome');
  const pageSchedRunsLimit = document.getElementById('page-sched-runs-limit');
  const pageSchedRunsClear = document.getElementById('page-sched-runs-clear');
  const pageSchedRunsStatus = document.getElementById('page-sched-runs-status');
  const pageSchedRunsList = document.getElementById('page-sched-runs-list');
  const schedRunDialog = document.getElementById('page-sched-runs-dialog');
  const schedRunDialogTitle = document.getElementById('page-sched-runs-detail-title');
  const schedRunDialogBody = document.getElementById('page-sched-runs-detail-body');
  const schedRunDialogError = document.getElementById('page-sched-runs-detail-error');
  const schedRunDialogRefresh = document.getElementById('page-sched-runs-detail-refresh');
  const schedRunDialogClose = document.getElementById('page-sched-runs-detail-close');
  const btnSchedOpenPage = document.getElementById('btn-sched-open-page');
  const schedEntryDialog = document.getElementById('sched-entry-dialog');
  const schedEntryTitle = document.getElementById('sched-entry-title');
  const schedEntryModeHint = document.getElementById('sched-entry-mode-hint');
  const schedEntryKind = document.getElementById('sched-entry-kind');
  const schedEntryTarget = document.getElementById('sched-entry-target');
  const schedEntryIdEl = document.getElementById('sched-entry-id');
  const schedEntryEnabled = document.getElementById('sched-entry-enabled');
  const schedEntryLifecycle = document.getElementById('sched-entry-lifecycle');
  const schedEntryTempHint = document.getElementById('sched-entry-temp-hint');
  const schedEntryWindows = document.getElementById('sched-entry-windows');
  const schedEntryWindowsJson = document.getElementById('sched-entry-windows-json');
  const schedEntryQuotaPer = document.getElementById('sched-entry-quota-per');
  const schedEntryQuotaTimes = document.getElementById('sched-entry-quota-times');
  const schedEntryRetry = document.getElementById('sched-entry-retry');
  const schedEntryCooldown = document.getElementById('sched-entry-cooldown');
  const schedEntryParams = document.getElementById('sched-entry-params');
  const schedEntryError = document.getElementById('sched-entry-error');
  const schedEntryCancel = document.getElementById('sched-entry-cancel');
  const schedEntrySave = document.getElementById('sched-entry-save');
  const schedQueueDialog = document.getElementById('sched-queue-dialog');
  const schedQueueTitle = document.getElementById('sched-queue-title');
  const schedQueueId = document.getElementById('sched-queue-id');
  const schedQueueName = document.getElementById('sched-queue-name');
  const schedQueueMemberAddBtn = document.getElementById('sched-queue-member-add');
  const schedQueueMembers = document.getElementById('sched-queue-members');
  const schedQueueTaskPool = document.getElementById('sched-queue-task-pool');
  const schedQueueTotalRounds = document.getElementById('sched-queue-total-rounds');
  const schedQueueOnFailure = document.getElementById('sched-queue-on-failure');
  const schedQueueBetweenMs = document.getElementById('sched-queue-between-ms');
  const schedQueueRoundsHint = document.getElementById('sched-queue-rounds-hint');
  const schedQueueLockHint = document.getElementById('sched-queue-lock-hint');
  const schedQueueError = document.getElementById('sched-queue-error');
  const schedQueueCancel = document.getElementById('sched-queue-cancel');
  const schedQueueSave = document.getElementById('sched-queue-save');
  const btnSchedRefresh = document.getElementById('btn-sched-refresh');
  const btnSchedReset = document.getElementById('btn-sched-reset');
  const schedSummary = document.getElementById('sched-summary');
  const schedEntries = document.getElementById('sched-entries');
  const resetMemoryDialog = document.getElementById('reset-memory-dialog');
  const resetTaskList = document.getElementById('reset-task-list');
  const resetIncludeCheckpoint = document.getElementById('reset-include-checkpoint');
  const resetError = document.getElementById('reset-error');
  const btnResetAll = document.getElementById('btn-reset-all');
  const btnResetInvert = document.getElementById('btn-reset-invert');
  const btnResetNone = document.getElementById('btn-reset-none');
  const btnResetSubmit = document.getElementById('btn-reset-submit');
  const btnResetCancel = document.getElementById('btn-reset-cancel');
  const resetResult = document.getElementById('reset-result');
  const pageSchedJsonError = document.getElementById('page-sched-json-error');

  // --- 旧 Studio 调度页状态 ---------------------------------------------------
  let schedulerStatus = null;
  let scheduleConfig = null;
  let scheduleConfigMeta = null;
  let scheduleConfigError = '';
  let scheduleStatusError = '';
  let scheduleConfigBase = '';
  let scheduleTasksCache = [];
  let scheduleBusy = false;
  let scheduleJsonDirty = false;
  let scheduleEntryDialogState = null;
  let scheduleQueueDialogState = null;
  let scheduleRunsData = null;
  let scheduleRunsError = '';
  let scheduleRunsLoading = false;
  let scheduleRunsFilter = { limit: 200, task: '', outcome: '', queueId: '' };
  let scheduleRunDetailRunId = '';


  function schedLog(message, level) {
    const text = String(message == null ? '' : message);
    setPageStatus(text, level === 'ERROR' ? 'err' : level === 'WARN' ? 'warn' : 'ok');
    if (el.queueStatus) {
      el.queueStatus.textContent = text;
      el.queueStatus.className = 'muted small' + (level === 'ERROR' ? ' err' : level === 'WARN' ? ' warn' : '');
    }
  }

  function activateRunnerQueuePage() {
    showPage('queue');
  }

  // --- 调度页刷新编排 --------------------------------------------------------
  async function refreshSchedulePage() {
    if (!pageSchedSummary) return [];
    setScheduleBusy(true);
    const errors = [];
    let status = null;
    scheduleStatusError = '';
    try {
      try {
        status = await runnerFetchJson(RUNNER_API.schedulerStatus);
        schedulerStatus = status;
        state.scheduler = status;
      } catch (e) {
        scheduleStatusError = runnerErrorText(e);
        const message = schedStatusErrorText(scheduleStatusError);
        errors.push(message);
        schedLog(message, 'ERROR');
      }
      const cfg = await loadScheduleConfig(true);
      if (!cfg) {
        const message = '调度配置读取失败：' + (scheduleConfigError || '未知错误');
        errors.push(message);
      }
      populateScheduleRunsTaskOptions();
      const runs = await refreshScheduleRuns();
      if (runs && runs.ok === false && runs.error) errors.push(runs.error);
      syncScheduleRunsControls();
      renderScheduleStatusCard(status);
      if (pageSchedJson && !scheduleJsonDirty) {
        pageSchedJson.value = cfg ? JSON.stringify(cfg, null, 2) : '';
        if (pageSchedJsonError) pageSchedJsonError.textContent = '';
        if (pageSchedJsonStatus) {
          pageSchedJsonStatus.textContent = cfg ? '已从磁盘载入' : '配置文件不存在：保存后会创建';
        }
      }
      renderScheduleEntries(status, cfg);
      renderScheduleQueues(status, cfg);
      renderScheduler(status);
    } catch (e) {
      const message = '刷新调度页异常：' + runnerErrorText(e);
      errors.push(message);
      schedLog(message, 'ERROR');
    } finally {
      setScheduleBusy(false);
    }
    return errors;
  }

  // --- 配置纯函数（77 个，旧 Studio 原样保留） --------------------------------
// --- P3: 调度配置纯函数（可被 ui_pure_test.js 提取；不碰 DOM） ---------------
// 以下全部为纯数据进/纯数据出，便于 JSON 转换 /
// 条目构建 / 队列载荷 / 错误文本规则在无浏览器时
// 可测试。UI 函数位于下方并调用这些函数。

function schedEntryKindLabel(kind) {
  return kind === 'queue' ? 'queue' : 'task';
}

// `task-<任务名>` entry ids must stay unique and control-character free. Task
// 名称可含中文（保留），但不含路径分隔符。用 split/join
// 替代带引号正则，便于 ui_pure_test.js 提取该函数。
function schedSanitizeIdSegment(name) {
  let s = String(name == null ? '' : name).trim();
  s = s.replace(/[\u0000-\u001f\u007f]/g, '-');
  s = s.split('').map((c) => ('<>:"/\\|?*'.indexOf(c) >= 0 ? '-' : c)).join('');
  s = s.replace(/\.\.+/g, '.');
  s = s.replace(/^[.\s-]+|[.\s-]+$/g, '');
  if (!s) s = 'entry';
  if (s.length > 96) s = s.slice(0, 96).replace(/[.\s-]+$/g, '');
  return s || 'entry';
}

// UI 校验共用的任务名/队列 id 语法：无分隔符、无
// 控制字符（后端还会检查 Windows 保留名）。
function schedHasUnsafeNameChar(value) {
  const s = String(value == null ? '' : value);
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (code < 32 || code === 127) return true;
    if ('<>:"/\\|?*'.indexOf(c) >= 0) return true;
  }
  return false;
}

function schedUniqueId(base, used) {
  const taken = used instanceof Set ? used : new Set(used || []);
  let id = String(base || 'entry');
  let n = 2;
  while (taken.has(id)) {
    id = String(base || 'entry') + '-' + n;
    n += 1;
  }
  return id;
}

function schedEntryIdForTarget(kind, target, config) {
  const prefix = schedEntryKindLabel(kind) === 'queue' ? 'queue' : 'task';
  const used = new Set(((config && config.entries) || []).map((e) => String((e && e.entry_id) || '')));
  return schedUniqueId(prefix + '-' + schedSanitizeIdSegment(target), used);
}

function schedEmptyConfig() {
  return {
    schema_version: 4,
    config: {
      // P2-2：新建的 scheduler.json 必须真正保持调度，如同
      // 随包 dist/stage 默认值（`start-scheduler.bat` 不传 --mode）。
      // mode=stop would run a single pass and exit, which looks like "调度没生效".
      mode: 'loop',
      loop_interval_s: 60,
      loop_rounds: 0,
      utc_offset_min: 480,
      calendar: { day_reset: '00:00', week_reset: { weekday: 0, time: '00:00' } },
      guards: { active_hours: [], blackouts: [] },
      defaults: { retry: 1, cooldown: 300 },
    },
    queues: [],
    entries: [],
  };
}

// 将 GET /scheduler/config 返回内容归一为 UI 编辑的 v4 文档：
// schema 4、entries[].kind 带默认值、数组/对象保证存在。未知
// 键在此保留；后端也会将提交的 v4 文档
// 原样写回，因此保存后仍存在（仅 v3 文档会被重新归一/升级）。
function schedNormalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return schedEmptyConfig();
  const base = schedEmptyConfig();
  const out = Object.assign({}, base, raw);
  out.schema_version = 4;
  out.config = Object.assign(
    {},
    base.config,
    raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config) ? raw.config : {}
  );
  out.queues = Array.isArray(raw.queues)
    ? raw.queues.filter((q) => q && typeof q === 'object').map((q) => Object.assign({}, q))
    : [];
  out.entries = Array.isArray(raw.entries)
    ? raw.entries.filter((e) => e && typeof e === 'object').map((e) => {
      const entry = Object.assign({}, e);
      entry.kind = schedEntryKindLabel(entry.kind);
      if (!Array.isArray(entry.windows)) entry.windows = [];
      if (!entry.params || typeof entry.params !== 'object' || Array.isArray(entry.params)) entry.params = {};
      return entry;
    })
    : [];
  return out;
}

// P3 规范要求的新条目默认值：kind=task、enabled、periodic、
// 全天窗口（空数组=始终在窗口内）、quota day/1、配置默认值。
function schedDefaultTaskEntry(task, config, kind) {
  const cfg = config || schedEmptyConfig();
  const k = schedEntryKindLabel(kind || 'task');
  const defaults = (cfg.config && cfg.config.defaults) || {};
  const retry = Number.isInteger(defaults.retry) ? defaults.retry : 1;
  const cooldown = Number.isInteger(defaults.cooldown) ? defaults.cooldown : 300;
  return {
    entry_id: schedEntryIdForTarget(k, task, cfg),
    task: String(task == null ? '' : task),
    kind: k,
    enabled: true,
    lifecycle: 'periodic',
    windows: [],
    quota: { per: 'day', times: 1 },
    params: {},
    retry,
    cooldown,
  };
}

function schedWindowsToText(windows) {
  const list = Array.isArray(windows) ? windows : [];
  if (!list.length) return '全天';
  return list.map((w) => {
    const days = Array.isArray(w.days) ? w.days : [];
    const prefix = days.length ? '[' + days.join(',') + ']' : '';
    return prefix + (w.start || '00:00') + '-' + (w.end || '00:00');
  }).join(', ');
}

// 简化窗口文本：`HH:MM-HH:MM`，逗号分隔，可选 `[1,3]`
// weekday prefix per window. Empty (or 全天) = no window restriction.
function schedParseWindowsText(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw || raw === '全天' || raw === '全天候') return { ok: true, windows: [], error: '' };
  // `[1,3]` 内逗号分隔星期而非窗口：先屏蔽它们。
  const guarded = raw.replace(/\[([^\]]*)\]/g, (m, inner) => '[' + inner.replace(/[,，]/g, ' ') + ']');
  const parts = guarded.split(/[,，;；\n]+/).map((s) => s.trim()).filter(Boolean);
  const windows = [];
  for (const part of parts) {
    let days = [];
    let rest = part;
    const m = /^\[([0-9\s]+)\](.*)$/.exec(part);
    if (m) {
      const set = new Set();
      for (const d of m[1].split(/\s+/).filter(Boolean)) {
        const n = Number(d);
        if (!Number.isInteger(n) || n < 0 || n > 6) {
          return { ok: false, windows: [], error: `周几必须是 0..6（0=周一）：${part}` };
        }
        set.add(n);
      }
      days = Array.from(set).sort((a, b) => a - b);
      rest = m[2].trim();
    }
    const hm = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(rest);
    if (!hm) {
      return { ok: false, windows: [], error: `时间窗口格式应为 HH:MM-HH:MM（可加 [1,3] 前缀）：${part}` };
    }
    const h1 = Number(hm[1]);
    const h2 = Number(hm[3]);
    if (h1 > 23 || h2 > 23 || Number(hm[2]) > 59 || Number(hm[4]) > 59) {
      return { ok: false, windows: [], error: `时间超出范围：${part}` };
    }
    windows.push({
      days,
      start: String(h1).padStart(2, '0') + ':' + hm[2],
      end: String(h2).padStart(2, '0') + ':' + hm[4],
    });
  }
  return { ok: true, windows, error: '' };
}

function schedParseWindowsJson(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: true, windows: [], error: '' };
  let v;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return { ok: false, windows: [], error: 'windows JSON 解析失败：' + (e && e.message ? e.message : e) };
  }
  if (!Array.isArray(v)) return { ok: false, windows: [], error: 'windows JSON 必须是数组' };
  const windows = [];
  for (let i = 0; i < v.length; i++) {
    const w = v[i];
    if (!w || typeof w !== 'object' || Array.isArray(w)) {
      return { ok: false, windows: [], error: `windows[${i}] 必须是对象` };
    }
    const days = w.days == null ? [] : w.days;
    if (!Array.isArray(days)) return { ok: false, windows: [], error: `windows[${i}].days 必须是数组` };
    const outDays = [];
    for (const d of days) {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 0 || n > 6) {
        return { ok: false, windows: [], error: `windows[${i}].days 必须是 0..6` };
      }
      if (!outDays.includes(n)) outDays.push(n);
    }
    outDays.sort((a, b) => a - b);
    const start = String(w.start == null ? '' : w.start);
    const end = String(w.end == null ? '' : w.end);
    const hhmm = /^(\d{1,2}):(\d{2})$/;
    const sm = hhmm.exec(start);
    const em = hhmm.exec(end);
    if (!sm || !em || Number(sm[1]) > 23 || Number(em[1]) > 23 || Number(sm[2]) > 59 || Number(em[2]) > 59) {
      return { ok: false, windows: [], error: `windows[${i}] 的 start/end 需要 HH:MM` };
    }
    windows.push({
      days: outDays,
      start: String(Number(sm[1])).padStart(2, '0') + ':' + sm[2],
      end: String(Number(em[1])).padStart(2, '0') + ':' + em[2],
    });
  }
  return { ok: true, windows, error: '' };
}

function schedParseParamsText(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: true, params: {}, error: '' };
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, params: {}, error: 'params 必须是 JSON 对象（{...}）' };
    }
    return { ok: true, params: v, error: '' };
  } catch (e) {
    return { ok: false, params: {}, error: 'params JSON 解析失败：' + (e && e.message ? e.message : e) };
  }
}

function schedEntryToForm(entry, defaults) {
  const e = entry || {};
  const d = defaults || {};
  const quota = e.quota && typeof e.quota === 'object' ? e.quota : null;
  const defaultRetry = Number.isInteger(d.retry) ? d.retry : 1;
  const defaultCooldown = Number.isInteger(d.cooldown) ? d.cooldown : 300;
  return {
    entry_id: String(e.entry_id || ''),
    kind: schedEntryKindLabel(e.kind),
    task: String(e.task || ''),
    enabled: e.enabled !== false,
    lifecycle: e.lifecycle === 'temp' ? 'temp' : 'periodic',
    windows_text: schedWindowsToText(e.windows),
    windows_json: '',
    quota_per: quota && (quota.per === 'day' || quota.per === 'week') ? quota.per : '',
    quota_times: quota && quota.times ? String(quota.times) : '1',
    retry: e.retry == null ? String(defaultRetry) : String(e.retry),
    cooldown: e.cooldown == null ? String(defaultCooldown) : String(e.cooldown),
    params_text: e.params && Object.keys(e.params).length ? JSON.stringify(e.params, null, 2) : '',
  };
}

// 由表单值构建一个条目。`base` 提供可编辑的 entry_id/未知
// 键；temp 强制 windows=[] 且 quota=null（后端会拒绝两者）。
function schedBuildEntryFromForm(form, base, config) {
  const f = form || {};
  const b = base || {};
  const cfg = config || schedEmptyConfig();
  const kind = schedEntryKindLabel(f.kind || b.kind);
  const task = String(f.task == null ? (b.task || '') : f.task).trim();
  const lifecycle = f.lifecycle === 'temp' ? 'temp' : 'periodic';
  const temp = lifecycle === 'temp';
  const id = String(f.entry_id || b.entry_id || '').trim() || schedEntryIdForTarget(kind, task, cfg);
  let windows = [];
  let quota = null;
  if (!temp) {
    if (Array.isArray(f.windows)) windows = f.windows.map((w) => Object.assign({}, w));
    else if (Array.isArray(b.windows)) windows = b.windows.map((w) => Object.assign({}, w));
    if (f.quota_per === 'day' || f.quota_per === 'week') {
      const times = Math.floor(Number(f.quota_times));
      quota = { per: f.quota_per, times: Math.max(1, Math.min(1000, Number.isFinite(times) ? times : 1)) };
    } else if (f.quota_per === '') {
      quota = null;
    } else if (b.quota && (b.quota.per === 'day' || b.quota.per === 'week')) {
      quota = { per: b.quota.per, times: b.quota.times };
    }
  }
  let params = {};
  if (f.params && typeof f.params === 'object' && !Array.isArray(f.params)) params = f.params;
  else if (b.params && typeof b.params === 'object' && !Array.isArray(b.params)) params = b.params;
  const retryNum = Number(f.retry);
  const cooldownNum = Number(f.cooldown);
  const retry = Number.isInteger(retryNum) && String(f.retry == null ? '' : f.retry).trim() !== ''
    ? retryNum
    : (Number.isInteger(b.retry) ? b.retry : 1);
  const cooldown = Number.isInteger(cooldownNum) && String(f.cooldown == null ? '' : f.cooldown).trim() !== ''
    ? cooldownNum
    : (Number.isInteger(b.cooldown) ? b.cooldown : 300);
  return Object.assign({}, b, {
    entry_id: id,
    task,
    kind,
    enabled: f.enabled == null ? b.enabled !== false : !!f.enabled,
    lifecycle,
    windows,
    quota,
    params,
    retry,
    cooldown,
  });
}

function schedFindTaskEntries(config, task) {
  const t = String(task == null ? '' : task);
  return (((config && config.entries) || [])).filter(
    (e) => schedEntryKindLabel(e.kind) === 'task' && e.task === t
  );
}

function schedFindTaskQueueMember(config, task) {
  const t = String(task == null ? '' : task);
  for (const q of (config && config.queues) || []) {
    if (Array.isArray(q.members) && q.members.includes(t)) return String(q.queue_id || '');
  }
  return '';
}

// 规则 2：一个队列最多一个触发条目。
function schedQueueEntryConflict(config, queueId, exceptEntryId) {
  const qid = String(queueId == null ? '' : queueId);
  const except = String(exceptEntryId == null ? '' : exceptEntryId);
  const hit = ((config && config.entries) || []).find(
    (e) => schedEntryKindLabel(e.kind) === 'queue' && e.task === qid && e.entry_id !== except
  );
  return hit ? String(hit.entry_id || '') : '';
}

function schedValidateEntryForm(form, config, entryId, baseEntry) {
  const cfg = schedNormalizeConfig(config || schedEmptyConfig());
  const f = form || {};
  const errors = [];
  const kind = schedEntryKindLabel(f.kind);
  const target = String(f.task == null ? '' : f.task).trim();
  const lifecycle = f.lifecycle === 'temp' ? 'temp' : 'periodic';
  if (!target) errors.push(kind === 'queue' ? '请选择要触发的队列（queue_id）' : '请选择任务');
  if (kind === 'queue') {
    if (target && !(cfg.queues || []).some((q) => q.queue_id === target)) {
      errors.push(`队列「${target}」不存在；请先在队列面板新建`);
    }
    if (target) {
      const other = schedQueueEntryConflict(cfg, target, entryId || '');
      if (other) errors.push(`队列「${target}」已有触发条目「${other}」；一个队列最多一个 entry（防双跑）`);
    }
  } else if (target) {
    const queueId = schedFindTaskQueueMember(cfg, target);
    if (queueId) errors.push(`任务「${target}」已是队列「${queueId}」的成员，不能再单独加入调度（防双跑）`);
  }
  let windows = [];
  let quota = null;
  if (lifecycle !== 'temp') {
    const jsonText = String(f.windows_json == null ? '' : f.windows_json).trim();
    if (jsonText) {
      const parsedJson = schedParseWindowsJson(jsonText);
      if (!parsedJson.ok) errors.push(parsedJson.error);
      else windows = parsedJson.windows;
    } else {
      const parsedText = schedParseWindowsText(f.windows_text);
      if (!parsedText.ok) errors.push(parsedText.error);
      else windows = parsedText.windows;
    }
    if (f.quota_per === 'day' || f.quota_per === 'week') {
      const times = Number(f.quota_times);
      if (!Number.isInteger(times) || times < 1 || times > 1000) errors.push('quota 次数必须是 1..1000 的整数');
      else quota = { per: f.quota_per, times };
    } else if (f.quota_per != null && f.quota_per !== '') {
      errors.push('quota 只能是 无 / day / week');
    }
  }
  const retry = Number(f.retry);
  if (!Number.isInteger(retry) || retry < 0 || retry > 10) errors.push('retry 必须是 0..10 的整数');
  const cooldown = Number(f.cooldown);
  if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 604800) {
    errors.push('cooldown_s 必须是 0..604800 的整数');
  }
  const params = schedParseParamsText(f.params_text);
  if (!params.ok) errors.push(params.error);
  const entry = schedBuildEntryFromForm(Object.assign({}, f, {
    entry_id: String(entryId || '').trim(),
    windows,
    quota_per: quota ? quota.per : '',
    quota_times: quota ? quota.times : '',
    params: params.params,
    retry: Number.isInteger(retry) ? retry : 0,
    cooldown: Number.isInteger(cooldown) ? cooldown : 0,
  }), entryId ? (baseEntry || {}) : Object.assign({}, baseEntry || {}, { entry_id: '' }), cfg);
  if (entry.entry_id.length > 128) errors.push('entry_id 超过 128 字符');
  return { ok: errors.length === 0, errors, entry };
}

function schedUpsertEntry(config, entry) {
  const cfg = schedNormalizeConfig(config);
  const idx = cfg.entries.findIndex((e) => e.entry_id === entry.entry_id);
  if (idx >= 0) cfg.entries[idx] = Object.assign({}, entry);
  else cfg.entries.push(Object.assign({}, entry));
  return cfg;
}

function schedRemoveEntryById(config, entryId) {
  const cfg = schedNormalizeConfig(config);
  cfg.entries = cfg.entries.filter((e) => e.entry_id !== entryId);
  return cfg;
}

function schedMoveEntry(config, index, delta) {
  const cfg = schedNormalizeConfig(config);
  const from = Number(index);
  const to = from + Number(delta);
  if (!Number.isInteger(from) || from < 0 || from >= cfg.entries.length) return cfg;
  if (!Number.isInteger(to) || to < 0 || to >= cfg.entries.length || to === from) return cfg;
  const moved = cfg.entries.splice(from, 1)[0];
  cfg.entries.splice(to, 0, moved);
  return cfg;
}

function schedQueueToForm(queue) {
  const q = queue || {};
  return {
    queue_id: String(q.queue_id || ''),
    name: String(q.name || ''),
    members: Array.isArray(q.members) ? q.members.slice() : [],
    total_rounds: q.total_rounds == null ? '0' : String(q.total_rounds),
    on_failure: q.on_failure === 'fail_fast' ? 'fail_fast' : 'continue',
    between_ms: q.between_ms == null ? '500' : String(q.between_ms),
  };
}

function schedQueueMemberAdd(members, task) {
  const out = (Array.isArray(members) ? members : []).slice();
  const t = String(task == null ? '' : task).trim();
  if (t && !out.includes(t)) out.push(t);
  return out;
}

function schedQueueMemberRemove(members, task) {
  return (Array.isArray(members) ? members : []).filter((m) => m !== task);
}

function schedQueueMemberMove(members, index, delta) {
  const out = (Array.isArray(members) ? members : []).slice();
  const from = Number(index);
  const to = from + Number(delta);
  if (!Number.isInteger(from) || from < 0 || from >= out.length) return out;
  if (!Number.isInteger(to) || to < 0 || to >= out.length || to === from) return out;
  const moved = out.splice(from, 1)[0];
  out.splice(to, 0, moved);
  return out;
}

function schedBuildQueueFromForm(form, base) {
  const f = form || {};
  const b = base || {};
  const roundsRaw = Number(String(f.total_rounds == null ? '' : f.total_rounds).trim() || 0);
  const betweenRaw = Number(String(f.between_ms == null ? '' : f.between_ms).trim() || 0);
  return {
    queue_id: String(f.queue_id == null ? (b.queue_id || '') : f.queue_id).trim(),
    name: String(f.name == null ? (b.name || '') : f.name).trim(),
    members: (Array.isArray(f.members) ? f.members : (b.members || [])).map((m) => String(m).trim()).filter(Boolean),
    total_rounds: Number.isFinite(roundsRaw) ? Math.max(0, Math.min(1000000, Math.floor(roundsRaw))) : 0,
    on_failure: f.on_failure === 'fail_fast' ? 'fail_fast' : 'continue',
    between_ms: Number.isFinite(betweenRaw) ? Math.max(0, Math.min(600000, Math.floor(betweenRaw))) : 0,
  };
}

function schedValidateQueueForm(form, config, selfId, baseQueue) {
  const cfg = schedNormalizeConfig(config || schedEmptyConfig());
  const f = form || {};
  const errors = [];
  const queueId = String(f.queue_id == null ? '' : f.queue_id).trim();
  if (!queueId) errors.push('queue_id 不能为空');
  if (queueId.length > 120) errors.push('queue_id 最长 120 字符');
  if (queueId === '.' || queueId === '..') errors.push('queue_id 不能是 . 或 ..');
  if (schedHasUnsafeNameChar(queueId)) errors.push('queue_id 不能包含路径/控制字符');
  if (queueId.endsWith('.')) errors.push('queue_id 不能以 . 结尾');
  if (selfId && queueId !== String(selfId)) errors.push('queue_id 不可修改；如需改 id 请删除该队列后重建');
  if (queueId && (cfg.queues || []).some((q) => q.queue_id === queueId && q.queue_id !== selfId)) {
    errors.push(`queue_id「${queueId}」已存在`);
  }
  const members = (Array.isArray(f.members) ? f.members : []).map((m) => String(m).trim()).filter(Boolean);
  if (!members.length) errors.push('至少选择一个成员任务');
  if (members.length > 200) errors.push('成员最多 200 个');
  const seen = new Set();
  for (const m of members) {
    if (seen.has(m)) errors.push(`成员「${m}」重复`);
    seen.add(m);
    if (m.length > 120) errors.push(`成员「${m}」超过 120 字符`);
    if (schedHasUnsafeNameChar(m)) errors.push(`成员「${m}」包含路径/控制字符`);
    const hit = (cfg.entries || []).find((e) => schedEntryKindLabel(e.kind) === 'task' && e.task === m);
    if (hit) {
      errors.push(`成员「${m}」已是任务条目「${hit.entry_id}」的目标；同一任务不能同时在任务条目和队列成员中（防双跑）`);
    }
  }
  const roundsRaw = Number(String(f.total_rounds == null ? '' : f.total_rounds).trim() || 0);
  if (!Number.isInteger(roundsRaw) || roundsRaw < 0 || roundsRaw > 1000000) {
    errors.push('total_rounds 必须是 0..1000000 的整数（0=无限）');
  }
  const betweenRaw = Number(String(f.between_ms == null ? '' : f.between_ms).trim() || 0);
  if (!Number.isInteger(betweenRaw) || betweenRaw < 0 || betweenRaw > 600000) {
    errors.push('between_ms 必须是 0..600000 的整数');
  }
  const queue = schedBuildQueueFromForm(f, baseQueue || {});
  return { ok: errors.length === 0, errors, queue };
}

function schedUpsertQueue(config, queue) {
  const cfg = schedNormalizeConfig(config);
  const idx = cfg.queues.findIndex((q) => q.queue_id === queue.queue_id);
  if (idx >= 0) cfg.queues[idx] = Object.assign({}, queue);
  else cfg.queues.push(Object.assign({}, queue));
  return cfg;
}

// 删除队列时同时删除所有指向它的队列条目（否则
// 剩余条目会引用未知队列而校验失败）。
function schedRemoveQueue(config, queueId) {
  const cfg = schedNormalizeConfig(config);
  const removed = cfg.entries
    .filter((e) => schedEntryKindLabel(e.kind) === 'queue' && e.task === queueId)
    .map((e) => String(e.entry_id || ''));
  cfg.entries = cfg.entries.filter(
    (e) => !(schedEntryKindLabel(e.kind) === 'queue' && e.task === queueId)
  );
  cfg.queues = cfg.queues.filter((q) => q.queue_id !== queueId);
  return { config: cfg, removed_entry_ids: removed };
}

function schedQueueProgressText(queue, progress) {
  const q = queue || {};
  const p = progress || {};
  const total = Number(q.total_rounds) || 0;
  const done = Number(p.rounds_completed) || 0;
  const parts = [total === 0 ? `轮次 ${done}/无限` : `轮次 ${done}/${total}`];
  const empty = Number(p.empty_rounds) || 0;
  if (empty) parts.push(`空轮 ${empty}`);
  if (p.finished || (total > 0 && done >= total)) parts.push('已完成');
  else if (p.current_round) {
    const idx = Number(p.current_round.index) || 0;
    const mem = Number(p.current_round.member_index) || 0;
    parts.push(`进行中：第 ${idx} 轮 · 成员 ${mem + 1}`);
  }
  return parts.join(' · ');
}

function schedQueueSummary(queue, progress) {
  const q = queue || {};
  const members = Array.isArray(q.members) ? q.members : [];
  return [
    `成员 ${members.length}：${members.join(' → ') || '—'}`,
    schedQueueProgressText(q, progress),
    `失败策略 ${q.on_failure === 'fail_fast' ? 'fail_fast（本轮中止）' : 'continue'}`,
    `成员间隔 ${q.between_ms == null ? '?' : q.between_ms}ms`,
  ].join(' · ');
}

function schedEntrySummary(entry, statusEntry) {
  const e = entry || {};
  const st = statusEntry || {};
  const parts = [];
  parts.push(e.enabled === false ? '已禁用' : '已启用');
  parts.push(e.lifecycle === 'temp' ? 'temp（每 pass 一次）' : 'periodic');
  if (e.lifecycle !== 'temp') {
    parts.push('窗口 ' + schedWindowsToText(e.windows));
    parts.push(e.quota && e.quota.per ? `quota ${e.quota.per === 'week' ? '周' : '日'} ${e.quota.times}` : '无配额');
  }
  parts.push(`retry ${e.retry == null ? '?' : e.retry}`);
  parts.push(`冷却 ${e.cooldown == null ? '?' : e.cooldown}s`);
  if (e.params && Object.keys(e.params).length) parts.push('params ' + JSON.stringify(e.params));
  if (st.last_result) parts.push(`上次 ${st.last_result}${st.last_outcome ? '(' + st.last_outcome + ')' : ''}`);
  if (st.blocked_reason) parts.push(`等待 ${st.blocked_reason}`);
  return parts.join(' · ');
}

function schedQuotaSummary(status) {
  const entries = (status && status.entries) || [];
  const limited = entries.filter((e) => e.quota && e.quota.per);
  if (!limited.length) return 'quota：无限制';
  const used = limited.reduce((n, e) => n + (Number(e.quota.used) || 0), 0);
  const times = limited.reduce((n, e) => n + (Number(e.quota.times) || 0), 0);
  return `quota：${limited.length} 条限制 · 本周期已用 ${used}/${times}`;
}

// P1-3：/scheduler/status 失败需要稳定可测的语句。状态
// 卡在未知状态下所有值显示 `—`，绝不显示正常值。
function schedStatusErrorText(err) {
  const detail = String(err == null ? '' : err).trim();
  return '调度器状态读取失败：' + (detail || '未知错误');
}

// P1-4：规范化 JSON（对象键排序、数组顺序保留），使比较
// 已加载快照与最新 GET 时不受键顺序影响，但对
// 任何值变化敏感。
function schedCanonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(schedCanonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) =>
    JSON.stringify(k) + ':' + schedCanonicalJson(value[k])).join(',') + '}';
}

// 原始 GET /scheduler/config 文档快照（文件不存在时为 `''`；
// loadScheduleConfig 将其存为 `scheduleConfigBase`）。
function schedConfigSnapshotText(config) {
  if (config == null) return '';
  return schedCanonicalJson(config);
}

function schedConfigSnapshotChanged(base, fresh) {
  return String(base == null ? '' : base) !== String(fresh == null ? '' : fresh);
}

function schedExternalConfigChangeText() {
  return '配置已被外部修改，请先【重新加载】';
}

  function schedResponseErrorText(status, body) {
    const errors = body && Array.isArray(body.errors) ? body.errors.filter(Boolean).map(String) : [];
    const detail = errors.length ? errors.join('；') : '';
    if (status === 409) {
      return '调度器运行中：请先点「停止调度」（或外部运行 stop-scheduler.bat）再保存。' +
        (detail ? ' 服务端：' + detail : '');
    }
    if (status === 400) return '配置校验失败：' + (detail || '服务端返回 400');
    if (status === 500) return '写入失败（500）：' + (detail || '未知错误');
    if (status === 404) return '服务端未提供 /scheduler/config（需要 P3A 后端）：' + (detail || 'HTTP 404');
    if (!status) return '网络错误：' + (detail || '请求未送达');
    return '保存失败（HTTP ' + status + '）：' + (detail || '未知错误');
  }

  function schedSaveBlockedReason(running) {
    return running
      ? '调度器运行中：保存会返回 409，请先点「停止调度」（或外部运行 stop-scheduler.bat）再保存。'
      : '';
  }

function schedParseConfigJson(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: false, config: null, error: 'JSON 为空' };
  let v;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return { ok: false, config: null, error: 'JSON 解析失败：' + (e && e.message ? e.message : e) };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, config: null, error: '配置必须是 JSON 对象' };
  }
  if (v.entries != null && !Array.isArray(v.entries)) {
    return { ok: false, config: null, error: 'entries 必须是数组' };
  }
  if (v.queues != null && !Array.isArray(v.queues)) {
    return { ok: false, config: null, error: 'queues 必须是数组' };
  }
  return { ok: true, config: schedNormalizeConfig(v), error: '' };
}

// --- P4: 调度运行记录（/runs/scheduler）纯函数 -------------------------------
// 契约（P4A）：GET /runs/scheduler?limit=200&task=&outcome= 返回
// {ok, dir, count, runs:[{run_id,file,task,kind,entry_id,queue_id,round,
// member_index,attempt,started_ms,finished_ms,duration_ms,class,outcome,exit,
// exit_code,clicks,error}]} 新→旧；GET /runs/scheduler/run?run_id=
// 返回单次完整运行。旧 GET /runs（clicks JSONL）不变。
// 保持每个 helper 自包含：ui_pure_test 会逐个提取函数。
function schedRunValueText(value) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value);
    return text == null ? '—' : text;
  } catch (e) {
    return String(value);
  }
}

function schedRunLimitValue(value) {
  const allowed = [100, 200, 500, 1000];
  const n = Number(value);
  return allowed.indexOf(n) >= 0 ? n : 200;
}

function schedRunsBuildQuery(opts) {
  // P4A 按持久化 `outcome` 过滤（Done/Failed/Exhausted/error）。
  // 计划的 class 词（success/resource/blocked/retryable/fatal）位于
  // 独立 `class` 字段，列表接口无法过滤；这些
  // 由 schedRunsFilterLocal 本地应用，使两种写法都生效。
  const classOutcomes = ['success', 'resource', 'blocked', 'retryable', 'fatal'];
  const persistedOutcomes = ['Done', 'Failed', 'Exhausted', 'error'];
  const o = opts || {};
  const parts = ['limit=' + schedRunLimitValue(o.limit)];
  const task = String(o.task == null ? '' : o.task).trim();
  if (task) parts.push('task=' + encodeURIComponent(task));
  const rawOutcome = String(o.outcome == null ? '' : o.outcome).trim();
  if (rawOutcome) {
    const isClassWord = classOutcomes.some((v) => v.toLowerCase() === rawOutcome.toLowerCase());
    if (!isClassWord) {
      const canonical = persistedOutcomes.find((v) => v.toLowerCase() === rawOutcome.toLowerCase()) || '';
      if (canonical) parts.push('outcome=' + encodeURIComponent(canonical));
    }
  }
  return parts.join('&');
}

function schedRunsBuildUrl(opts) {
  return '/runs/scheduler?' + schedRunsBuildQuery(opts);
}

function schedRunDetailUrl(runId) {
  return '/runs/scheduler/run?run_id=' + encodeURIComponent(String(runId == null ? '' : runId).trim());
}

function schedRunTimeText(ms) {
  if (ms === undefined || ms === null || ms === '') return '—';
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return '—';
  try {
    return new Date(n).toLocaleString('zh-CN', { hour12: false });
  } catch (e) {
    return String(ms);
  }
}

function schedRunDurationMs(run) {
  const r = run || {};
  const direct = Number(r.duration_ms);
  if (r.duration_ms !== undefined && r.duration_ms !== null && r.duration_ms !== '' &&
      isFinite(direct) && direct >= 0) {
    return direct;
  }
  const start = Number(r.started_ms);
  const end = Number(r.finished_ms);
  if (r.started_ms !== undefined && r.started_ms !== null && r.started_ms !== '' &&
      r.finished_ms !== undefined && r.finished_ms !== null && r.finished_ms !== '' &&
      isFinite(start) && isFinite(end) && end >= start) {
    return end - start;
  }
  return null;
}

function schedRunDurationText(ms) {
  if (ms === undefined || ms === null || ms === '') return '—';
  const n = Number(ms);
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1000) return Math.round(n) + 'ms';
  if (n < 60000) return (n / 1000).toFixed(1) + 's';
  const total = Math.round(n / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return h + 'h' + m + 'm';
  return m + 'm' + s + 's';
}

function schedRunOutcomeLabel(outcome) {
  const raw = String(outcome == null ? '' : outcome).trim();
  const key = raw.toLowerCase();
  const labels = {
    success: '成功',
    done: '完成',
    resource: '资源不足',
    blocked: '被阻断',
    retryable: '可重试',
    fatal: '致命',
    failed: '失败',
    exhausted: '耗尽',
    error: '错误',
  };
  return labels[key] || raw || '未知';
}

function schedRunOutcomeBadgeClass(outcome) {
  const key = String(outcome == null ? '' : outcome).trim().toLowerCase();
  if (key === 'success' || key === 'done') return 'ok';
  if (key === 'fatal' || key === 'failed' || key === 'error') return 'err';
  if (key === 'resource' || key === 'blocked' || key === 'retryable' || key === 'exhausted') return 'warn';
  return 'kind';
}

// 优先按失败类别着色（success/resource/blocked/retryable/fatal），
// 旧文件再按持久化 outcome（Done/Failed/Exhausted/error）着色。
function schedRunStatusBadgeClass(run) {
  const r = run || {};
  const byClass = schedRunOutcomeBadgeClass(r.class);
  if (byClass !== 'kind') return byClass;
  return schedRunOutcomeBadgeClass(r.outcome);
}

function schedRunKindText(kind) {
  const key = String(kind == null ? '' : kind).trim().toLowerCase();
  if (key === 'queue_member') return 'queue_member';
  return key === 'queue' ? 'queue' : 'task';
}

function schedRunIsQueueRun(run) {
  const kind = schedRunKindText((run || {}).kind);
  return kind === 'queue' || kind === 'queue_member';
}

function schedQueueDisplayName(cfg, queueId) {
  const id = String(queueId == null ? '' : queueId).trim();
  if (!id) return '';
  for (const q of (cfg && cfg.queues) || []) {
    if (!q || String(q.queue_id == null ? '' : q.queue_id) !== id) continue;
    const name = String(q.name == null ? '' : q.name).trim();
    return name && name !== id ? name : id;
  }
  return id;
}

function schedRunTaskLabel(run, cfg) {
  const r = run || {};
  const task = String(r.task == null ? '' : r.task).trim() || '—';
  if (!schedRunIsQueueRun(r)) return task;
  const queueId = String(r.queue_id == null ? '' : r.queue_id).trim();
  const queueName = schedQueueDisplayName(cfg, queueId) || queueId;
  return queueName ? queueName + '/' + task : task;
}

function schedRunRoundMemberText(run) {
  const r = run || {};
  if (!schedRunIsQueueRun(r)) return '—';
  const bits = [];
  if (r.round !== undefined && r.round !== null && r.round !== '') bits.push('第' + r.round + '轮');
  const mi = Number(r.member_index);
  if (r.member_index !== undefined && r.member_index !== null && r.member_index !== '' &&
      isFinite(mi) && mi >= 0) {
    bits.push('成员' + (Math.floor(mi) + 1));
  }
  return bits.length ? bits.join(' · ') : '—';
}

function schedRunAttemptText(run) {
  const r = run || {};
  const n = Number(r.attempt);
  if (r.attempt === undefined || r.attempt === null || r.attempt === '' || !isFinite(n) || n <= 0) {
    return '—';
  }
  return String(Math.floor(n));
}

function schedRunExitText(run) {
  const r = run || {};
  if (r.exit_code !== undefined && r.exit_code !== null && r.exit_code !== '') {
    return schedRunValueText(r.exit_code);
  }
  if (r.exit !== undefined && r.exit !== null && r.exit !== '') return schedRunValueText(r.exit);
  return '—';
}

function schedRunClicksText(run) {
  const r = run || {};
  const c = r.clicks;
  if (c === undefined || c === null || c === '') return '—';
  if (typeof c === 'number' || typeof c === 'string') return String(c);
  return schedRunValueText(c);
}

function schedRunErrorText(error) {
  if (error === undefined || error === null) return '';
  if (typeof error === 'string') return error.trim();
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  try {
    const text = JSON.stringify(error);
    return text == null ? '' : text;
  } catch (e) {
    return String(error);
  }
}

function schedRunErrorSummary(error, maxLen) {
  const text = schedRunErrorText(error).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const limit = Number(maxLen) > 0 ? Math.floor(Number(maxLen)) : 80;
  return text.length > limit ? text.slice(0, Math.max(0, limit - 1)) + '…' : text;
}

function schedRunResumeText(run) {
  const r = run || {};
  if (r.resume === true) return '是';
  if (r.resume === false) return '否';
  return '—';
}

function schedRunDetailRows(run) {
  const r = run || {};
  const rows = [];
  const known = {};
  const add = (key, value) => {
    known[key] = true;
    rows.push([key, value]);
  };
  add('run_id', schedRunValueText(r.run_id));
  add('file', schedRunValueText(r.file));
  add('schema_version', schedRunValueText(r.schema_version));
  add('source', schedRunValueText(r.source));
  add('task', schedRunValueText(r.task));
  add('kind', schedRunKindText(r.kind));
  add('entry_id', schedRunValueText(r.entry_id));
  add('queue_id', schedRunValueText(r.queue_id));
  add('round', schedRunValueText(r.round));
  add('member_index', schedRunValueText(r.member_index));
  add('attempt', schedRunAttemptText(r));
  add('class', schedRunValueText(r.class));
  const rawOutcome = schedRunValueText(r.outcome);
  add('outcome', rawOutcome === '—'
    ? schedRunOutcomeLabel(r.outcome)
    : schedRunOutcomeLabel(r.outcome) + '（' + rawOutcome + '）');
  add('exit', schedRunExitText(r));
  add('exit_code', schedRunValueText(r.exit_code));
  add('clicks', schedRunClicksText(r));
  const durationMs = schedRunDurationMs(r);
  add('duration_ms', durationMs == null
    ? '—'
    : schedRunValueText(durationMs) + '（' + schedRunDurationText(durationMs) + '）');
  add('started_ms', r.started_ms === undefined || r.started_ms === null || r.started_ms === ''
    ? '—'
    : schedRunValueText(r.started_ms) + '（' + schedRunTimeText(r.started_ms) + '）');
  add('finished_ms', r.finished_ms === undefined || r.finished_ms === null || r.finished_ms === ''
    ? '—'
    : schedRunValueText(r.finished_ms) + '（' + schedRunTimeText(r.finished_ms) + '）');
  add('resume', schedRunResumeText(r));
  add('clicks_file', schedRunValueText(r.clicks_file));
  add('error', schedRunErrorText(r.error) || '—');
  // "全字段"：unknown/future keys are appended (sorted) instead of being hidden.
  for (const key of Object.keys(r).sort()) {
    if (!known[key]) rows.push([key, schedRunValueText(r[key])]);
  }
  return rows;
}

function schedRunDetailTitle(run, cfg) {
  const r = run || {};
  return '运行详情 · ' + schedRunTaskLabel(r, cfg) + ' · ' +
    schedRunOutcomeLabel(r.outcome) + ' · ' + schedRunTimeText(r.started_ms);
}

function schedRunRowCells(run, cfg) {
  const r = run || {};
  return {
    time: schedRunTimeText(r.started_ms),
    task: schedRunTaskLabel(r, cfg),
    kind: schedRunKindText(r.kind),
    round_member: schedRunRoundMemberText(r),
    attempt: schedRunAttemptText(r),
    class: schedRunValueText(r.class),
    outcome: schedRunOutcomeLabel(r.outcome),
    outcome_class: schedRunStatusBadgeClass(r),
    exit: schedRunExitText(r),
    duration: schedRunDurationText(schedRunDurationMs(r)),
    clicks: schedRunClicksText(r),
    error: schedRunErrorSummary(r.error, 80),
    error_full: schedRunErrorText(r.error),
  };
}

function schedRunIsFailure(run) {
  const r = run || {};
  const cls = String(r.class == null ? '' : r.class).trim().toLowerCase();
  if (cls) return cls !== 'success';
  const outcome = String(r.outcome == null ? '' : r.outcome).trim().toLowerCase();
  return !!outcome && outcome !== 'done' && outcome !== 'success';
}

function schedRunsFailureCount(runs) {
  let n = 0;
  for (const r of (Array.isArray(runs) ? runs : [])) {
    if (schedRunIsFailure(r)) n += 1;
  }
  return n;
}

function schedRunsStatusCardText(data, error) {
  if (error) return '运行记录：读取失败（见下方运行记录区）';
  if (!data) return '运行记录：—';
  const runs = Array.isArray(data.runs) ? data.runs : [];
  if (!runs.length) return '运行记录：暂无';
  const last = runs[0] || {};
  return '运行记录：最近 ' + schedRunOutcomeLabel(last.outcome) + ' · ' +
    (String(last.task == null ? '' : last.task).trim() || '?') + ' · ' +
    schedRunTimeText(last.started_ms) + ' · 失败 ' +
    schedRunsFailureCount(runs) + '/' + runs.length;
}

function schedRunBodyErrors(body) {
  if (!body || typeof body !== 'object') return '';
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.filter((e) => e !== null && e !== undefined && e !== '').map((e) => String(e)).join('；');
  }
  if (body.error !== undefined && body.error !== null && body.error !== '') return String(body.error);
  if (body.message !== undefined && body.message !== null && body.message !== '') return String(body.message);
  return '';
}

function schedRunsErrorText(reason) {
  const text = String(reason == null ? '' : reason).trim();
  return '运行记录读取失败：' + (text || '未知错误');
}

function schedRunsResponseErrorText(status, body) {
  const detail = schedRunBodyErrors(body);
  const suffix = detail ? '：' + detail : '';
  if (!status) return '运行记录读取失败：网络错误' + suffix;
  if (status === 404) return '运行记录读取失败：服务端未提供 /runs/scheduler（需要 P4A 后端）' + suffix;
  return '运行记录读取失败：HTTP ' + status + suffix;
}

function schedRunDetailErrorText(status, body) {
  const detail = schedRunBodyErrors(body);
  const suffix = detail ? '：' + detail : '';
  if (!status) return '详情读取失败：网络错误' + suffix;
  if (status === 400) return '详情读取失败：run_id 无效（HTTP 400）' + suffix;
  if (status === 404) return '详情读取失败：运行记录不存在或已被删除（HTTP 404）' + suffix;
  return '详情读取失败：HTTP ' + status + suffix;
}

function schedRunsTaskChoices(status, cfg) {
  const seen = {};
  const out = [];
  const add = (value) => {
    const text = String(value == null ? '' : value).trim();
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  };
  for (const c of (status && status.task_choices) || []) add(c);
  for (const e of (status && status.entries) || []) {
    if (!e || String(e.kind || '') === 'queue') continue;
    add(e.task);
  }
  for (const e of (cfg && cfg.entries) || []) {
    if (!e || String(e.kind || '') === 'queue') continue;
    add(e.task);
  }
  for (const q of (cfg && cfg.queues) || []) {
    for (const m of (q && q.members) || []) add(m);
  }
  return out;
}

function schedRunsFilterLocal(runs, opts) {
  const o = opts || {};
  const task = String(o.task == null ? '' : o.task).trim();
  const outcome = String(o.outcome == null ? '' : o.outcome).trim().toLowerCase();
  const queueId = String(o.queueId == null ? '' : o.queueId).trim();
  return (Array.isArray(runs) ? runs : []).filter((run) => {
    if (!run) return false;
    if (task && String(run.task == null ? '' : run.task) !== task) return false;
    if (outcome) {
      // 匹配持久化 outcome（Done/Failed/...）或结果类别
      // （success/resource/...）；两者位于独立 run 字段。
      const runOutcome = String(run.outcome == null ? '' : run.outcome).trim().toLowerCase();
      const runClass = String(run.class == null ? '' : run.class).trim().toLowerCase();
      if (runOutcome !== outcome && runClass !== outcome) return false;
    }
    if (queueId && String(run.queue_id == null ? '' : run.queue_id) !== queueId) return false;
    return true;
  });
}

function schedRunsFilterActive(filter) {
  const f = filter || {};
  return !!String(f.task == null ? '' : f.task).trim() ||
    !!String(f.outcome == null ? '' : f.outcome).trim() ||
    !!String(f.queueId == null ? '' : f.queueId).trim();
}

function schedRunsListStatusText(opts) {
  const o = opts || {};
  if (o.error) return String(o.error);
  const data = o.data || null;
  const filter = o.filter || {};
  if (!data) return '运行记录：—';
  const rows = Array.isArray(o.rows) ? o.rows : null;
  const total = Number.isFinite(Number(data.count))
    ? Number(data.count)
    : (Array.isArray(data.runs) ? data.runs.length : 0);
  const parts = ['共 ' + total + ' 条'];
  if (filter.task) parts.push('任务=' + String(filter.task));
  if (filter.outcome) {
    const classWords = ['success', 'resource', 'blocked', 'retryable', 'fatal'];
    const isClassWord = classWords.indexOf(String(filter.outcome).trim().toLowerCase()) >= 0;
    parts.push('结果=' + schedRunOutcomeLabel(filter.outcome) + (isClassWord ? '（本地筛选）' : ''));
  }
  if (filter.queueId) parts.push('队列=' + String(filter.queueId) + '（本地筛选）');
  if (rows && rows.length !== total && schedRunsFilterActive(filter)) {
    parts.push('显示 ' + rows.length + ' 条');
  }
  return '运行记录：' + parts.join(' · ');
}

  // --- 调度页 DOM / 保存 / 运行记录 / 重置记忆 --------------------------------
// --- P3: 调度页/对话框（DOM 层） --------------------------------------------
function setScheduleBusy(busy) {
  scheduleBusy = !!busy;
  for (const el of [pageSchedSave, pageSchedReload, pageSchedAddEntry, pageSchedAddQueue,
    pageSchedJsonSave, pageSchedJsonReload, pageSchedRunsRefresh]) {
    if (el) el.disabled = !!busy;
  }
}

  function scheduleLocked() {
    if (state.health && state.health.lock && state.health.lock.held === true) return true;
    if (state.runnerScheduler && state.runnerScheduler.running === true) return true;
    if (scheduleConfigMeta && scheduleConfigMeta.running) return true;
    if (schedulerStatus && schedulerStatus.running) return true;
    return false;
  }

// 一次原始 GET /scheduler/config。绝不修改页面状态：页面加载与
// P1-4 保存前检查分别决定如何呈现失败。
  async function fetchScheduleConfigOnce() {
    try {
      const body = await runnerFetchJson(RUNNER_API.schedulerConfig);
      return { ok: true, status: 200, body: body, error: '' };
    } catch (e) {
      const status = e && e.status ? Number(e.status) : 0;
      const errors = [];
      if (e && Array.isArray(e.details) && e.details.length) {
        for (const detail of e.details) errors.push(String(detail));
      } else {
        errors.push(runnerErrorText(e));
      }
      let error = errors.join('；');
      if (status === 404) error = '服务端未提供 /scheduler/config（需要 P3A 后端）';
      else if (!status) error = '网络错误：' + runnerErrorText(e);
      return { ok: false, status: status, body: { errors: errors }, error: error };
    }
  }

async function loadScheduleConfig(force) {
  if (scheduleConfig && !force) return scheduleConfig;
  const res = await fetchScheduleConfigOnce();
  if (!res.ok) {
    scheduleConfig = null;
    scheduleConfigMeta = null;
    scheduleConfigBase = '';
    scheduleConfigError = res.error;
    schedLog('读取调度配置失败：' + scheduleConfigError, 'ERROR');
    return null;
  }
  scheduleConfigError = '';
  scheduleConfigMeta = res.body;
  scheduleConfig = schedNormalizeConfig(res.body.config);
  // P1-4：记录本页面状态所基于的快照，后续保存可拒绝
  // 覆盖期间已变化的文件。
  scheduleConfigBase = schedConfigSnapshotText(res.body.config);
  if (!res.body.config) {
    schedLog('调度配置文件不存在（' + (res.body.path || 'scheduler.json') + '）；保存后会创建', 'WARN');
  }
  return scheduleConfig;
}

  async function ensureScheduleTaskChoices(force) {
    if (!force && scheduleTasksCache.length) return scheduleTasksCache;
    try {
      const body = await runnerFetchJson(RUNNER_API.tasks);
      const tasks = Array.isArray(body.tasks) ? body.tasks : [];
      scheduleTasksCache = tasks
        .map(function (t) { return String((t && t.task) || '').trim(); })
        .filter(Boolean);
    } catch (e) {
      schedLog('读取任务列表失败：' + runnerErrorText(e), 'WARN');
    }
    return scheduleTasksCache;
  }

  async function postScheduleConfig(cfg) {
    try {
      const body = await runnerFetchJson(RUNNER_API.schedulerConfig, {
        method: 'POST',
        body: { config: cfg },
      });
      return { ok: true, status: 200, body: body };
    } catch (e) {
      const status = e && e.status ? Number(e.status) : 0;
      const errors = (e && Array.isArray(e.details) && e.details.length)
        ? e.details.map(String)
        : [runnerErrorText(e)];
      return { ok: false, status: status, body: { errors: errors }, network: !status };
    }
  }

  // 400/409 响应体带 `errors[]`；展示摘要与全部服务端行，
  // 使字段级校验失败可读（P3 契约：错误逐行）。
  function schedConfigSaveErrorText(res) {
    const result = res || {};
    const base = schedResponseErrorText(result.status, result.body);
    const details = result.body && Array.isArray(result.body.errors)
      ? result.body.errors.filter(Boolean).map(String)
      : [];
    if (details.length <= 1) return base;
    return base + '\n' + details.map(function (line) { return '· ' + line; }).join('\n');
  }

function scheduleStatusEntryMap(status) {
  const map = {};
  for (const e of (status && status.entries) || []) map[e.entry_id] = e;
  return map;
}

  function renderScheduleStatusCard(s) {
    const status = s || {};
    const meta = scheduleConfigMeta || {};
    const statusError = String(scheduleStatusError || '');
    const known = !statusError;
    if (pageSchedMode) pageSchedMode.textContent = '模式：' + (known ? (status.mode || '—') : '—');
    if (pageSchedPasses) pageSchedPasses.textContent = 'passes=' + (known ? (status.passes != null ? status.passes : 0) : '—');
    if (pageSchedNextWake) {
      pageSchedNextWake.textContent = '下次唤醒=' + (known ? (status.next_wake_local || fmtLocal(status.next_wake_ms)) : '—');
    }
    if (pageSchedQuota) pageSchedQuota.textContent = known ? schedQuotaSummary(status) : 'quota：—';
    if (pageSchedRunning) {
      if (!known) {
        pageSchedRunning.textContent = '锁=—';
        pageSchedRunning.className = 'runner-badge';
      } else {
        const lock = scheduleLocked() ? '锁=调度器运行中' : '锁=空闲';
        const run = status.running
          ? ' · 正在执行 ' + (status.running.entry_id || '?') + '/' + (status.running.task || '?')
          : '';
        pageSchedRunning.textContent = lock + run;
        pageSchedRunning.className = 'runner-badge ' + (scheduleLocked() ? 'warn' : 'ok');
      }
    }
    const parts = [];
    if (!known) {
      parts.push(schedStatusErrorText(statusError));
    } else {
      const guards = status.guards || {};
      if (guards.blocked) {
        parts.push('护栏=已阻断' + (guards.blackout_reason ? '（' + guards.blackout_reason + '）' : ''));
      }
      if (status.last_stop) {
        parts.push('上次停止=' + (typeof status.last_stop === 'string' ? status.last_stop : JSON.stringify(status.last_stop)));
      }
    }
    if (scheduleConfigError) parts.push('配置读取失败：' + scheduleConfigError);
    if (pageSchedSummary) pageSchedSummary.textContent = parts.join(' · ') || '调度器状态正常';
    if (pageSchedConfigStatus) {
      const bits = [];
      if (meta.path) bits.push('路径=' + meta.path);
      if (meta.exists === false) bits.push('文件不存在（首次保存会创建）');
      if (meta.state_path) bits.push('state=' + meta.state_path);
      if (meta.schema_version) bits.push('schema=' + meta.schema_version);
      if (scheduleLocked()) bits.push('运行中：保存会被 409 拒绝，请先点「停止调度」（或外部 stop-scheduler.bat）');
      if (scheduleConfigError) bits.push('错误=' + scheduleConfigError);
      pageSchedConfigStatus.textContent = bits.join(' · ') || '配置：—';
    }
    if (pageSchedRunsSummary) {
      pageSchedRunsSummary.textContent = schedRunsStatusCardText(scheduleRunsData, scheduleRunsError);
    }
  }

  function fillScheduleEntryBadges(host, entry, statusEntry, queueProgress) {
    if (!host) return;
    host.textContent = '';
    const e = entry || {};
    const st = statusEntry || {};
    const isQueue = schedEntryKindLabel(e.kind) === 'queue';
    host.appendChild(schedBadge(isQueue ? 'queue' : 'task', 'kind'));
    host.appendChild(schedBadge(e.lifecycle || 'periodic', 'kind'));
    if (e.enabled === false) host.appendChild(schedBadge('已禁用', 'warn'));
    if (st.runnable_now) host.appendChild(schedBadge('现在可跑', 'ok'));
    else if (st.blocked_reason) host.appendChild(schedBadge('等待：' + st.blocked_reason, 'warn'));
    if (st.next_due_local || st.next_due_ms) {
      host.appendChild(schedBadge('下次：' + (st.next_due_local || fmtLocal(st.next_due_ms)), 'kind'));
    }
    if (st.cooldown_until_ms) host.appendChild(schedBadge('冷却至：' + fmtLocal(st.cooldown_until_ms), 'warn'));
    if (isQueue && queueProgress) {
      host.appendChild(schedBadge(schedQueueProgressText(queueProgress, queueProgress), 'kind'));
      if (queueProgress.finished) host.appendChild(schedBadge('队列已完成', 'warn'));
    }
  }

  function renderScheduleEntries(status, cfg) {
    if (!pageSchedEntries) return;
    pageSchedEntries.textContent = '';
    if (!cfg) {
      pageSchedEntries.textContent = '（调度配置不可用：' + (scheduleConfigError || '未知') + '）';
      return;
    }
    const entries = cfg.entries || [];
    if (!entries.length) {
      pageSchedEntries.textContent = '（还没有调度条目；到任务库点「调度设置…」或点「+ 添加条目…」）';
      return;
    }
    const stMap = scheduleStatusEntryMap(status);
    const queueStatus = {};
    for (const q of (status && status.queues) || []) queueStatus[q.queue_id] = q;
    entries.forEach((e, i) => {
      const card = document.createElement('div');
      card.className = 'task-card';
      card.setAttribute('data-entry-id', String(e.entry_id || ''));
      const meta = document.createElement('div');
      meta.className = 'task-meta';
      const title = document.createElement('div');
      title.className = 'task-title';
      const isQueue = schedEntryKindLabel(e.kind) === 'queue';
      title.textContent = `${e.entry_id} · ${isQueue ? '队列' : '任务'} ${e.task}`;
      const sub = document.createElement('div');
      sub.className = 'task-sub';
      sub.textContent = schedEntrySummary(e, stMap[e.entry_id]);
      meta.append(title, sub);

      const badges = document.createElement('div');
      badges.className = 'row';
      badges.setAttribute('data-runtime', 'entry');
      const st = stMap[e.entry_id];
      fillScheduleEntryBadges(badges, e, st, (st && st.queue) || queueStatus[e.task]);
      meta.appendChild(badges);
      card.appendChild(meta);

      const enableLabel = document.createElement('label');
      enableLabel.className = 'opt small';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = e.enabled !== false;
      cb.title = '启用/禁用该调度条目（立即保存）';
      cb.addEventListener('change', () => toggleScheduleEntry(e.entry_id, cb.checked));
      enableLabel.append(cb, document.createTextNode(' 启用'));

      const up = document.createElement('button');
      up.type = 'button';
      up.textContent = '上移';
      up.disabled = i === 0;
      up.addEventListener('click', () => moveScheduleEntry(e.entry_id, -1));
      const down = document.createElement('button');
      down.type = 'button';
      down.textContent = '下移';
      down.disabled = i === entries.length - 1;
      down.addEventListener('click', () => moveScheduleEntry(e.entry_id, 1));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => openScheduleEntryDialog({ mode: 'edit', entryId: e.entry_id, entry: e }));
      const runsBtn = document.createElement('button');
      runsBtn.type = 'button';
      runsBtn.textContent = '运行记录';
      runsBtn.title = isQueue ? '筛选该队列的运行记录' : '筛选该任务的运行记录';
      runsBtn.addEventListener('click', () => showScheduleRunsForEntry(e));
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '删除';
      del.addEventListener('click', () => deleteScheduleEntry(e.entry_id, isQueue));
      card.append(enableLabel, up, down, runsBtn, edit, del);
      pageSchedEntries.appendChild(card);
    });
  }

  function updateScheduleEntryRuntime(status) {
    if (!pageSchedEntries || !status) return;
    const stMap = scheduleStatusEntryMap(status);
    const queueStatus = {};
    for (const q of status.queues || []) queueStatus[q.queue_id] = q;
    const entries = (scheduleConfig && scheduleConfig.entries) || [];
    const cards = pageSchedEntries.querySelectorAll('[data-entry-id]');
    for (const card of cards) {
      const entryId = card.getAttribute('data-entry-id');
      const entry = entries.find((e) => e && e.entry_id === entryId);
      const host = card.querySelector('[data-runtime="entry"]');
      if (!entry || !host) continue;
      const st = stMap[entryId];
      fillScheduleEntryBadges(host, entry, st, (st && st.queue) || queueStatus[entry.task]);
    }
  }

  function fillScheduleQueueBadges(host, queue, progress, cfg) {
    if (!host) return;
    host.textContent = '';
    const q = queue || {};
    const entryId = schedQueueEntryConflict(cfg || schedEmptyConfig(), q.queue_id);
    host.appendChild(entryId
      ? schedBadge('触发条目：' + entryId, 'kind')
      : schedBadge('无触发条目（不会被调度）', 'warn'));
    if (progress && progress.finished) host.appendChild(schedBadge('已完成', 'warn'));
    if (q.total_rounds === 0) host.appendChild(schedBadge('无限轮', 'kind'));
  }

  function renderScheduleQueues(status, cfg) {
    if (!pageSchedQueues) return;
    pageSchedQueues.textContent = '';
    if (!cfg) {
      pageSchedQueues.textContent = '（调度配置不可用：' + (scheduleConfigError || '未知') + '）';
      return;
    }
    const queues = cfg.queues || [];
    if (!queues.length) {
      pageSchedQueues.textContent = '（还没有队列；点「+ 新建队列…」把任务按顺序串起来）';
      return;
    }
    const progress = {};
    for (const q of (status && status.queues) || []) progress[q.queue_id] = q;
    for (const q of queues) {
      const card = document.createElement('div');
      card.className = 'task-card';
      card.setAttribute('data-queue-id', String(q.queue_id || ''));
      const meta = document.createElement('div');
      meta.className = 'task-meta';
      const title = document.createElement('div');
      title.className = 'task-title';
      title.textContent = q.queue_id + (q.name && q.name !== q.queue_id ? ' · ' + q.name : '');
      const sub = document.createElement('div');
      sub.className = 'task-sub';
      sub.textContent = schedQueueSummary(q, progress[q.queue_id]);
      meta.append(title, sub);
      const badges = document.createElement('div');
      badges.className = 'row';
      badges.setAttribute('data-runtime', 'queue');
      fillScheduleQueueBadges(badges, q, progress[q.queue_id], cfg);
      meta.appendChild(badges);
      card.appendChild(meta);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => openScheduleQueueDialog(q.queue_id));
      const runsBtn = document.createElement('button');
      runsBtn.type = 'button';
      runsBtn.textContent = '运行记录';
      runsBtn.title = '筛选该队列成员的运行记录（本地筛选）';
      runsBtn.addEventListener('click', () => showScheduleRunsForQueue(q.queue_id));
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '删除';
      del.addEventListener('click', () => deleteScheduleQueue(q.queue_id));
      card.append(runsBtn, edit, del);
      pageSchedQueues.appendChild(card);
    }
  }

  function updateScheduleQueueRuntime(status) {
    if (!pageSchedQueues || !status) return;
    const progress = {};
    for (const q of status.queues || []) progress[q.queue_id] = q;
    const queues = (scheduleConfig && scheduleConfig.queues) || [];
    const cards = pageSchedQueues.querySelectorAll('[data-queue-id]');
    for (const card of cards) {
      const queueId = card.getAttribute('data-queue-id');
      const queue = queues.find((q) => q && q.queue_id === queueId);
      const host = card.querySelector('[data-runtime="queue"]');
      if (!queue || !host) continue;
      fillScheduleQueueBadges(host, queue, progress[queueId], scheduleConfig);
    }
  }

// --- P4: 调度运行记录（列表 / 筛选 / 详情）DOM 层 ---------------------------
function populateScheduleRunsTaskOptions() {
  if (!pageSchedRunsTask) return;
  const choices = schedRunsTaskChoices(schedulerStatus, scheduleConfig);
  const current = String(scheduleRunsFilter.task || '');
  const values = choices.slice();
  if (current && values.indexOf(current) < 0) values.unshift(current);
  pageSchedRunsTask.textContent = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部任务';
  pageSchedRunsTask.appendChild(all);
  for (const value of values) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    pageSchedRunsTask.appendChild(opt);
  }
  pageSchedRunsTask.value = values.indexOf(current) >= 0 ? current : '';
}

function syncScheduleRunsControls() {
  if (pageSchedRunsTask) {
    const task = String(scheduleRunsFilter.task || '');
    const options = Array.from(pageSchedRunsTask.options || []);
    if (task && !options.some((opt) => opt.value === task)) {
      const opt = document.createElement('option');
      opt.value = task;
      opt.textContent = task;
      pageSchedRunsTask.appendChild(opt);
    }
    pageSchedRunsTask.value = task;
  }
  if (pageSchedRunsOutcome) pageSchedRunsOutcome.value = String(scheduleRunsFilter.outcome || '');
  if (pageSchedRunsLimit) pageSchedRunsLimit.value = String(schedRunLimitValue(scheduleRunsFilter.limit));
  if (pageSchedRunsClear) pageSchedRunsClear.disabled = !schedRunsFilterActive(scheduleRunsFilter);
}

function scrollScheduleRunsIntoView() {
  if (!pageSchedRunsList || typeof pageSchedRunsList.scrollIntoView !== 'function') return;
  try {
    pageSchedRunsList.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (e) {
    /* 忽略：滚动仅为视觉效果 */
  }
}

// 任务库快捷入口：打开调度页并将运行列表过滤到
// 该任务。刷新后过滤仍保留，因为 refreshSchedulePage
// 读取 `scheduleRunsFilter` 而非重置。
  function showScheduleRunsForTask(task) {
    const name = String(task == null ? '' : task).trim();
    scheduleRunsFilter.task = name;
    scheduleRunsFilter.outcome = '';
    scheduleRunsFilter.queueId = '';
    syncScheduleRunsControls();
    if (state.page === 'queue') {
      refreshScheduleRuns();
      scrollScheduleRunsIntoView();
      return;
    }
    showPage('queue');
    refreshCurrentPage().then(function () { scrollScheduleRunsIntoView(); });
  }

// 条目行快捷入口：任务条目按任务服务端过滤；队列条目
// 按 queue_id 本地过滤成员的运行（列表接口没有
// P4A 契约中的队列过滤参数）。
  function showScheduleRunsForEntry(entry) {
    const e = entry || {};
    const isQueue = String(e.kind == null ? '' : e.kind) === 'queue';
    const target = String(e.task == null ? '' : e.task).trim();
    scheduleRunsFilter.task = isQueue ? '' : target;
    scheduleRunsFilter.outcome = '';
    scheduleRunsFilter.queueId = isQueue ? target : '';
    syncScheduleRunsControls();
    if (state.page === 'queue') {
      refreshScheduleRuns();
      scrollScheduleRunsIntoView();
      return;
    }
    showPage('queue');
    refreshCurrentPage().then(function () { scrollScheduleRunsIntoView(); });
  }

  function showScheduleRunsForQueue(queueId) {
    scheduleRunsFilter.task = '';
    scheduleRunsFilter.outcome = '';
    scheduleRunsFilter.queueId = String(queueId == null ? '' : queueId).trim();
    syncScheduleRunsControls();
    if (state.page === 'queue') {
      refreshScheduleRuns();
      scrollScheduleRunsIntoView();
      return;
    }
    showPage('queue');
    refreshCurrentPage().then(function () { scrollScheduleRunsIntoView(); });
  }

  function makeSchedRunBadge(text, cls) {
    const span = document.createElement('span');
    span.className = 'runner-badge ' + (cls || 'kind');
    span.textContent = String(text == null ? '' : text);
    return span;
  }

  function renderScheduleRuns() {
    if (!pageSchedRunsList) return;
    const runs = (scheduleRunsData && Array.isArray(scheduleRunsData.runs)) ? scheduleRunsData.runs : [];
    const rows = schedRunsFilterLocal(runs, scheduleRunsFilter);
    if (pageSchedRunsStatus) {
      pageSchedRunsStatus.textContent = scheduleRunsLoading
        ? '读取中…'
        : schedRunsListStatusText({
          data: scheduleRunsData,
          error: scheduleRunsError,
          filter: scheduleRunsFilter,
          rows: rows,
        });
    }
    pageSchedRunsList.textContent = '';
    if (scheduleRunsError) {
      pageSchedRunsList.textContent = scheduleRunsError;
      return;
    }
    if (!scheduleRunsData) {
      pageSchedRunsList.textContent = '（未加载）';
      return;
    }
    if (!rows.length) {
      pageSchedRunsList.textContent = schedRunsFilterActive(scheduleRunsFilter)
        ? '（没有符合当前筛选的运行记录；点「清除筛选」看全部）'
        : '（暂无调度运行记录；调度器跑过一次后这里会出现记录）';
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'runner-table-wrap';
    const table = document.createElement('table');
    table.className = 'runner-table sched-runs-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['时间', '任务', 'kind', '轮次/成员', 'attempt', 'class/outcome',
      'exit/exit_code', 'duration', 'clicks', 'error']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement('tbody');
    for (const run of rows) {
      const cells = schedRunRowCells(run, scheduleConfig);
      const tr = document.createElement('tr');
      tr.tabIndex = 0;
      tr.className = 'runner-run-row';
      tr.title = '点击查看运行详情' + (run && run.run_id ? '：' + run.run_id : '');
      const open = () => openScheduleRunDetail(run);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (ev) => {
        if (!ev || (ev.key !== 'Enter' && ev.key !== ' ')) return;
        if (ev.preventDefault) ev.preventDefault();
        open();
      });
      const addCell = (text, cls) => {
        const td = document.createElement('td');
        td.textContent = String(text == null ? '' : text);
        if (cls) td.className = cls;
        tr.appendChild(td);
        return td;
      };
      addCell(cells.time);
      addCell(cells.task);
      const kindCell = document.createElement('td');
      kindCell.appendChild(makeSchedRunBadge(cells.kind, 'kind'));
      tr.appendChild(kindCell);
      addCell(cells.round_member);
      addCell(cells.attempt);
      const outcomeCell = document.createElement('td');
      if (cells.class !== '—') outcomeCell.appendChild(makeSchedRunBadge(cells.class, 'kind'));
      outcomeCell.appendChild(makeSchedRunBadge(cells.outcome, cells.outcome_class));
      tr.appendChild(outcomeCell);
      addCell(cells.exit);
      addCell(cells.duration);
      addCell(cells.clicks);
      addCell(cells.error || '—', cells.error ? 'runner-error-cell' : '');
      tbody.appendChild(tr);
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    pageSchedRunsList.appendChild(wrap);
  }

// 列表读取。始终 resolve（不 reject）：运行区是调度页的
// 软依赖，失败时原样展示并记录
// WARN，而不是被吞掉。
  async function refreshScheduleRuns() {
    if (!pageSchedRunsList) return { ok: false, error: '运行记录区不可用' };
    if (scheduleRunsLoading) return { ok: false, error: '运行记录读取中' };
    scheduleRunsLoading = true;
    if (pageSchedRunsRefresh) pageSchedRunsRefresh.disabled = true;
    if (pageSchedRunsStatus) pageSchedRunsStatus.textContent = '读取中…';
    const url = schedRunsBuildUrl(scheduleRunsFilter);
    try {
      const body = await runnerFetchJson(url);
      scheduleRunsData = body;
      scheduleRunsError = '';
      return { ok: true, data: body };
    } catch (e) {
      const status = e && e.status ? Number(e.status) : 0;
      const details = (e && Array.isArray(e.details) && e.details.length) ? e.details : [runnerErrorText(e)];
      scheduleRunsData = null;
      scheduleRunsError = schedRunsResponseErrorText(status, { errors: details });
      schedLog(scheduleRunsError, 'WARN');
      return { ok: false, error: scheduleRunsError };
    } finally {
      scheduleRunsLoading = false;
      if (pageSchedRunsRefresh) pageSchedRunsRefresh.disabled = false;
      renderScheduleRuns();
      if (pageSchedRunsSummary) {
        pageSchedRunsSummary.textContent = schedRunsStatusCardText(scheduleRunsData, scheduleRunsError);
      }
    }
  }

// 详情对话框的单次运行读取（GET /runs/scheduler/run?run_id=）。
  async function fetchScheduleRunOnce(runId) {
    try {
      const body = await runnerFetchJson(schedRunDetailUrl(runId));
      const run = (body.run && typeof body.run === 'object') ? body.run : null;
      if (!run) return { ok: false, status: 200, body: body, error: '详情读取失败：响应缺少 run 对象' };
      return { ok: true, status: 200, body: body, run: run, error: '' };
    } catch (e) {
      const status = e && e.status ? Number(e.status) : 0;
      const details = (e && Array.isArray(e.details) && e.details.length) ? e.details : [runnerErrorText(e)];
      return {
        ok: false,
        status: status,
        body: { errors: details },
        error: schedRunDetailErrorText(status, { errors: details }),
      };
    }
  }

function renderScheduleRunDetail(run) {
  if (!schedRunDialogBody) return;
  const r = run || {};
  if (schedRunDialogTitle) schedRunDialogTitle.textContent = schedRunDetailTitle(r, scheduleConfig);
  schedRunDialogBody.textContent = '';
  const table = document.createElement('table');
  table.className = 'runner-table run-detail-table';
  const tbody = document.createElement('tbody');
  for (const [key, value] of schedRunDetailRows(r)) {
    const tr = document.createElement('tr');
    const label = document.createElement('td');
    label.textContent = key;
    const cell = document.createElement('td');
    cell.textContent = value;
    if (key === 'error') cell.className = 'dialog-error';
    tr.append(label, cell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  schedRunDialogBody.appendChild(table);
  const errorText = schedRunErrorText(r.error);
  if (errorText) {
    const label = document.createElement('div');
    label.className = 'muted small';
    label.textContent = '错误全文';
    const pre = document.createElement('pre');
    pre.className = 'dialog-error';
    pre.textContent = errorText;
    schedRunDialogBody.append(label, pre);
  }
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = '完整 JSON（所有字段，含 resume / clicks_file）';
  const pre = document.createElement('pre');
  try {
    pre.textContent = JSON.stringify(r, null, 2);
  } catch (e) {
    pre.textContent = String(r);
  }
  details.append(summary, pre);
  schedRunDialogBody.appendChild(details);
}

function closeScheduleRunDetail() {
  scheduleRunDetailRunId = '';
  if (schedRunDialog && schedRunDialog.open) schedRunDialog.close();
}

async function openScheduleRunDetail(run) {
  if (!schedRunDialog) return;
  const runId = typeof run === 'string'
    ? String(run).trim()
    : String((run && run.run_id) || '').trim();
  scheduleRunDetailRunId = runId;
  if (schedRunDialogTitle) schedRunDialogTitle.textContent = '运行详情' + (runId ? ' · ' + runId : '');
  if (schedRunDialogBody) schedRunDialogBody.textContent = '读取中…';
  if (schedRunDialogError) schedRunDialogError.textContent = '';
  if (typeof schedRunDialog.showModal === 'function' && !schedRunDialog.open) {
    try { schedRunDialog.showModal(); } catch (e) { /* already open */ }
  }
  if (!runId) {
    const msg = '详情读取失败：该运行记录缺少 run_id';
    if (schedRunDialogBody) schedRunDialogBody.textContent = '';
    if (schedRunDialogError) schedRunDialogError.textContent = msg;
    schedLog(msg, 'WARN');
    return;
  }
  const res = await fetchScheduleRunOnce(runId);
  if (scheduleRunDetailRunId !== runId) return; // a newer row click supersedes this read
  if (!res.ok) {
    if (schedRunDialogBody) schedRunDialogBody.textContent = '';
    if (schedRunDialogError) schedRunDialogError.textContent = res.error;
    schedLog(res.error, 'WARN');
    return;
  }
  if (schedRunDialogError) schedRunDialogError.textContent = '';
  renderScheduleRunDetail(res.run);
}

async function toggleScheduleEntry(entryId, enabled) {
  if (scheduleBusy) return;
  const cfg = await loadScheduleConfig(true);
  if (!cfg) {
    schedLog('启用/禁用失败：调度配置不可用', 'ERROR');
    return;
  }
  const idx = (cfg.entries || []).findIndex((e) => e.entry_id === entryId);
  if (idx < 0) {
    schedLog('启用/禁用失败：条目「' + entryId + '」不存在（可能已被外部修改）', 'WARN');
    await refreshSchedulePage();
    return;
  }
  cfg.entries[idx].enabled = !!enabled;
  const res = await postScheduleConfig(cfg);
  if (!res.ok) {
    const msg = schedConfigSaveErrorText(res);
    schedLog('保存调度条目失败：' + msg, 'WARN');
    if (pageSchedConfigStatus) pageSchedConfigStatus.textContent = msg;
    await refreshSchedulePage();
    return;
  }
  schedLog(`已${enabled ? '启用' : '禁用'}调度条目「${entryId}」`);
  await refreshSchedulePage();
}

async function moveScheduleEntry(entryId, delta) {
  if (scheduleBusy) return;
  const cfg = await loadScheduleConfig(true);
  if (!cfg) {
    schedLog('排序失败：调度配置不可用', 'ERROR');
    return;
  }
  const index = (cfg.entries || []).findIndex((e) => e.entry_id === entryId);
  if (index < 0) {
    schedLog('排序失败：条目「' + entryId + '」不存在', 'WARN');
    return;
  }
  const next = schedMoveEntry(cfg, index, delta);
  if (next.entries[index] && next.entries[index].entry_id === entryId) return; // already at the edge
  const res = await postScheduleConfig(next);
  if (!res.ok) {
    const msg = schedConfigSaveErrorText(res);
    schedLog('保存条目顺序失败：' + msg, 'WARN');
    if (pageSchedConfigStatus) pageSchedConfigStatus.textContent = msg;
    return;
  }
  schedLog(`已移动调度条目「${entryId}」（entries 顺序 = 执行顺序）`);
  await refreshSchedulePage();
}

async function deleteScheduleEntry(entryId, isQueue) {
  if (scheduleBusy) return;
  const note = isQueue ? '\n只删除触发条目，队列本身和成员任务不受影响。' : '';
  if (!window.confirm(`删除调度条目「${entryId}」？${note}`)) return;
  const cfg = await loadScheduleConfig(true);
  if (!cfg) {
    schedLog('删除失败：调度配置不可用', 'ERROR');
    return;
  }
  if (!(cfg.entries || []).some((e) => e.entry_id === entryId)) {
    schedLog('删除失败：条目「' + entryId + '」不存在', 'WARN');
    await refreshSchedulePage();
    return;
  }
  const res = await postScheduleConfig(schedRemoveEntryById(cfg, entryId));
  if (!res.ok) {
    const msg = schedConfigSaveErrorText(res);
    schedLog('删除调度条目失败：' + msg, 'WARN');
    if (pageSchedConfigStatus) pageSchedConfigStatus.textContent = msg;
    return;
  }
  schedLog(`已删除调度条目「${entryId}」`);
  await refreshSchedulePage();
}

function populateScheduleEntryTargets(kind, selected) {
  if (!schedEntryTarget) return;
  const k = schedEntryKindLabel(kind);
  const value = String(selected || '');
  schedEntryTarget.textContent = '';
  const values = [];
  if (k === 'queue') {
    for (const q of (scheduleConfig && scheduleConfig.queues) || []) values.push(q.queue_id);
  } else {
    for (const t of scheduleTasksCache) values.push(t);
  }
  if (value && !values.includes(value)) values.unshift(value);
  if (!values.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = k === 'queue' ? '（还没有队列：先到队列面板新建）' : '（任务库为空）';
    schedEntryTarget.appendChild(opt);
    return;
  }
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    schedEntryTarget.appendChild(opt);
  }
  schedEntryTarget.value = value && values.includes(value) ? value : values[0];
}

function updateScheduleEntryTargetHint() {
  if (!schedEntryModeHint) return;
  const locked = schedSaveBlockedReason(scheduleLocked());
  if (locked) {
    schedEntryModeHint.textContent = '注意：' + locked;
    return;
  }
  const st = scheduleEntryDialogState;
  const kind = schedEntryKind ? schedEntryKind.value : 'task';
  const target = schedEntryTarget ? schedEntryTarget.value : '';
  const cfg = scheduleConfig || schedEmptyConfig();
  if (kind === 'queue' && target) {
    const other = schedQueueEntryConflict(cfg, target, st && st.entryId);
    if (other) {
      schedEntryModeHint.textContent =
        `队列「${target}」已有触发条目「${other}」：保存会被拒绝（一个队列最多一个 entry）。`;
      return;
    }
  }
  if (kind === 'task' && target) {
    const qid = schedFindTaskQueueMember(cfg, target);
    if (qid) {
      schedEntryModeHint.textContent = `任务「${target}」已在队列「${qid}」中：保存会被拒绝（防双跑）。`;
      return;
    }
  }
  schedEntryModeHint.textContent = st && st.mode === 'create'
    ? '新建条目：保存后追加到 entries 末尾（顺序 = 执行顺序）。'
    : '修改后保存会先 GET 当前配置再整体写回。';
}

function updateScheduleEntryLifecycleUi() {
  const temp = schedEntryLifecycle && schedEntryLifecycle.value === 'temp';
  for (const el of [schedEntryWindows, schedEntryWindowsJson, schedEntryQuotaPer, schedEntryQuotaTimes]) {
    if (el) el.disabled = temp;
  }
  if (schedEntryTempHint) {
    schedEntryTempHint.textContent = temp
      ? 'temp：每个 pass 按 entries 顺序执行一次；没有窗口/quota/完成记忆，保存时 windows 与 quota 会被清空。'
      : 'periodic：按窗口/quota/冷却触发；窗口留空 = 全天。';
  }
}

function readScheduleEntryForm() {
  return {
    kind: schedEntryKind ? schedEntryKind.value : 'task',
    task: schedEntryTarget ? schedEntryTarget.value : '',
    enabled: schedEntryEnabled ? schedEntryEnabled.checked : true,
    lifecycle: schedEntryLifecycle ? schedEntryLifecycle.value : 'periodic',
    windows_text: schedEntryWindows ? schedEntryWindows.value : '',
    windows_json: schedEntryWindowsJson ? schedEntryWindowsJson.value : '',
    quota_per: schedEntryQuotaPer ? schedEntryQuotaPer.value : '',
    quota_times: schedEntryQuotaTimes ? schedEntryQuotaTimes.value : '1',
    retry: schedEntryRetry ? schedEntryRetry.value : '1',
    cooldown: schedEntryCooldown ? schedEntryCooldown.value : '300',
    params_text: schedEntryParams ? schedEntryParams.value : '',
  };
}

function openScheduleEntryDialog(opts) {
  if (!schedEntryDialog) return;
  const o = opts || {};
  const cfg = scheduleConfig || schedEmptyConfig();
  const mode = o.mode === 'create' ? 'create' : 'edit';
  let entry = o.entry || null;
  if (!entry && o.entryId) {
    entry = (cfg.entries || []).find((e) => e.entry_id === o.entryId) || null;
  }
  if (mode === 'edit' && !entry) {
    schedLog('打开调度条目失败：条目不存在', 'WARN');
    return;
  }
  if (!entry) entry = schedDefaultTaskEntry(o.task || scheduleTasksCache[0] || '', cfg, o.kind || 'task');
  scheduleEntryDialogState = {
    mode,
    entryId: mode === 'edit' ? entry.entry_id : '',
    baseEntry: entry,
  };
  const form = schedEntryToForm(entry, (cfg.config && cfg.config.defaults) || {});
  if (schedEntryTitle) {
    schedEntryTitle.textContent = o.title
      || (mode === 'create' ? '添加调度条目' : `编辑调度条目：${entry.entry_id}`);
  }
  if (schedEntrySave) schedEntrySave.textContent = mode === 'create' ? '加入调度' : '保存';
  if (schedEntryIdEl) {
    schedEntryIdEl.textContent = mode === 'create'
      ? 'entry_id：保存时自动生成（task-<任务名> / queue-<queue_id>）'
      : 'entry_id：' + entry.entry_id;
  }
  if (schedEntryEnabled) schedEntryEnabled.checked = form.enabled;
  if (schedEntryLifecycle) schedEntryLifecycle.value = form.lifecycle;
  if (schedEntryWindows) schedEntryWindows.value = (entry.windows && entry.windows.length) ? schedWindowsToText(entry.windows) : '';
  if (schedEntryWindowsJson) schedEntryWindowsJson.value = '';
  if (schedEntryQuotaPer) schedEntryQuotaPer.value = form.quota_per;
  if (schedEntryQuotaTimes) schedEntryQuotaTimes.value = form.quota_times;
  if (schedEntryRetry) schedEntryRetry.value = form.retry;
  if (schedEntryCooldown) schedEntryCooldown.value = form.cooldown;
  if (schedEntryParams) schedEntryParams.value = form.params_text;
  if (schedEntryKind) {
    schedEntryKind.value = form.kind;
    schedEntryKind.disabled = mode === 'edit';
  }
  populateScheduleEntryTargets(form.kind, form.task);
  if (schedEntryTarget) schedEntryTarget.disabled = mode === 'edit';
  updateScheduleEntryLifecycleUi();
  updateScheduleEntryTargetHint();
  if (schedEntryError) schedEntryError.textContent = '';
  if (schedEntryDialog.open) schedEntryDialog.close();
  schedEntryDialog.showModal();
}

  async function openTaskScheduleDialog(task) {
    const t = String(task == null ? '' : task).trim();
    if (!t) return;
    await ensureScheduleTaskChoices(true);
    await loadScheduleConfig(true);
    if (!scheduleConfig) {
      window.alert('读取调度配置失败：' + (scheduleConfigError || '未知错误'));
      return;
    }
    const cfg = scheduleConfig;
    const hits = schedFindTaskEntries(cfg, t);
    const queueId = schedFindTaskQueueMember(cfg, t);
    if (!hits.length && queueId) {
      const msg = '任务「' + t + '」已是队列「' + queueId + '」的成员，不能再单独加入调度（会双跑）。\n请先在调度页调整队列成员。';
      schedLog(msg, 'WARN');
      window.alert(msg);
      return;
    }
    if (hits.length > 1) {
      const ids = hits.map((e) => e.entry_id).join('、');
      schedLog('任务「' + t + '」有 ' + hits.length + ' 条调度条目（' + ids + '），只编辑第一条', 'WARN');
      window.alert('任务「' + t + '」有 ' + hits.length + ' 条调度条目：' + ids + '。\n本次只编辑第一条；其余条目可在调度页查看/删除。');
    }
    if (hits.length) {
      openScheduleEntryDialog({ mode: 'edit', entry: hits[0] });
    } else {
      openScheduleEntryDialog({
        mode: 'create',
        entry: schedDefaultTaskEntry(t, cfg, 'task'),
        title: '加入调度：' + t,
      });
    }
  }

  async function openScheduleAddEntryDialog() {
    await ensureScheduleTaskChoices(true);
    await loadScheduleConfig(true);
    if (!scheduleConfig) {
      window.alert('读取调度配置失败：' + (scheduleConfigError || '未知错误'));
      return;
    }
    const target = scheduleTasksCache[0] || ((scheduleConfig.queues || [])[0] || {}).queue_id || '';
    openScheduleEntryDialog({
      mode: 'create',
      entry: schedDefaultTaskEntry(target, scheduleConfig, 'task'),
    });
  }

async function saveScheduleEntryDialog() {
  const st = scheduleEntryDialogState;
  if (!st || !schedEntryDialog) return;
  if (schedEntryError) schedEntryError.textContent = '';
  const form = readScheduleEntryForm();
  const local = schedValidateEntryForm(form, scheduleConfig || schedEmptyConfig(), st.entryId, st.baseEntry);
  if (!local.ok) {
    if (schedEntryError) schedEntryError.textContent = local.errors.join('\n');
    return;
  }
  const fresh = await loadScheduleConfig(true);
  if (!fresh) {
    if (schedEntryError) schedEntryError.textContent = '读取调度配置失败：' + (scheduleConfigError || '未知错误');
    return;
  }
  const freshEntry = (fresh.entries || []).find((e) => e.entry_id === st.entryId) || st.baseEntry;
  const check = schedValidateEntryForm(form, fresh, st.entryId, freshEntry);
  if (!check.ok) {
    if (schedEntryError) schedEntryError.textContent = check.errors.join('\n');
    return;
  }
  let next;
  if (st.mode === 'create') {
    next = schedUpsertEntry(fresh, check.entry);
  } else {
    const idx = (fresh.entries || []).findIndex((e) => e.entry_id === st.entryId);
    if (idx < 0) {
      if (schedEntryError) schedEntryError.textContent = '条目已被外部删除，请关闭后重新打开。';
      return;
    }
    next = schedNormalizeConfig(fresh);
    next.entries[idx] = Object.assign({}, next.entries[idx], check.entry);
  }
  if (schedEntrySave) schedEntrySave.disabled = true;
  const res = await postScheduleConfig(next);
  if (schedEntrySave) schedEntrySave.disabled = false;
  if (!res.ok) {
    const msg = schedConfigSaveErrorText(res);
    if (schedEntryError) schedEntryError.textContent = msg;
    schedLog('保存调度条目失败：' + msg, res.status === 409 ? 'WARN' : 'ERROR');
    return;
  }
  schedEntryDialog.close();
  schedLog(`已保存调度条目「${check.entry.entry_id}」${st.mode === 'create' ? '（新建）' : ''}`);
  await refreshSchedulePage();
}

function renderScheduleQueueMembers() {
  if (!schedQueueMembers) return;
  const st = scheduleQueueDialogState;
  const members = st ? st.members : [];
  schedQueueMembers.textContent = '';
  if (!members.length) {
    schedQueueMembers.textContent = '（还没有成员：从下方任务池勾选后点「添加勾选任务」）';
    return;
  }
  members.forEach((task, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.className = 'small';
    label.textContent = `${i + 1}. ${task}`;
    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '↑';
    up.disabled = i === 0;
    up.addEventListener('click', () => {
      st.members = schedQueueMemberMove(st.members, i, -1);
      renderScheduleQueueMembers();
      renderScheduleQueuePool();
    });
    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = '↓';
    down.disabled = i === members.length - 1;
    down.addEventListener('click', () => {
      st.members = schedQueueMemberMove(st.members, i, 1);
      renderScheduleQueueMembers();
      renderScheduleQueuePool();
    });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '移除';
    rm.addEventListener('click', () => {
      st.members = schedQueueMemberRemove(st.members, task);
      renderScheduleQueueMembers();
      renderScheduleQueuePool();
    });
    row.append(label, up, down, rm);
    schedQueueMembers.appendChild(row);
  });
}

function renderScheduleQueuePool() {
  if (!schedQueueTaskPool) return;
  const st = scheduleQueueDialogState;
  const members = st ? st.members : [];
  schedQueueTaskPool.textContent = '';
  const available = scheduleTasksCache.filter((t) => !members.includes(t));
  if (!available.length) {
    schedQueueTaskPool.textContent = '（任务库没有更多可添加的任务）';
    return;
  }
  for (const task of available) {
    const label = document.createElement('label');
    label.className = 'opt';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = task;
    cb.dataset.task = task;
    label.append(cb, document.createTextNode(' ' + task));
    schedQueueTaskPool.appendChild(label);
  }
}

function updateScheduleQueueRoundsHint() {
  if (!schedQueueRoundsHint) return;
  const rounds = Number(schedQueueTotalRounds ? schedQueueTotalRounds.value : 0);
  schedQueueRoundsHint.textContent = rounds === 0
    ? 'total_rounds=0：无限轮，直到手动停止/重置。'
    : `total_rounds=${rounds}：跑满 ${rounds} 轮后 finished，不再触发（不自动重置）。`;
}

  async function openScheduleQueueDialog(queueId) {
    await ensureScheduleTaskChoices(true);
    await loadScheduleConfig(true);
    if (!scheduleConfig) {
      window.alert('读取调度配置失败：' + (scheduleConfigError || '未知错误'));
      return;
    }
    const q = queueId
      ? (scheduleConfig.queues || []).find((x) => x.queue_id === queueId)
      : null;
    if (queueId && !q) {
      schedLog('打开队列失败：队列「' + queueId + '」不存在', 'WARN');
      return;
    }
    scheduleQueueDialogState = {
      mode: q ? 'edit' : 'create',
      queueId: q ? q.queue_id : '',
      base: q || null,
      members: q && Array.isArray(q.members) ? q.members.slice() : [],
    };
    const form = schedQueueToForm(q || {});
    if (schedQueueTitle) schedQueueTitle.textContent = q ? '编辑队列：' + q.queue_id : '新建队列';
    if (schedQueueId) {
      schedQueueId.value = form.queue_id;
      schedQueueId.disabled = !!q;
    }
    if (schedQueueName) schedQueueName.value = form.name;
    if (schedQueueTotalRounds) schedQueueTotalRounds.value = form.total_rounds;
    if (schedQueueOnFailure) schedQueueOnFailure.value = form.on_failure;
    if (schedQueueBetweenMs) schedQueueBetweenMs.value = form.between_ms;
    renderScheduleQueueMembers();
    renderScheduleQueuePool();
    updateScheduleQueueRoundsHint();
    if (schedQueueLockHint) {
      const locked = schedSaveBlockedReason(scheduleLocked());
      schedQueueLockHint.textContent = locked ? '注意：' + locked : '—';
    }
    if (schedQueueError) schedQueueError.textContent = '';
    if (schedQueueDialog.open) schedQueueDialog.close();
    schedQueueDialog.showModal();
  }

async function saveScheduleQueueDialog() {
  const st = scheduleQueueDialogState;
  if (!st || !schedQueueDialog) return;
  if (schedQueueError) schedQueueError.textContent = '';
  const form = {
    queue_id: schedQueueId ? schedQueueId.value : '',
    name: schedQueueName ? schedQueueName.value : '',
    members: st.members.slice(),
    total_rounds: schedQueueTotalRounds ? schedQueueTotalRounds.value : '0',
    on_failure: schedQueueOnFailure ? schedQueueOnFailure.value : 'continue',
    between_ms: schedQueueBetweenMs ? schedQueueBetweenMs.value : '500',
  };
  const local = schedValidateQueueForm(form, scheduleConfig || schedEmptyConfig(), st.queueId, st.base);
  if (!local.ok) {
    if (schedQueueError) schedQueueError.textContent = local.errors.join('\n');
    return;
  }
  const fresh = await loadScheduleConfig(true);
  if (!fresh) {
    if (schedQueueError) schedQueueError.textContent = '读取调度配置失败：' + (scheduleConfigError || '未知错误');
    return;
  }
  const freshQueue = (fresh.queues || []).find((q) => q.queue_id === st.queueId) || st.base;
  const check = schedValidateQueueForm(form, fresh, st.queueId, freshQueue);
  if (!check.ok) {
    if (schedQueueError) schedQueueError.textContent = check.errors.join('\n');
    return;
  }
  let next;
  if (st.mode === 'create') {
    next = schedUpsertQueue(fresh, check.queue);
  } else {
    const idx = (fresh.queues || []).findIndex((q) => q.queue_id === st.queueId);
    if (idx < 0) {
      if (schedQueueError) schedQueueError.textContent = '队列已被外部删除，请关闭后重新打开。';
      return;
    }
    next = schedNormalizeConfig(fresh);
    next.queues[idx] = Object.assign({}, next.queues[idx], check.queue);
  }
  if (schedQueueSave) schedQueueSave.disabled = true;
  const res = await postScheduleConfig(next);
  if (schedQueueSave) schedQueueSave.disabled = false;
  if (!res.ok) {
    const msg = schedConfigSaveErrorText(res);
    if (schedQueueError) schedQueueError.textContent = msg;
    schedLog('保存队列失败：' + msg, res.status === 409 ? 'WARN' : 'ERROR');
    return;
  }
  schedQueueDialog.close();
  schedLog(`已保存队列「${check.queue.queue_id}」${st.mode === 'create' ? '（新建）' : ''}`);
  await refreshSchedulePage();
}

async function deleteScheduleQueue(queueId) {
  if (scheduleBusy) return;
  const cfg = await loadScheduleConfig(true);
  if (!cfg) {
    schedLog('删除队列失败：调度配置不可用', 'ERROR');
    return;
  }
  if (!(cfg.queues || []).some((q) => q.queue_id === queueId)) {
    schedLog('删除队列失败：队列「' + queueId + '」不存在', 'WARN');
    return;
  }
  const removed = schedRemoveQueue(cfg, queueId);
  const entryNote = removed.removed_entry_ids.length
    ? `\n同时删除触发条目：${removed.removed_entry_ids.join('、')}`
    : '';
  if (!window.confirm(`删除队列「${queueId}」？${entryNote}\n成员任务目录不受影响。`)) return;
  const res = await postScheduleConfig(removed.config);
  if (!res.ok) {
    const msg = schedConfigSaveErrorText(res);
    schedLog('删除队列失败：' + msg, 'WARN');
    if (pageSchedConfigStatus) pageSchedConfigStatus.textContent = msg;
    return;
  }
  schedLog(`已删除队列「${queueId}」` + (removed.removed_entry_ids.length
    ? `（同时删除条目 ${removed.removed_entry_ids.join('、')}）` : ''));
  await refreshSchedulePage();
}

async function saveSchedulePageConfig() {
  if (scheduleBusy) return;
  if (scheduleJsonDirty) {
    const msg = '高级 JSON 有未保存修改：请用「保存 JSON」写入，或先「重新加载」放弃修改。';
    schedLog(msg, 'WARN');
    if (pageSchedConfigStatus) pageSchedConfigStatus.textContent = msg;
    return;
  }
  // P1-4：先 GET。工具栏保存不得用缓存文档覆盖
  // 本页之外的编辑（手工编辑/其他标签页/脚本）。比较
  // 当前文件与本页加载快照；不一致则中止
  // 保存并要求重载。
  const freshRes = await fetchScheduleConfigOnce();
  if (!freshRes.ok) {
    const msg = '保存配置失败：' + freshRes.error;
    schedLog(msg, 'ERROR');
    if (pageSchedConfigStatus) pageSchedConfigStatus.textContent = msg;
    return;
  }
  const freshRaw = schedConfigSnapshotText(freshRes.body.config);
  if (schedConfigSnapshotChanged(scheduleConfigBase, freshRaw)) {
    const msg = schedExternalConfigChangeText();
    schedLog(msg, 'WARN');
    if (pageSchedConfigStatus) pageSchedConfigStatus.textContent = msg;
    return;
  }
  const cfg = scheduleConfig || schedNormalizeConfig(freshRes.body.config);
  const res = await postScheduleConfig(cfg);
  if (!res.ok) {
    const msg = schedConfigSaveErrorText(res);
    schedLog('保存调度配置失败：' + msg, res.status === 409 ? 'WARN' : 'ERROR');
    if (pageSchedConfigStatus) pageSchedConfigStatus.textContent = msg;
    return;
  }
  const bytes = res.body && res.body.bytes != null ? `（${res.body.bytes} bytes）` : '';
  const backup = res.body && res.body.backup ? ` · 备份=${res.body.backup}` : '';
  schedLog(`调度配置已保存${bytes}${backup}`);
  if (pageSchedConfigStatus) pageSchedConfigStatus.textContent = `已保存${bytes}${backup}`;
  await refreshSchedulePage();
}

  async function saveScheduleJson() {
    if (scheduleBusy || !pageSchedJson) return;
    const parsed = schedParseConfigJson(pageSchedJson.value);
    if (!parsed.ok) {
      if (pageSchedJsonError) pageSchedJsonError.textContent = '本地校验失败：' + parsed.error;
      if (pageSchedJsonStatus) pageSchedJsonStatus.textContent = '未保存：本地校验失败';
      schedLog('调度配置 JSON 本地校验失败：' + parsed.error, 'WARN');
      return;
    }
    const freshRes = await fetchScheduleConfigOnce();
    if (!freshRes.ok) {
      const msg = '保存配置失败：' + freshRes.error;
      if (pageSchedJsonError) pageSchedJsonError.textContent = msg;
      schedLog(msg, 'ERROR');
      return;
    }
    if (schedConfigSnapshotChanged(scheduleConfigBase, schedConfigSnapshotText(freshRes.body.config))) {
      const msg = schedExternalConfigChangeText();
      if (pageSchedJsonError) pageSchedJsonError.textContent = msg;
      if (pageSchedJsonStatus) pageSchedJsonStatus.textContent = msg;
      schedLog(msg, 'WARN');
      return;
    }
    if (pageSchedJsonError) pageSchedJsonError.textContent = '';
    const res = await postScheduleConfig(parsed.config);
    if (!res.ok) {
      const msg = schedConfigSaveErrorText(res);
      if (pageSchedJsonError) pageSchedJsonError.textContent = msg;
      if (pageSchedJsonStatus) pageSchedJsonStatus.textContent = msg;
      schedLog('保存调度配置 JSON 失败：' + msg, res.status === 409 ? 'WARN' : 'ERROR');
      return;
    }
    scheduleJsonDirty = false;
    const bytes = res.body && res.body.bytes != null ? '（' + res.body.bytes + ' bytes）' : '';
    schedLog('调度配置 JSON 已保存' + bytes, 'INFO');
    await refreshSchedulePage();
    if (pageSchedJsonStatus) pageSchedJsonStatus.textContent = '已保存' + bytes;
  }

  async function reloadScheduleJson() {
    scheduleJsonDirty = false;
    if (pageSchedJsonError) pageSchedJsonError.textContent = '';
    if (pageSchedJsonStatus) pageSchedJsonStatus.textContent = '重新载入中…';
    await refreshSchedulePage();
  }

// --- 旧 Studio 工作台面板 + 重置记忆 ----------------------------------------
// 工作台面板 + 重置记忆：fmtLocal / schedBadge / renderScheduler / refreshScheduler / resetTaskChecks / openResetMemoryDialog / populateResetTaskList / submitResetMemory
// =====================================================================
// --- M2/N37: 调度面板 + 重置记忆 -------------------------------------------
function fmtLocal(ms) {
  if (!ms) return '—';
  try {
    return new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false });
  } catch (e) {
    return String(ms);
  }
}

  function schedBadge(text, cls) {
    const span = document.createElement('span');
    span.className = 'runner-badge ' + (cls || 'kind');
    span.textContent = String(text == null ? '' : text);
    return span;
  }

  function renderScheduler(s) {
    if (!schedSummary || !schedEntries) return;
    if (!s) {
      schedSummary.textContent = scheduleStatusError
        ? schedStatusErrorText(scheduleStatusError)
        : '（调度状态未加载）';
      schedEntries.textContent = '（调度状态不可用）';
      return;
    }
    schedulerStatus = s;
    const guards = s.guards || {};
    const parts = [
      '模式=' + (s.mode || '—'),
      '轮次=' + (s.passes != null ? s.passes : 0),
      '下一唤醒=' + (s.next_wake_local || fmtLocal(s.next_wake_ms)),
      '锁=' + (scheduleLocked() ? '占用' : '空闲'),
      '护栏=' + (guards.blocked ? '已阻断' : '正常'),
    ];
    if (s.running) {
      parts.push('正在执行=' + (s.running.entry_id || '?') + '/' + (s.running.task || '?'));
    }
    if (guards.blackout_reason) parts.push('原因=' + guards.blackout_reason);
    if (s.last_stop) parts.push('上次停止=' + (typeof s.last_stop === 'string' ? s.last_stop : JSON.stringify(s.last_stop)));
    schedSummary.textContent = parts.join(' · ');

    schedEntries.textContent = '';
    const entries = Array.isArray(s.entries) ? s.entries : [];
    if (!entries.length) {
      schedEntries.textContent = '（无调度条目：在下方「调度配置」或任务页「调度设置…」添加）';
      return;
    }
    for (const e of entries) {
      const row = document.createElement('div');
      row.className = 'sched-entry';
      const head = document.createElement('div');
      head.className = 'row';
      const name = document.createElement('strong');
      name.textContent = (e.entry_id || '?') + ' · ' + (e.task || '?');
      head.appendChild(name);
      if (e.kind === 'queue') head.appendChild(schedBadge('queue', 'kind'));
      head.appendChild(schedBadge(e.lifecycle || '?', 'kind'));
      if (e.enabled === false) head.appendChild(schedBadge('已禁用', 'warn'));
      if (e.runnable_now) head.appendChild(schedBadge('现在可跑', 'ok'));
      if (e.blocked_reason) head.appendChild(schedBadge('等待：' + e.blocked_reason, 'warn'));
      row.appendChild(head);

      const meta = document.createElement('div');
      meta.className = 'muted small';
      const quota = e.quota || {};
      const bits = [];
      if (quota.per) bits.push('quota ' + (quota.used != null ? quota.used : 0) + '/' + (quota.times != null ? quota.times : '?') + '（' + quota.per + '）');
      if (e.next_due_local) bits.push('下次=' + e.next_due_local);
      if (e.cooldown_until_ms) bits.push('冷却至=' + fmtLocal(e.cooldown_until_ms));
      if (e.last_result) bits.push('上次=' + e.last_result);
      meta.textContent = bits.join(' · ') || '（无窗口限制 / 每轮执行）';
      row.appendChild(meta);
      schedEntries.appendChild(row);
    }
  }

  async function refreshScheduler() {
    if (!schedSummary) return null;
    try {
      const s = await runnerFetchJson(RUNNER_API.schedulerStatus);
      schedulerStatus = s;
      state.scheduler = s;
      scheduleStatusError = '';
      renderScheduler(s);
      renderScheduleStatusCard(s);
      return s;
    } catch (e) {
      scheduleStatusError = runnerErrorText(e);
      schedSummary.textContent = schedStatusErrorText(scheduleStatusError);
      schedEntries.textContent = '（调度状态不可用）';
      return null;
    }
  }

function resetTaskChecks(mode) {
  if (!resetTaskList) return;
  for (const cb of resetTaskList.querySelectorAll('input[type=checkbox][data-task]')) {
    if (mode === 'all') cb.checked = true;
    else if (mode === 'none') cb.checked = false;
    else cb.checked = !cb.checked;
  }
}

  async function openResetMemoryDialog() {
    if (!resetMemoryDialog) return;
    if (resetError) resetError.textContent = '';
    if (resetResult) {
      resetResult.textContent = '—';
      resetResult.className = 'muted small';
    }
    await ensureScheduleTaskChoices(true);
    if (!schedulerStatus) await refreshScheduler();
    populateResetTaskList();
    if (!resetMemoryDialog.open) resetMemoryDialog.showModal();
  }

  function populateResetTaskList() {
    if (!resetTaskList) return;
    resetTaskList.textContent = '';
    const choices = (schedulerStatus && schedulerStatus.task_choices) || [];
    const byTask = {};
    for (const c of choices) {
      const task = c && c.task ? String(c.task) : '';
      if (!task) continue;
      byTask[task] = c;
    }
    const rows = [];
    const seen = new Set();
    for (const c of choices) {
      const task = c && c.task ? String(c.task) : '';
      if (!task || seen.has(task)) continue;
      seen.add(task);
      rows.push(c);
    }
    for (const task of scheduleTasksCache) {
      if (!task || seen.has(task)) continue;
      seen.add(task);
      rows.push(byTask[task] || { task: task });
    }
    if (!rows.length) {
      resetTaskList.textContent = '（没有可重置的任务：先安装任务或加入调度）';
      return;
    }
    for (const c of rows) {
      const task = String(c.task || '');
      if (!task) continue;
      const label = document.createElement('label');
      label.className = 'opt reset-task-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.task = task;
      label.appendChild(cb);
      const text = document.createElement('span');
      let note = '';
      if (c.bundle_exists === false) note += ' · 任务目录不存在';
      if (c.state_dir_exists) note += ' · 有 state';
      text.textContent = task + note;
      label.appendChild(text);
      resetTaskList.appendChild(label);
    }
  }

  async function submitResetMemory() {
    if (!resetTaskList) return;
    const tasks = Array.from(resetTaskList.querySelectorAll('input[type=checkbox][data-task]'))
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.task);
    if (!tasks.length) {
      if (resetError) resetError.textContent = '请至少选择一个任务（可用「全选」）。';
      return;
    }
    const include_checkpoint = resetIncludeCheckpoint ? resetIncludeCheckpoint.checked : true;
    if (resetError) resetError.textContent = '';
    if (resetResult) {
      resetResult.textContent = '重置中…';
      resetResult.className = 'muted small';
    }
    try {
      const body = await runnerFetchJson(RUNNER_API.schedulerReset, {
        method: 'POST',
        body: { tasks: tasks, include_checkpoint: include_checkpoint },
      });
      const rep = body.report || {};
      const text = '重置记忆完成：任务=[' + (rep.tasks || tasks).join(', ') + '] · ' +
        '删除文件=' + (rep.files_removed != null ? rep.files_removed : '?') + ' · ' +
        '状态=' + (rep.state_path || '');
      if (resetResult) {
        resetResult.textContent = text;
        resetResult.className = 'muted small ok';
      }
      schedLog(text, 'INFO');
      if (resetMemoryDialog) resetMemoryDialog.close();
      await refreshScheduler();
      await refreshSchedulePage();
    } catch (e) {
      const msg = e && e.status === 409
        ? '调度器运行中：请先点「停止调度」再重置。'
        : '重置失败：' + runnerErrorText(e);
      if (resetError) resetError.textContent = msg;
      if (resetResult) {
        resetResult.textContent = '重置失败';
        resetResult.className = 'muted small err';
      }
    }
  }

  // --- 队列与调度 --------------------------------------------------------------



  function renderQueueSchedulerControl() {
    const s = state.runnerScheduler;
    const text = s ? runnerSchedStatusText(s) : '—';
    const cls = text === '运行中' ? 'ok' : (text === '停止中' ? 'warn' : 'kind');
    setBadge(el.schedBadge, text, cls);
    if (!s) {
      if (el.schedMeta) el.schedMeta.textContent = '（调度线程状态未加载）';
      return;
    }
    const tail = Array.isArray(s.log_tail) ? s.log_tail : [];
    const lastLine = tail.length ? String(tail[tail.length - 1]) : '—';
    renderKv(el.schedMeta, [
      ['调度线程', runnerSchedThreadText(s)],
      ['锁 pid', runnerSchedLockPidText(s)],
      ['停止请求', s.stop_requested === true ? '已请求（跑完当前任务后停止）' : '无'],
      ['passes', s.passes === undefined || s.passes === null ? '—' : String(s.passes)],
      ['上次 pass', runnerTimeText(s.last_pass_ms)],
      ['日志尾部', lastLine],
    ].concat(runnerSchedHistoryRows(s)));
  }

  function setSchedBusy(busy) {
    schedBusy = !!busy;
    if (el.schedStart) el.schedStart.disabled = schedBusy || schedStopping;
    if (el.schedStop) el.schedStop.disabled = schedBusy;
    if (el.schedRefresh) el.schedRefresh.disabled = schedBusy;
  }

  // 停止请求挂起时（后端 `timeout:true`，长尝试正在收尾），
  // keep "启动调度" disabled until the status poll observes running=false; the
  // 停止按钮保持可点（重复停止是无害空操作）。
  function setSchedStopping(stopping) {
    schedStopping = !!stopping;
    if (el.schedStart) el.schedStart.disabled = schedBusy || schedStopping;
  }



  function setRunBusy(busy) {
    runBusy = !!busy;
    if (el.runSubmit) el.runSubmit.disabled = !!busy;
    if (!busy) runStopping = false;
    // seq196：运行中即可停止；停止请求已发出（runStopping）时禁用按钮等
    // run status 轮询到 running=false，避免重复请求。
    if (el.runStop) {
      el.runStop.disabled = !busy || runStopping;
      el.runStop.textContent = runnerRunStopButtonText(runStopping);
    }
  }

  function renderRunTaskOptions() {
    if (!el.runTask) return;
    const body = state.tasks || {};
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    const current = String(el.runTask.value || '');
    const names = [];
    clearNode(el.runTask);
    for (const task of tasks) {
      const t = task || {};
      const name = t.task === undefined || t.task === null ? '' : String(t.task).trim();
      if (!name) continue;
      names.push(name);
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      el.runTask.appendChild(option);
    }
    if (!names.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '（没有可运行的任务）';
      el.runTask.appendChild(option);
      el.runTask.disabled = true;
      return;
    }
    el.runTask.disabled = false;
    el.runTask.value = names.indexOf(current) >= 0 ? current : names[0];
  }

  async function loadRunnerSchedulerStatus() {
    try {
      state.runnerScheduler = await runnerFetchJson(RUNNER_API.schedulerThreadStatus);
      renderQueueSchedulerControl();
      renderOverviewScheduler();
      return '';
    } catch (e) {
      state.runnerScheduler = null;
      renderQueueSchedulerControl();
      renderOverviewScheduler();
      const message = '调度线程状态读取失败：' + runnerErrorText(e);
      if (el.queueStatus) el.queueStatus.textContent = message;
      return message;
    }
  }



  async function loadQueuePage() {
    const errors = [];
    // 先取任务：条目/队列对话框与重置记忆列表使用
    // /runner/tasks（使用端唯一任务来源）。
    try {
      state.tasks = await runnerFetchJson(RUNNER_API.tasks);
      const list = Array.isArray(state.tasks.tasks) ? state.tasks.tasks : [];
      scheduleTasksCache = list
        .map(function (t) { return String((t && t.task) || '').trim(); })
        .filter(Boolean);
    } catch (e) {
      state.tasks = null;
      errors.push('任务列表读取失败：' + runnerErrorText(e));
    }
    renderRunTaskOptions();
    const schedError = await loadRunnerSchedulerStatus();
    if (schedError) errors.push(schedError);
    const pageErrors = await refreshSchedulePage();
    for (const message of pageErrors) errors.push(message);
    // seq151：页面加载/切回 queue 时恢复当前 run 的轮询（刷新不丢运行中状态）。
    await resumeRunnerRunPolling();
    return errors;
  }

  function scheduleAnyDialogOpen() {
    for (const dialog of [schedEntryDialog, schedQueueDialog, schedRunDialog, resetMemoryDialog]) {
      if (dialog && dialog.open) return true;
    }
    return false;
  }

  // 5 秒轮询只叠加运行时值。配置派生卡片由
  // refreshSchedulePage() 重建；这里只更新运行时角标宿主，
  // 用户不会丢失进行中的编辑或按钮焦点。
  async function pollQueueRuntimeOnce() {
    if (state.busy || scheduleBusy || schedBusy || scheduleAnyDialogOpen()) return;
    await loadRunnerSchedulerStatus();
    let status = null;
    scheduleStatusError = '';
    try {
      status = await runnerFetchJson(RUNNER_API.schedulerStatus);
      schedulerStatus = status;
      state.scheduler = status;
    } catch (e) {
      scheduleStatusError = runnerErrorText(e);
    }
    renderScheduleStatusCard(status);
    if (status) {
      updateScheduleEntryRuntime(status);
      updateScheduleQueueRuntime(status);
      renderScheduler(status);
    } else {
      renderScheduler(null);
    }
  }

  // 启动/停止/保存后刷新所有调度表面：顶部角标、
  // 概览卡片、GET /runner/scheduler/status 与 GET /scheduler/status。
  async function refreshSchedulerSurfaces() {
    await refreshHealth();
    await loadRunnerSchedulerStatus();
    await loadQueuePage();
  }

  async function startRunnerScheduler() {
    if (schedBusy) return;
    setSchedBusy(true);
    if (el.schedError) el.schedError.textContent = '';
    if (el.schedStatus) {
      el.schedStatus.textContent = '启动中…';
      el.schedStatus.className = 'muted small';
    }
    try {
      const body = await runnerFetchJson(RUNNER_API.schedulerStart, { method: 'POST' });
      const already = body.already_running === true;
      if (el.schedStatus) {
        el.schedStatus.textContent = already ? '调度本来就在运行' : '调度已启动';
        el.schedStatus.className = 'muted small ok';
      }
      setPageStatus(already ? '调度已在运行' : '调度已启动', 'ok');
      await refreshSchedulerSurfaces();
    } catch (e) {
      if (el.schedError) el.schedError.textContent = runnerErrorLines(e).join('\n');
      if (el.schedStatus) {
        let text = '启动失败';
        if (e && e.status === 409) {
          text = (e.code === 'device_busy' || /device_busy/.test(runnerErrorText(e)))
            ? '启动失败：设备被占用（Studio 试运行 / 临时运行中）'
            : '启动失败：调度锁被其他进程占用';
        }
        el.schedStatus.textContent = text;
        el.schedStatus.className = 'muted small err';
      }
      await loadRunnerSchedulerStatus();
    } finally {
      setSchedBusy(false);
    }
  }

  async function stopRunnerScheduler() {
    if (schedBusy) return;
    setSchedBusy(true);
    if (el.schedError) el.schedError.textContent = '';
    if (el.schedStatus) {
      el.schedStatus.textContent = '停止中…（当前任务跑完才退出）';
      el.schedStatus.className = 'muted small';
    }
    try {
      const body = await runnerFetchJson(RUNNER_API.schedulerStop, { method: 'POST' });
      const text = runnerStopText(body);
      const pending = runnerStopPending(body);
      if (el.schedStatus) {
        el.schedStatus.textContent = text;
        el.schedStatus.className = 'muted small ' + (pending ? 'warn' : 'ok');
      }
      setPageStatus(text, pending ? 'warn' : 'ok');
      setSchedStopping(pending);
      if (pending) startStopPolling();
      else stopStopPolling();
      await refreshSchedulerSurfaces();
    } catch (e) {
      stopStopPolling();
      setSchedStopping(false);
      if (el.schedError) el.schedError.textContent = runnerErrorLines(e).join('\n');
      if (el.schedStatus) {
        el.schedStatus.textContent = '停止失败';
        el.schedStatus.className = 'muted small err';
      }
      await loadRunnerSchedulerStatus();
    } finally {
      setSchedBusy(false);
    }
  }

  // 后端返回 `timeout:true`（长尝试正在收尾）期间，
  // UI 轮询 `GET /runner/scheduler/status` 直到 running=false（≤30 秒），
  // then reports "调度已停止"; a timeout is never rendered as a failure.
  function stopStopPolling() {
    if (stopPollTimer !== null) {
      clearTimeout(stopPollTimer);
      stopPollTimer = null;
    }
  }

  function scheduleStopPoll() {
    stopStopPolling();
    stopPollTimer = setTimeout(pollStopOnce, RUNNER_STOP_POLL_MS);
  }

  async function pollStopOnce() {
    stopPollTimer = null;
    if (Date.now() - stopPollStartedMs > RUNNER_STOP_POLL_MAX_MS) {
      // 预算结束后把控制权交还用户：调度可能
      // 仍在收尾，但 UI 不能永久锁死。
      setSchedStopping(false);
      if (el.schedStatus) {
        el.schedStatus.textContent = '仍在停止：当前任务可能还在执行（可稍后刷新）';
        el.schedStatus.className = 'muted small warn';
      }
      return;
    }
    let status = null;
    try {
      status = await runnerFetchJson(RUNNER_API.schedulerThreadStatus);
    } catch (e) {
      scheduleStopPoll();
      return;
    }
    state.runnerScheduler = status;
    renderQueueSchedulerControl();
    renderOverviewScheduler();
    if (status && status.running === true) {
      scheduleStopPoll();
      return;
    }
    stopStopPolling();
    setSchedStopping(false);
    if (el.schedStatus) {
      el.schedStatus.textContent = '调度已停止';
      el.schedStatus.className = 'muted small ok';
    }
    setPageStatus('调度已停止', 'ok');
    await refreshSchedulerSurfaces();
  }

  function startStopPolling() {
    stopPollStartedMs = Date.now();
    scheduleStopPoll();
  }



  function renderRunnerRunStatus(status) {
    if (el.runStatus) {
      let cls = 'muted small';
      const running = !!(status && status.running === true);
      // seq196：停止请求后（本地点击或刷新后由服务端 `stopping` 恢复）显示
      // “停止中…”并继续轮询，直到 running=false；不提前宣称已停止。
      if (running && status && status.stopping === true) runStopping = true;
      if (!running) runStopping = false;
      if (running) {
        cls = runStopping ? 'muted small warn' : 'muted small';
      } else if (status && status.outcome !== undefined && status.outcome !== null &&
          status.outcome !== '') {
        cls = 'muted small ' + (runnerOutcomeClass(status.outcome) === 'ok' ? 'ok' : 'err');
      } else if (status && status.error) cls = 'muted small err';
      if (running && runStopping) {
        el.runStatus.textContent = '停止中…（等当前步骤结束后退出）';
      } else {
        el.runStatus.textContent = running
          ? runnerRunningStatusText(status)
          : runnerRunStatusText(status);
      }
      el.runStatus.className = cls;
    }
    if (el.runLog) {
      const tail = status && Array.isArray(status.log_tail) ? status.log_tail : [];
      const lines = tail.slice(-RUNNER_RUN_LOG_TAIL).map(function (line) {
        return String(line === undefined || line === null ? '' : line);
      });
      el.runLog.textContent = lines.join('\n');
    }
    if (el.runError) {
      const err = status ? status.error : null;
      el.runError.textContent = err === undefined || err === null || err === ''
        ? ''
        : runnerErrorText(err);
    }
  }

  function stopRunnerRunPolling() {
    if (runPollTimer !== null) {
      clearTimeout(runPollTimer);
      runPollTimer = null;
    }
  }

  function scheduleRunnerRunPoll(delayMs) {
    stopRunnerRunPolling();
    const d = Number.isFinite(Number(delayMs)) && Number(delayMs) > 0
      ? Math.min(RUNNER_RUN_POLL_MAX_DELAY_MS, Math.max(RUNNER_RUN_POLL_MS, Number(delayMs)))
      : runPollDelayMs;
    runPollDelayMs = d;
    runPollTimer = setTimeout(pollRunnerRunOnce, d);
  }

  // seq151：页面加载/切回 Queue 时恢复当前 run 轮询（running=true 才启动 timer）。
  async function resumeRunnerRunPolling() {
    if (runRecoverInFlight || runPollTimer !== null) return;
    runRecoverInFlight = true;
    try {
      const status = await runnerFetchJson(RUNNER_API.runStatus);
      renderRunnerRunStatus(status);
      if (runnerRunStillRunning(status)) {
        runPollStartedMs = Number(status && status.started_ms) || Date.now();
        runPollDelayMs = RUNNER_RUN_POLL_MS;
        setRunBusy(true);
        scheduleRunnerRunPoll(runPollDelayMs);
      } else {
        setRunBusy(false);
      }
    } catch (e) {
      // 页面恢复失败不阻塞；用户可手动刷新。
    } finally {
      runRecoverInFlight = false;
    }
  }

  async function pollRunnerRunOnce() {
    runPollTimer = null;
    let status = null;
    try {
      status = await runnerFetchJson(RUNNER_API.runStatus);
    } catch (e) {
      // status 查询失败不是运行失败：保留运行中状态，退避重试（不放弃）。
      if (el.runError) el.runError.textContent = runnerErrorLines(e).join('\n');
      if (el.runStatus) {
        el.runStatus.textContent = '状态查询失败，仍在退避轮询…（' + runnerRunElapsedText(runPollStartedMs, Date.now()) + '）';
        el.runStatus.className = 'muted small warn';
      }
      runPollDelayMs = runnerNextRunPollDelay(runPollDelayMs);
      scheduleRunnerRunPoll(runPollDelayMs);
      return;
    }
    renderRunnerRunStatus(status);
    if (runnerRunStillRunning(status)) {
      // seq151：60s 后仍 running 继续轮询；按钮保持 disabled。
      setRunBusy(true);
      runPollDelayMs = runnerNextRunPollDelay(runPollDelayMs);
      scheduleRunnerRunPoll(runPollDelayMs);
      return;
    }
    runPollDelayMs = RUNNER_RUN_POLL_MS;
    stopRunnerRunPolling();
    setRunBusy(false);
    const text = runnerRunStatusText(status);
    setPageStatus('临时运行：' + text, text.indexOf('失败') >= 0 ? 'err' : 'ok');
    loadQueuePage();
  }

  // seq196：点击「停止运行」→ POST /runner/run/stop。200 只表示 stop token 已
  // 置位（{ok:true,stopping:true}），worker 在步骤边界退出；本函数保持“停止中…”
  // 并用既有 run status 轮询到 running=false。失败可重试（按钮重新可用）。
  async function stopRunnerRun() {
    if (!runBusy || runStopping) return;
    runStopping = true;
    if (el.runStop) {
      el.runStop.disabled = true;
      el.runStop.textContent = runnerRunStopButtonText(true);
    }
    if (el.runError) el.runError.textContent = '';
    if (el.runStatus) {
      el.runStatus.textContent = '停止中…（等当前步骤结束后退出）';
      el.runStatus.className = 'muted small warn';
    }
    try {
      await runnerFetchJson(RUNNER_API.runStop, { method: 'POST', body: {} });
      // 收到 stopping:true 后继续轮询；没有 timer（例如页面刚恢复）时补一个。
      if (runPollTimer === null) scheduleRunnerRunPoll(RUNNER_RUN_POLL_MS);
      setPageStatus('已请求停止，等待当前步骤结束…', 'warn');
    } catch (e) {
      runStopping = false;
      if (el.runStop) {
        el.runStop.disabled = !runBusy;
        el.runStop.textContent = runnerRunStopButtonText(false);
      }
      const detail = runnerErrorText(e);
      if (e && e.status === 409) {
        // 没有在跑（刚结束）或没有 cancel token：不是可重试的停止失败，
        // 拉一次状态让 UI 收敛；按钮保持可用。
        if (el.runStatus) {
          el.runStatus.textContent = '未停止：当前没有可停止的运行（刷新状态中）';
          el.runStatus.className = 'muted small warn';
        }
      } else {
        if (el.runError) el.runError.textContent = runnerErrorLines(e).join('\n');
        if (el.runStatus) {
          el.runStatus.textContent = '停止失败（可重试）：' + detail;
          el.runStatus.className = 'muted small err';
        }
      }
      if (runPollTimer === null) scheduleRunnerRunPoll(RUNNER_RUN_POLL_MS);
    }
  }

  async function submitRunnerRun() {
    if (runBusy) return;
    const parsed = runnerRunBody(
      el.runTask ? el.runTask.value : '',
      el.runParams ? el.runParams.value : ''
    );
    if (!parsed.ok) {
      if (el.runError) el.runError.textContent = '· ' + parsed.error;
      if (el.runStatus) {
        el.runStatus.textContent = '未运行：参数校验失败';
        el.runStatus.className = 'muted small err';
      }
      return;
    }
    runStopping = false;
    setRunBusy(true);
    if (el.runError) el.runError.textContent = '';
    if (el.runLog) el.runLog.textContent = '';
    if (el.runStatus) {
      el.runStatus.textContent = '已提交，等待 Runner…';
      el.runStatus.className = 'muted small';
    }
    try {
      await runnerFetchJson(RUNNER_API.run, { method: 'POST', body: parsed.body });
      if (el.runStatus) {
        el.runStatus.textContent = '运行中：' + parsed.body.task;
        el.runStatus.className = 'muted small';
      }
      setPageStatus('已提交临时运行：' + parsed.body.task, 'ok');
      runPollStartedMs = Date.now();
      runPollDelayMs = RUNNER_RUN_POLL_MS;
      scheduleRunnerRunPoll(runPollDelayMs);
    } catch (e) {
      if (el.runError) el.runError.textContent = runnerErrorLines(e).join('\n');
      if (el.runStatus) {
        const detail = runnerErrorText(e);
        const code = e && e.code ? String(e.code) : '';
        let text = '提交失败';
        if (e && e.status === 409) {
          if (code === 'device_busy' || /device_busy/.test(detail)) {
            text = '未运行：设备被占用（租约冲突）';
          } else if (code === 'run_busy' || /run_busy/.test(detail)) {
            text = '未运行：已有运行在进行';
          } else {
            text = '未运行：设备或调度锁被占用';
          }
        } else if (e && e.status === 404) {
          text = '未运行：任务不存在';
        }
        el.runStatus.textContent = text;
        el.runStatus.className = 'muted small err';
      }
      setRunBusy(false);
      // seq151：409 run_busy 不放弃——恢复对现有运行的轮询（按钮仍禁用）。
      if (e && e.status === 409 && runPollTimer === null) resumeRunnerRunPolling();
    }
  }

  // 队列页轮询：页面可见时每 5 秒刷新调度状态，
  // 离开页面即停止计时器。
  function stopQueuePolling() {
    if (queuePollTimer !== null) {
      clearInterval(queuePollTimer);
      queuePollTimer = null;
    }
  }

  function startQueuePolling() {
    stopQueuePolling();
    if (!el.schedControl) return;
    queuePollTimer = setInterval(function () {
      pollQueueRuntimeOnce();
    }, RUNNER_SCHED_POLL_MS);
  }

  // --- 运行记录 ----------------------------------------------------------------

  function renderRuns() {
    if (!el.runsList) return;
    const body = state.runs || {};
    const runs = Array.isArray(body.runs) ? body.runs : [];
    if (el.runsStatus) {
      el.runsStatus.textContent = '共 ' + (body.count !== undefined ? body.count : runs.length) +
        ' 条 · 目录：' + runnerValueText(body.dir);
    }
    if (!runs.length) {
      el.runsList.textContent = '暂无运行记录';
      return;
    }
    const rows = runs.map(function (run) {
      const r = run || {};
      const fullError = runnerErrorText(r.error);
      return [
        runnerTimeText(r.started_ms),
        runnerValueText(r.task),
        runnerValueText(r.kind),
        runnerValueText(r.round),
        runnerMemberText(r.member_index),
        makeBadge(runnerValueText(r.outcome), runnerOutcomeClass(r.outcome)),
        runnerExitText(r),
        runnerDurationText(runnerRunDurationMs(r)),
        runnerClicksText(r.clicks),
        {
          text: runnerErrorSummary(r.error, 120) || '—',
          cls: fullError ? 'runner-error-cell' : '',
          title: fullError,
        },
      ];
    });
    renderTable(
      el.runsList,
      ['时间', '任务', 'kind', 'round', 'member', 'outcome', 'exit_code', 'duration', 'clicks', 'error'],
      rows,
      '暂无运行记录'
    );
  }

  async function loadRunsPage() {
    try {
      state.runs = await runnerFetchJson(RUNNER_API.schedulerRuns + '?limit=' + RUNNER_RUNS_LIMIT);
      renderRuns();
      return [];
    } catch (e) {
      state.runs = null;
      const message = runnerRunsErrorText(runnerErrorText(e));
      if (el.runsStatus) el.runsStatus.textContent = message;
      if (el.runsList) el.runsList.textContent = message;
      return [message];
    }
  }

  // --- 设置 --------------------------------------------------------------------

  function renderSettings() {
    const configBody = state.config;
    const cfg = configBody && configBody.config && typeof configBody.config === 'object'
      ? configBody.config
      : null;
    const health = state.health || {};

    if (!cfg) {
      renderKv(el.settingsDevice, []);
      renderKv(el.settingsPaths, []);
      renderKv(el.settingsServe, []);
      renderKv(el.settingsRunner, []);
      renderKv(el.settingsScheduler, []);
      if (el.settingsConfigJson) el.settingsConfigJson.textContent = '—';
    } else {
      const device = cfg.device || {};
      renderKv(el.settingsDevice, [
        ['serial', runnerValueText(device.serial)],
        ['adb_path', runnerValueText(device.adb_path)],
      ]);

      const paths = cfg.paths || {};
      renderKv(el.settingsPaths, [
        ['tasks_dir', runnerValueText(paths.tasks_dir || health.tasks_dir)],
        ['runs_dir', runnerValueText(paths.runs_dir || health.runs_dir)],
        ['library_dir', runnerValueText(paths.library_dir)],
      ]);

      const serve = cfg.serve || {};
      renderKv(el.settingsServe, [
        ['port', runnerValueText(serve.port)],
        ['bind', runnerValueText(serve.bind)],
        ['ui', runnerValueText(serve.ui)],
      ]);

      const runner = cfg.runner || null;
      renderKv(el.settingsRunner, [
        ['port', runner ? runnerValueText(runner.port) : runnerValueText(health.port)],
        ['bind', runner ? runnerValueText(runner.bind) : '—'],
        ['来源', runner ? 'config/live.json 的 runner 段' : '配置未声明（使用运行时端口）'],
      ]);

      const scheduler = cfg.scheduler || {};
      renderKv(el.settingsScheduler, [
        ['plan', runnerValueText(scheduler.plan)],
        ['state', runnerValueText(scheduler.state)],
        ['report', runnerValueText(scheduler.report)],
      ]);

      if (el.settingsConfigJson) {
        try {
          el.settingsConfigJson.textContent = JSON.stringify(cfg, null, 2);
        } catch (e) {
          el.settingsConfigJson.textContent = '—';
        }
      }
    }

    const instanceBody = state.instance;
    if (instanceBody) {
      const inst = instanceBody || {};
      const instState = inst.state || {};
      renderKv(el.settingsInstance, [
        ['active', runnerValueText(inst.active)],
        ['name', runnerValueText(inst.name)],
        ['device_serial', runnerValueText(inst.device_serial)],
        ['adb_path', runnerValueText(inst.adb_path)],
        ['serve_port', runnerValueText(inst.serve_port)],
        ['bind', runnerValueText(inst.bind)],
        ['device', runnerValueText(instState.device)],
        ['error', runnerValueText(instState.error)],
      ]);
    } else {
      renderKv(el.settingsInstance, []);
    }

    if (el.settingsStatus) {
      el.settingsStatus.textContent = '只读读取自 /config 与 /instance';
    }
  }

  async function loadSettingsPage() {
    const errors = [];
    try {
      state.config = await runnerFetchJson(RUNNER_API.config);
    } catch (e) {
      state.config = null;
      errors.push('配置读取失败：' + runnerErrorText(e));
    }
    try {
      state.instance = await runnerFetchJson(RUNNER_API.instance);
    } catch (e) {
      state.instance = null;
      errors.push('实例读取失败：' + runnerErrorText(e));
    }
    renderSettings();
    if (errors.length && el.settingsStatus) el.settingsStatus.textContent = errors.join('；');
    return errors;
  }

  // --- 页面切换 / 刷新 ----------------------------------------------------------

  function showPage(name) {
    const page = RUNNER_PAGES.indexOf(name) >= 0 ? name : 'overview';
    state.page = page;
    if (page === 'queue') {
      startQueuePolling();
      // seq151：从其它页切回 Queue 时恢复当前 run 轮询。
      resumeRunnerRunPolling();
    } else stopQueuePolling();
    for (const pane of el.pages) {
      pane.classList.toggle('active', pane.id === 'page-' + page);
    }
    for (const button of el.navButtons) {
      button.classList.toggle('active', button.getAttribute('data-page') === page);
    }
    document.title = 'OAS Runner（使用端）· ' + (RUNNER_PAGE_LABELS[page] || '概览');
    // 便于未来 Android WebView 深链；history 在 file/嵌入式环境
    // 可能不可用，因此必须保持 best-effort。
    try {
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', '#' + page);
      }
    } catch (e) {
      /* 忽略：hash 同步仅为视觉效果 */
    }
  }

  function pageFromHash() {
    try {
      const raw = String(window.location.hash || '').replace(/^#/, '').trim();
      return RUNNER_PAGES.indexOf(raw) >= 0 ? raw : '';
    } catch (e) {
      return '';
    }
  }

  async function refreshCurrentPage() {
    if (state.busy) {
      state.queued = true;
      return;
    }
    setFetching(true);
    setPageStatus('读取中…');
    const errors = [];
    try {
      const healthError = await refreshHealth();
      if (healthError) errors.push(healthError);
      // P0-1a：通知角标需在每个页面保持最新；卡片
      // itself lives on 安装包, so its read error only pollutes that page.
      const updatesError = await loadRunnerUpdates();
      if (state.page === 'packages' && updatesError) errors.push(updatesError);
      let pageErrors = [];
      if (state.page === 'overview') pageErrors = await loadOverview();
      else if (state.page === 'tasks') pageErrors = await loadTasksPage();
      else if (state.page === 'packages') pageErrors = await loadPackagesPage();
      else if (state.page === 'queue') pageErrors = await loadQueuePage();
      else if (state.page === 'runs') pageErrors = await loadRunsPage();
      else if (state.page === 'settings') pageErrors = await loadSettingsPage();
      for (const message of pageErrors) errors.push(message);
      updateLastRefresh();
      if (errors.length) setPageStatus(errors.join('；'), 'err');
      else setPageStatus('已刷新', 'ok');
    } catch (e) {
      setPageStatus('刷新失败：' + runnerErrorText(e), 'err');
    } finally {
      setFetching(false);
      if (state.queued) {
        state.queued = false;
        refreshCurrentPage();
      }
    }
  }

  function bindEvents() {
    // PR7：旧 Studio 调度绑定（页面/对话框/运行过滤）。
    if (btnSchedRefresh) btnSchedRefresh.addEventListener('click', function () { refreshScheduler(); });
    if (btnSchedReset) btnSchedReset.addEventListener('click', openResetMemoryDialog);
    if (btnSchedOpenPage) {
      btnSchedOpenPage.addEventListener('click', function () {
        if (!pageSchedEntries || typeof pageSchedEntries.scrollIntoView !== 'function') return;
        try { pageSchedEntries.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { /* cosmetic */ }
      });
    }
    if (pageSchedRefresh) pageSchedRefresh.addEventListener('click', function () { refreshCurrentPage(); });
    if (pageSchedReload) pageSchedReload.addEventListener('click', function () { refreshCurrentPage(); });
    if (pageSchedReset) pageSchedReset.addEventListener('click', openResetMemoryDialog);
    if (pageSchedSave) pageSchedSave.addEventListener('click', saveSchedulePageConfig);
    if (pageSchedAddEntry) pageSchedAddEntry.addEventListener('click', openScheduleAddEntryDialog);
    if (pageSchedAddQueue) pageSchedAddQueue.addEventListener('click', function () { openScheduleQueueDialog(''); });
    if (pageSchedJsonSave) pageSchedJsonSave.addEventListener('click', saveScheduleJson);
    if (pageSchedJsonReload) pageSchedJsonReload.addEventListener('click', reloadScheduleJson);
    if (pageSchedJson) {
      pageSchedJson.addEventListener('input', function () {
        scheduleJsonDirty = true;
        if (pageSchedJsonStatus) pageSchedJsonStatus.textContent = '有未保存修改（用「保存 JSON」写入）';
      });
    }
    if (pageSchedRunsRefresh) pageSchedRunsRefresh.addEventListener('click', function () { refreshScheduleRuns(); });
    if (pageSchedRunsTask) {
      pageSchedRunsTask.addEventListener('change', function () {
        scheduleRunsFilter.task = pageSchedRunsTask.value;
        scheduleRunsFilter.queueId = '';
        syncScheduleRunsControls();
        refreshScheduleRuns();
      });
    }
    if (pageSchedRunsOutcome) {
      pageSchedRunsOutcome.addEventListener('change', function () {
        scheduleRunsFilter.outcome = pageSchedRunsOutcome.value;
        syncScheduleRunsControls();
        refreshScheduleRuns();
      });
    }
    if (pageSchedRunsLimit) {
      pageSchedRunsLimit.addEventListener('change', function () {
        scheduleRunsFilter.limit = schedRunLimitValue(pageSchedRunsLimit.value);
        syncScheduleRunsControls();
        refreshScheduleRuns();
      });
    }
    if (pageSchedRunsClear) {
      pageSchedRunsClear.addEventListener('click', function () {
        scheduleRunsFilter.task = '';
        scheduleRunsFilter.outcome = '';
        scheduleRunsFilter.queueId = '';
        syncScheduleRunsControls();
        refreshScheduleRuns();
      });
    }
    if (schedRunDialogClose) schedRunDialogClose.addEventListener('click', closeScheduleRunDetail);
    if (schedRunDialogRefresh) {
      schedRunDialogRefresh.addEventListener('click', function () {
        if (scheduleRunDetailRunId) openScheduleRunDetail(scheduleRunDetailRunId);
      });
    }
    if (schedEntryKind) {
      schedEntryKind.addEventListener('change', function () {
        populateScheduleEntryTargets(schedEntryKind.value, '');
        updateScheduleEntryTargetHint();
      });
    }
    if (schedEntryTarget) schedEntryTarget.addEventListener('change', updateScheduleEntryTargetHint);
    if (schedEntryLifecycle) schedEntryLifecycle.addEventListener('change', updateScheduleEntryLifecycleUi);
    if (schedEntryCancel) {
      schedEntryCancel.addEventListener('click', function () {
        if (schedEntryDialog) schedEntryDialog.close();
      });
    }
    if (schedEntrySave) schedEntrySave.addEventListener('click', saveScheduleEntryDialog);
    if (schedQueueMemberAddBtn) {
      schedQueueMemberAddBtn.addEventListener('click', function () {
        const st = scheduleQueueDialogState;
        if (!st || !schedQueueTaskPool) return;
        const checked = Array.from(
          schedQueueTaskPool.querySelectorAll('input[type=checkbox]:checked')
        ).map(function (cb) { return cb.value; });
        for (const task of checked) st.members = schedQueueMemberAdd(st.members, task);
        renderScheduleQueueMembers();
        renderScheduleQueuePool();
      });
    }
    if (schedQueueTotalRounds) schedQueueTotalRounds.addEventListener('input', updateScheduleQueueRoundsHint);
    if (schedQueueCancel) {
      schedQueueCancel.addEventListener('click', function () {
        if (schedQueueDialog) schedQueueDialog.close();
      });
    }
    if (schedQueueSave) schedQueueSave.addEventListener('click', saveScheduleQueueDialog);
    if (btnResetAll) btnResetAll.addEventListener('click', function () { resetTaskChecks('all'); });
    if (btnResetInvert) btnResetInvert.addEventListener('click', function () { resetTaskChecks('invert'); });
    if (btnResetNone) btnResetNone.addEventListener('click', function () { resetTaskChecks('none'); });
    if (btnResetSubmit) btnResetSubmit.addEventListener('click', submitResetMemory);
    if (btnResetCancel) {
      btnResetCancel.addEventListener('click', function () {
        if (resetMemoryDialog) resetMemoryDialog.close();
      });
    }
    if (el.refresh) el.refresh.addEventListener('click', function () { refreshCurrentPage(); });
    if (el.healthRefresh) el.healthRefresh.addEventListener('click', function () { refreshCurrentPage(); });
    if (el.tasksRefresh) el.tasksRefresh.addEventListener('click', function () { refreshCurrentPage(); });
    if (el.packagesRefresh) el.packagesRefresh.addEventListener('click', function () { refreshCurrentPage(); });
    if (el.updatesRefresh) el.updatesRefresh.addEventListener('click', function () { loadRunnerUpdates(); });
    if (el.installSubmit) el.installSubmit.addEventListener('click', function () { installRunnerPackage(); });
    if (el.queueRefresh) el.queueRefresh.addEventListener('click', function () { refreshCurrentPage(); });
    if (el.schedStart) el.schedStart.addEventListener('click', function () { startRunnerScheduler(); });
    if (el.schedStop) el.schedStop.addEventListener('click', function () { stopRunnerScheduler(); });
    if (el.schedRefresh) el.schedRefresh.addEventListener('click', function () { refreshCurrentPage(); });
    if (el.runSubmit) el.runSubmit.addEventListener('click', function () { submitRunnerRun(); });
    if (el.runStop) el.runStop.addEventListener('click', function () { stopRunnerRun(); });
    if (el.overviewGotoQueue) {
      el.overviewGotoQueue.addEventListener('click', function () {
        showPage('queue');
        refreshCurrentPage();
      });
    }
    if (el.runsRefresh) el.runsRefresh.addEventListener('click', function () { refreshCurrentPage(); });
    if (el.settingsRefresh) el.settingsRefresh.addEventListener('click', function () { refreshCurrentPage(); });
    if (el.configSave) el.configSave.addEventListener('click', function () { saveRunnerConfig(); });
    if (el.configClose) el.configClose.addEventListener('click', closeRunnerConfigDialog);
    if (el.configForm) {
      el.configForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        saveRunnerConfig();
      });
    }
    if (el.configDialog) {
      el.configDialog.addEventListener('close', function () {
        configTask = '';
        configLoaded = false;
        configBusy = false;
      });
    }
    for (const button of el.navButtons) {
      button.addEventListener('click', function () {
        const page = button.getAttribute('data-page');
        if (page === state.page) {
          refreshCurrentPage();
          return;
        }
        showPage(page);
        refreshCurrentPage();
      });
    }
    window.addEventListener('hashchange', function () {
      const page = pageFromHash();
      if (!page || page === state.page) return;
      showPage(page);
      refreshCurrentPage();
    });
  }

  function init() {
    bindElements();
    bindEvents();
    // seq196：默认没有运行 → 停止按钮禁用；若刷新时确有运行，run status 轮询
    // 会立刻把按钮恢复为可用（resumeRunnerRunPolling）。
    setRunBusy(false);
    showPage(pageFromHash() || 'overview');
    setPageStatus('连接中…');
    refreshCurrentPage();
    // P0-1a：仅在 Runner UI 可见时轮询 Studio 发布通知；
    // 隐藏标签页停止计时器（无后台轮询线程）。
    startUpdatesPolling();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        stopUpdatesPolling();
        return;
      }
      startUpdatesPolling();
      pollRunnerUpdatesOnce();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
