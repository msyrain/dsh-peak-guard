# dsh-peak-guard — DeepSeek 峰谷计费守卫

一个 DSH（DeepSeek Harness）插件：在 DSH 调用 DeepSeek 模型之前判断当前处于**高峰时段**还是**空闲时段**，并在高峰时段**弹窗询问是否确认调用**；同时在 Web GUI **左侧边栏「设置」上方**提供一个显示插件名称与**启用/禁用开关**的条目。

- 拦截面：`ctx.llm` 的 `llm/stream` 瀑布事件 —— 覆盖主对话循环、子智能体、compaction 摘要、会话标题等**所有**模型调用。
- 拒绝即零成本：未确认时**不调用** `next()`，适配器不会被构造，不产生任何网络请求与计费。
- 侧边栏开关：一键启用/禁用，状态持久化到磁盘，重启后保持。
- 无构建步骤：宿主半部是纯 ESM JavaScript；浏览器半部由随附的约 150 行构建脚本生成，不依赖 monorepo 构建链。

## 峰谷规则（现行，官方口径）

DeepSeek 现行定价页脚注（[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)，2026-09-10 核对）：

> Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other hours are off-peak).
>
> 空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。

即：

| 时段 | 北京时间 | 计价 |
|---|---|---|
| **高峰** | 周一至周五 09:00–12:00、14:00–18:00 | 标准价 |
| **空闲** | 周一至周五其余时间；**周六、周日全天** | 标准价的 **50%** |

> ⚠️ 旧的「每日 00:30–08:30 错峰优惠」已于 2026-08-17 被峰谷规则取代，2026-08-23 起周末全天按空闲价。若你的账户仍按旧规则计费，用配置项 `peakWindows` 改回即可（见下文）。

**一个明确假设**：官方没有说明峰谷按「调用发起时刻」还是「完成/账单时刻」判定。本插件按**调用发起时刻**判定，并在每次询问中都把这一假设写给用户看。

## 安装

插件在**用户 ESM 解析路径之外**时无法解析 `@deepseek-ai/*` 依赖，因此安装方式是把插件放进 profile 目录（用目录联接/junction 指向本仓库，或直接复制）：

```powershell
cd F:\DSH峰谷插件

node install.mjs                 # 开发模式：在 web profile 里建 junction 指向本目录
node install.mjs --copy          # 交付模式：把运行文件复制进 profile
node install.mjs --uninstall     # 卸载（移除 patch 行与安装目录）
node install.mjs --profile web --dsh-home D:\other-dsh
```

安装器只改 profile 自己的 `cordis.patch.yml`，且只动它自己那一段标记块，不会碰你已有的其他 patch：

```yaml
# >>> dsh-peak-guard (managed by install.mjs) >>>
- insert:
    - id: peak-guard
      name: './dsh-peak-guard/index.js'
# <<< dsh-peak-guard <<<
```

配套的 `cordis.patch.yml`（本包根目录）声明了 `dsh.bundle`，所以也可以用 DSH 官方方式把整个包作为**组合包**安装：

```powershell
dsh plugin --profile web add F:\DSH峰谷插件
```

两种方式的取舍：`dsh plugin add` 是标准分发路径，但会由 pnpm 安装并在**下次启动**才加入层栈；`node install.mjs` 的 junction 方式对开发最省事，且 `web` profile 的 `patchReload: live` 会让 patch 行**免重启**生效。

### ⚠️ 安装目录是一份副本，改动不会自动过去

这是本项目最容易踩的坑，务必先读：

| 安装方式 | 安装目录是什么 | 改工作区后 |
|---|---|---|
| `node install.mjs`（联接） | 指向本仓库的目录联接（junction） | **自动生效**，无需任何操作 |
| `node install.mjs --copy` | 一份**真实副本** | **不会自动过去**，必须同步 |
| `dsh plugin add` | pnpm 安装的副本 | 不会自动过去 |

副本模式下，工作区的改动不会过去，而且**失败是静默的**：宿主半部继续从旧副本工作、浏览器半部继续提供旧 bundle，表现就是「我明明改了却好像没生效」。同步命令：

```powershell
node sync.mjs          # 报出漂移并重新复制运行文件
node sync.mjs --check  # 只报漂移、不写入；有漂移时退出码为 1
```

同步后仍需**刷新页面**：浏览器 bundle 是按内容寻址的，页面在加载时（或通过客户端 HMR 通道）才会取到新版本。

> 开发时建议用**联接模式**（`node install.mjs`，不带 `--copy`），此时 `sync.mjs` 会直接告诉你「已是联接，无需同步」，每次改动都是实时的，只剩刷新页面这一步。

