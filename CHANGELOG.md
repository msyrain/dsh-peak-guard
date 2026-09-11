# 更新日志 / Changelog

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

暂无。/ Nothing yet.

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
- **测试**：72 项离线、确定性测试（`tests/peak|gate|switch|client.test.js`）。
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
