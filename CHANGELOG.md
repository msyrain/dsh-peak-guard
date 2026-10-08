# 更新日志 / Changelog

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### 变更 / Changed

- **删除无消费者的配置 schema**：`src/config.js` 的 `loadConfigSchema()` 与 `index.js`
  里的探测调用一并删除。它的返回值没有任何读者——插件并不导出加载器约定的 `Config`，
  所以既没有插件内消费者，也没有框架消费者——却把 `DEFAULTS` 的整张默认值表又抄了一遍，
  正是模块注释声称要避免的那种漂移。默认值与校验从此只有 `normalizeConfig()` 一个权威，
  非法 `config` 依旧在加载时抛错。
- **删除未被引用的常量** `LEGACY_OFF_PEAK_WINDOW`：旧规则的表达方式是用户在自己的
  patch 里写 `offPeakWindows: [{ start: '00:30', end: '08:30' }]`，README 一直这么教；
  代码里的那份常量没有任何引用，模块头部的 `{@link LEGACY_WINDOW}` 还是个错名字。
  头部注释改为说明这条规则该怎么写出来。
- **合并重复实现**：`install.mjs` 与 `sync.mjs` 各自手抄了一份相同的 `isLink()`、
  `INSTALL_DIR_NAME` 与 `DSH_HOME` 默认值，现统一到 `scripts/profile-paths.mjs`。
  两个脚本必须对「插件装在哪个目录」「那里是联接还是副本」给出同一个答案。
- **去掉冗余判断**：`readRuntimeState()` 先 `existsSync()` 再读文件，而外层 `try/catch`
  早已把「文件不存在」归入同一种答案（从未切换过），少一次系统调用。
- **合并重复文案**：两条拒绝路径各自拼一遍「如何立即调用」的说明与 `offPeakHint()`，
  现由 `refusePeak()` 生成。

### 修正 / Fixed

- **文档里的测试数量**：README（中英）、CONTRIBUTING 与 CHANGELOG 都写「72 项」，
  实际是 78 项，已按实际数量修正。

无行为变更：78 项测试全部通过，`lib/client.js` 逐字节未变（`build:client:check` 通过）。

## [0.2.0] - 2026-09-11

首个公开版本。

> 版本号从 `0.2.0` 起：`0.1.0` 只在开发过程中短暂存在（当时的侧边栏开关尚未落地），
> 从未发布。因此这里把截至首次公开的全部能力一并记为 `0.2.0`。

### 新增 / Added

- **峰谷守卫本体**：拦截 `ctx.llm` 的 `llm/stream` 瀑布事件，覆盖主对话循环、
  子智能体、compaction 摘要、会话标题等**所有**模型调用。
- **高峰时段确认**：命中高峰且命中目标 provider/model 时询问用户；选「稍后重试」
  则中止本次调用，且**不调用** `next()` —— 适配器不会被构造，不产生任何请求与计费。
- **两条确认通道**：会话审批策略为 `ask` 时走 `ctx.approval`；否则走
  `ctx.userQuestions`（审批策略为 `never` 时前者会在分发前直接判定 `rejected`，
  走它会为一个用户没做的决定写入审计对）。
- **侧边栏开关**：位于「设置」上方的名称行与启用/禁用开关，状态持久化到磁盘并在
  重启后保持；宿主侧路由 `GET/POST /api/peak-guard/state` 读写。
- **浏览器半部**：`src/client.js` 经 `scripts/build-client.mjs` 生成 DSH 客户端模块
  系统要求的 CJS 工厂产物 `lib/client.js`，不依赖 monorepo 构建链。
- **安装与同步工具**：`install.mjs` 支持联接（junction）与副本两种安装方式，
  `sync.mjs` 负责把工作区改动同步进副本安装（`--check` 只报漂移）。
- **配置项**：`peakWindows` / `offPeakWindows` / `timeZone` / `providerPatterns` /
  `modelPatterns` / `requireConfirmation` / `gateAuxiliary` / `notifyOffPeak` /
  `unaskableAction` / `askTimeoutMs` / `suppressRepeatAsks` / `askScope` /
  `localAgentsOnly` / `showPrices` / `pricing` / `statePath`。
- **文档**：`README.md`（英文）与 `README.zh.md`（中文），含峰谷规则、安装、
  全部配置项与已知限制。
- **测试**：78 项离线、确定性测试（`tests/peak|gate|switch|client.test.js`）。
- **CI**：GitHub Actions 跑测试（Node 22 与 24）并校验已提交的浏览器产物是否为最新。

### 设计取舍 / Design decisions worth knowing

- **拒绝码不在重试集合内**：`PEAK_HOUR_DECLINED` 刻意避开 `dsh-llm-retry` 的默认可
  重试码（`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`），避免被自动
  重跑；同时对每个「会话 + 路由 + 时段窗口」记忆决策，防止 `retryPolicy.mode: 'always'`
  把它变成反复弹窗。
- **按调用发起时刻判定**：官方未说明峰谷按发起、完成还是账单时刻划分，本插件按发起
  时刻判定，并在每次询问里把这一假设写给用户。
- **`webServer` 用 `ctx.inject` 等待而非 `ctx.get` 采样**：cordis 的 `ctx.get` 是
  strict 的（提供者 fiber 未 ACTIVE 即返回 `undefined`），在 `apply` 期间采样会挂载
  不到路由，表现为侧边栏「无法读取状态」。
- **浏览器产物确定性**：构建戳由 `src/client.js` 与构建脚本的内容哈希派生而非时间戳，
  这样同样的输入产出同样的字节，`build:client:check` 才有判断力。
- **三个名字的分工**：npm 包名与客户端注册 id 都是 `dsh-peak-guard`（DSH 客户端插件的
  清单名就是浏览器模块表的键，不能随意改）；仓库名与 README 标题用 `deepseek-peak-guard`；
  侧边栏显示中文标签 `峰谷计费守卫`。

[Unreleased]: https://github.com/msyrain/dsh-peak-guard/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/msyrain/dsh-peak-guard/releases/tag/v0.2.0