> ⚠️ **浏览器半部需要刷新页面**：宿主半部（含侧边栏开关的 API 路由）随 patch 热加载立即生效；而 `lib/client.js` 是被写入页面启动清单（`window.__DSH_BOOT__`）的，所以新增/修改浏览器半部后需要**重启 dsh 服务并刷新页面**。修改 `src/client.js` 后记得先跑 `npm run build:client`（`node scripts/build-client.mjs`）。

> ⚠️ 安装目录路径中若含非 ASCII 字符（如 `F:\DSH峰谷插件`），请**只用 `install.mjs` 建联接**。Windows PowerShell 5.1 创建 junction 时会把中文路径按 ANSI 码页转写，得到一个乱码的目标路径（功能上仍可解析，但显示与排错都很糟糕）。

### 验证

```powershell
dsh --profile web --dump-config | Select-String peak
```

应能看到 `# == C:\Users\rain\.dsh\profiles\web\cordis.patch.yml` 层下的 `- id: peak-guard`。

浏览器侧可确认产物已被收录并可通过 combo 路由取到。该路由只认启动清单（`window.__DSH_BOOT__`）里的完整 URL，所以直接请求 `/plugins/dsh-peak-guard/client.js` 会 404；从页面 HTML 里取出 `dsh-peak-guard/client.js&rev=...` 那段再请求即可：

```powershell
Invoke-WebRequest 'http://127.0.0.1:3080/plugins/??dsh-peak-guard/client.js&rev=<rev>' | Select-Object StatusCode
```

### 卸载

- junction 模式：`node install.mjs --uninstall`（先删 junction 再删 patch 行；**不要**用资源管理器递归删除，那会跟进源码目录）。
- 组合包模式：`dsh plugin --profile web remove dsh-peak-guard`。

## 工作流程

```
模型调用 → llm/stream 瀑布
              └─ peak-guard 判定 provider/model 是否命中
                   ├─ 不命中（非 DeepSeek / 非目标模型 / 辅助调用）→ 直接放行
                   ├─ 命中且空闲时段 → 记录日志（可选注入通知）→ 直接放行
                   └─ 命中且高峰时段 → 询问用户
                          ├─ 「确认调用」→ 本次放行，并记住这个窗口的批准
                          └─ 「稍后重试」→ 不调用 next()，返回终止 finish 块（不产生费用）
```

拒绝时返回的是终止错误块：

```js
{ type: 'finish', reason: { kind: 'error',
  failure: { message: '…', code: 'PEAK_HOUR_DECLINED' } } }
```

`PEAK_HOUR_DECLINED` 刻意不在 `dsh-llm-retry` 的默认可重试码集合内（`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`），因此默认不会自动重试；同时插件会记住决策，避免 `retryPolicy.mode: 'always'` 把它变成反复弹窗。

拒绝消息会给出**可执行**的信息，而不只是「不行」：

```
[dsh-peak-guard] 本次调用处于高峰时段（16:30 Thu Asia/Shanghai），已按你的选择中止。
下次空闲时段 18:00（约 1 小时 30 分钟后）。如需现在调用，可在左侧边栏关闭
「峰谷计费守卫」，或调整插件配置。
```

其中「下次空闲时段」是插件**逐分钟推算**出来的真实转换点（`nextOffPeak`），不是「高峰时段以外的时间」这种无用描述。如果时段配置本身覆盖了整天，它会说明「一天以上」而不是空转。

### 询问频率

默认 `askScope: 'window'` + `suppressRepeatAsks: true`：**每个高峰时段只问一次**。你在上午高峰点过一次「确认调用」，该窗口剩下的所有调用都会直接放行；进入下午高峰（或第二天）会重新问一次；点「稍后重试」则在该窗口内持续中止。

想恢复成「每次调用都问」，把 `askScope` 设为 `call`；想完全关闭记忆，设 `suppressRepeatAsks: false`。

### 侧边栏开关

Web GUI **左侧边栏底部**会出现一行 `峰谷计费守卫`，位于「DSH 更新」与「设置」**上方**：宽边栏显示插件名 + 当前峰谷状态 + 开关，折叠为窄轨时显示为一个状态点（红=高峰、绿=空闲、灰=关闭）。

- 点击即切换启用/禁用。禁用后守卫**完全不介入**，所有模型调用直接放行。
- 状态写入插件目录下的 `.peak-guard-state.json`，重启后保持；配置文件里的 `enabled` 只作为「从未切换过」时的初始值。
- **该状态属于部署、不属于仓库**，已在 `.gitignore` 中排除。它也是测试最容易踩的坑：状态为禁用时，所有断言都会退化成「放行」，看起来像通过其实什么都没测。因此测试一律使用自己的临时状态文件（`statePath` 指向临时目录），绝不读写真实安装目录里的那一份。
- 想恢复成「配置说了算」，删掉该文件即可（下次加载会重新采用 `enabled` 的默认值）。
- 开关通过宿主侧路由 `GET/POST /api/peak-guard/state` 读写（与 DSH 自带的更新器面板同一条通道）。该路由受 DSH 的浏览器会话防护保护，因此只有你自己的浏览器能改。
- 宿主侧的 `/api/peak-guard/state` 只会在 `webServer` 服务**激活之后**挂载。`ctx.get()` 在 cordis 里是 strict 的（提供者 fiber 未激活即返回 `undefined`），所以这里用 `ctx.inject(['webServer'], …)` 等待服务，而不是在 `apply` 里直接取。挂载结果会写到 `.peak-guard-state.json.boot.json`，便于离线排错。

> 布局说明：边栏页脚的动作槽（`.footerActions`）本身是**不可换行的横向 flex 行**，同槽位的每个条目都会被强制并排。本插件注入一条作用域 CSS 把该容器改为可换行，并让自己的行占满一整行且 `order: -1`，从而落到「DSH 更新」上方。该规则用 `[class*="footerActions"]` 匹配边栏的哈希类名；若上游改了类名哈希，本行会**退化为与「DSH 更新」并排**（功能不受影响），不会弄坏侧边栏。

### 用哪条通道询问

按顺序尝试，任一条可用即可：

1. **`ctx.approval`（审批面板）** — 仅当该会话的审批策略为 `ask` 时使用。策略为 `never` 时该服务会在分发前直接判定 `rejected`，插件会跳过它，避免为一个用户根本没做的决定写入审批审计对。
2. **`ctx.userQuestions`（问答面板）** — 独立的交互通道，不受审批策略影响。这也解释了为什么在 `danger-full-access`（审批策略固定为 `never`）的会话里，确认面板依然能弹出来。
3. **都不可用** — 按 `unaskableAction` 决定：`proceed`（默认，放行并在会话里注入一条明确通知）或 `block`（中止本次调用）。

子智能体默认不询问（`localAgentsOnly: true`）：子智能体是同一循环上的普通 Agent，询问它们会卡住委派；放行并记日志更实用。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `peak-guard` 行的 `config`（**整段替换**，不是深合并，所以要么只写你要改的键并依赖 schema 默认值，要么写完整个需要的键）：

```yaml
- id: peak-guard
  name: './dsh-peak-guard/index.js'
  config:
    requireConfirmation: true
    notifyOffPeak: true
    peakWindows:
      - start: '09:00'
        end: '12:00'
        weekdaysOnly: true
        label: 上午高峰
      - start: '14:00'
        end: '18:00'
        weekdaysOnly: true
        label: 下午高峰
    timeZone: 'Asia/Shanghai'
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 配置里的初始总开关；侧边栏一旦切换过，以持久化的运行时开关为准。 |
| `providerPatterns` | `['deepseek-*']` | 命中哪些 provider 路由；glob（`*` 为通配）。 |
| `modelPatterns` | `['deepseek-*']` | 命中哪些模型 id。 |
| `peakWindows` | 周一至周五 `09:00–12:00`、`14:00–18:00` | 高峰时段列表。`start` 含、`end` 不含；`end` 不大于 `start` 表示跨午夜；`weekdaysOnly: true` 表示仅周一至周五（周末因此整天为空闲）。 |
| `offPeakWindows` | `[]` | 显式的空闲时段例外，优先级高于 `peakWindows`（用于法定节假日等）。 |
| `timeZone` | `'Asia/Shanghai'` | 时段所依据的 IANA 时区（北京时间固定 UTC+8，无夏令时）。 |
| `requireConfirmation` | `true` | `false` = 只提醒不询问，高峰也直接放行。 |
| `gateAuxiliary` | `false` | 是否连会话标题、compaction 摘要等辅助调用一起询问。 |
| `notifyOffPeak` | `false` | 空闲时段调用是否也注入一条会话通知（默认只写日志）。 |
| `unaskableAction` | `'proceed'` | 无可用确认通道时：`proceed` 放行并通知，`block` 中止。 |
| `askTimeoutMs` | `0` | 确认等待上限（毫秒）；**`0` = 不设超时**，一直等到用户作答、请求取消或插件卸载。设为正数后超时按 `unaskableAction` 处理。 |
| `suppressRepeatAsks` | `true` | 是否记住已作出的决策。 |
| `askScope` | `'window'` | `window` = 每个高峰时段只问一次（默认）；`call` = 每次模型调用都问。 |
| `localAgentsOnly` | `true` | `true` 表示只为主 Agent 询问，子智能体直接放行。 |
| `showPrices` | `true` | 询问文案中是否附价格对比。 |
| `pricing` | 见下 | 价格表，仅用于展示，不参与判定。 |
| `statePath` | 插件目录下 `.peak-guard-state.json` | 侧边栏开关的持久化文件路径。 |

### 价格表默认值（元 / 百万 token，2026-09-10 核对）

| 匹配 | 模型 | 高峰 输入/输出 | 空闲 输入/输出 |
|---|---|---|---|
| `*/deepseek-flash` | deepseek-flash（V4.1-Flash） | ¥2 / ¥8 | ¥1 / ¥4 |
| `*/deepseek-v4-pro` | deepseek-v4-pro（V4-Pro-0813） | ¥9 / ¥27 | ¥4.5 / ¥13.5 |

缓存命中输入价另计（flash：高峰 ¥0.04 / 空闲 ¥0.02）。这张表只是**展示用默认值**，DeepSeek 保留调价权利，实际账单以官方页面为准。

### 切换回 2025 年的旧规则

```yaml
config:
  peakWindows: []                                     # 没有高峰时段
  offPeakWindows:
    - start: '00:30'
      end: '08:30'                                    # 每日 00:30–08:30 为错峰
```

⚠️ 注意这套配置下「高峰 = 全部时间」，因为高峰列表为空且询问仍开启时，除 `offPeakWindows` 之外的所有时刻都算高峰 —— 这正是「只在错峰时段鼓励调用、其余时间都确认」的语义。

## 测试

```powershell
npm test                          # 等价于 node --test "tests/*.test.js"
npm run build:client              # 改过 src/client.js 后重新生成 lib/client.js
npm run sync                      # 副本安装模式：把改动同步进安装目录
npm run sync:check                # 只报漂移，不写入
```

共 69 项，全部离线、确定性：

- `tests/peak.test.js` — 时区换算、窗口边界（含跨午夜与周末）、glob 匹配、价格选择、决策分支、配置校验。
- `tests/gate.test.js` — 用假 Cordis 上下文驱动真实的 `llm/stream` 监听器：放行路径、审批通道、问答通道（含两种历史返回结构）、拒绝时的终止块、无通道降级、子智能体、决策记忆、信号取消、卸载排空、配置报错。
- `tests/switch.test.js` — 开关的持久化与容错、`/api/peak-guard/state` 的 GET/POST/405/400、关掉后守卫确实不介入。
- `tests/client.test.js` — 按客户端模块契约真实执行 `lib/client.js`：注册 id、导出面、注册槽位、样式与布局锚点（含 `box-sizing` 防御规则）、构建标识是否已代入、宽/窄两种形态渲染、关闭态与不可达回退。

## 已知限制

- **判定时刻是假设**：按调用发起时刻分类，官方未定义口径。
- **辅助调用默认不拦截**：会话标题与 compaction 摘要默认放行（`gateAuxiliary: true` 可开启）。
- **价格表会过期**：它只影响展示。
- **子智能体默认不询问**：见 `localAgentsOnly`。
- **确认面板呈现是通用的**：询问复用 DSH 自带的审批/问答面板，因此面板标题呈现为 `llm.call`，完整信息（模型路由、时间、峰谷窗口、价格）在面板正文里。
- **侧边栏条目是宿主侧自绘的**：它不复用 DSH 设置页的组件，只注册到 `sidebar.footer.action`（「设置」上方）这一个槽位。该槽位默认不可换行，本插件用一条作用域 CSS 让它换行以便堆叠；若上游改了类名哈希，本行会退化为与「DSH 更新」并排（功能不受影响）。
- **代码改动需要重启 + 刷新**：patch 行实时生效，但模块热替换在随附组合里是关闭的；浏览器半部的改动还需要刷新页面。副本安装模式下还必须先 `node sync.mjs`。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Cordis 插件入口：`llm/stream` 监听器、确认通道选择、拒绝块、决策记忆、状态路由、生命周期。 |
| `src/peak.js` | 纯函数：时区字段、窗口判定、分类、glob 匹配、价格选择、询问文案。 |
| `src/config.js` | 默认值、严格校验、Schemastery schema。 |
| `src/client.js` | 浏览器半部源码：侧边栏「设置」上方的名称 + 启用/禁用开关。 |
| `lib/client.js` | 由 `scripts/build-client.mjs` 生成的客户端产物（受版本管理，安装即可用）。 |
| `scripts/build-client.mjs` | 把 `src/client.js` 包成 DSH 客户端模块系统要求的 CJS 工厂产物。 |
| `cordis.patch.yml` | 组合包层（`dsh.bundle` 指向它）。 |
| `install.mjs` | 安装/卸载到 profile（junction 或复制）。 |
| `sync.mjs` | 副本安装模式下，把工作区的运行文件同步到安装目录；`--check` 只报漂移。 |
| `tests/*.test.js` | 离线测试。 |
