# 贡献指南 / Contributing

感谢愿意帮忙。这个仓库不大，但有几条约束**不直观**，且踩了会以奇怪的方式失败。
先读完这一页能省不少时间。

Thanks for helping. The repository is small, but a few of its constraints are
non-obvious and fail in confusing ways. This page is the short version.

---

## 快速开始 / Quick start

```powershell
git clone https://github.com/msyrain/dsh-peak-guard.git
cd dsh-peak-guard
npm ci --ignore-scripts     # 零运行时依赖，这步只是校验锁文件

npm test                    # 72 项离线测试，不需要网络/DSH/密钥
```

要装进正在运行的 DSH 里实际看效果：

```powershell
node install.mjs            # 默认联接模式：安装目录直接指向本仓库
```

---

## 两个半部 / The two halves

| 文件 | 运行在哪 | 说明 |
|---|---|---|
| `index.js` | **宿主**（Node，DSH 进程内） | 拦截 `llm/stream`、决策、询问用户、状态路由 |
| `src/client.js` | **浏览器** | 侧边栏那一行（名称 + 状态 + 开关） |
| `lib/client.js` | **浏览器**（生成物） | 由 `src/client.js` 构建，**受版本管理** |

两者通过宿主侧路由 `GET/POST /api/peak-guard/state` 通信：浏览器读不到宿主内存，
所以状态必须走一条同源 JSON 路由（DSH 自带的更新器面板用的是同一套方式）。

---

## ⚠️ 四条硬约束 / Four hard constraints

### 1. `src/client.js` 不许用反引号、不许有 `\r`

构建脚本把 `src/client.js` **原样**包进一个 CJS 工厂产物。因此：

- **反引号（模板字面量）会直接让构建报错**。字符串请用引号拼接。
- **CRLF 会让构建报错**。仓库用 `.gitattributes` 固定 LF，但如果你手动改过文件
  或用了会写 CRLF 的编辑器，`npm run build:client` 会拒绝。
- 注释里也别写反引号（包括 Markdown 式的行内代码）——构建脚本检查的是整个文件。

**动手前先跑一遍 `npm run build:client:check`**，它能立刻告诉你产物是否与源码同步。

### 2. 改了 `src/client.js` 必须重建并提交 `lib/client.js`

```powershell
npm run build:client        # 重新生成 lib/client.js
git add lib/client.js
```

**忘了这步，测试不会告诉你** —— 测试读的就是 `lib/client.js`，过期的产物会被当作
「当前产物」照常测过。CI 里的 `build` 作业专门拦这个。

### 3. 问了「什么时候在高峰」的问题，先看官方文档

时段窗口与折扣以 [DeepSeek 官方定价页](https://api-docs.deepseek.com/quick_start/pricing)
为准。本插件只是按它判定，不定义规则。若官方改了规则，欢迎提 PR 或 issue，
并在改动里附上官方原文与核对日期。

### 4. 改了用户可见的东西，两份 README 都要更新

`README.md`（英文）与 `README.zh.md`（中文）内容等价，不要只更一份。

---

## 测试 / Tests

```powershell
npm test                     # 全部
node --test tests/peak.test.js   # 单个文件
```

| 文件 | 覆盖什么 |
|---|---|
| `tests/peak.test.js` | 时区换算、窗口边界（含跨午夜与周末）、glob、价格选择、决策分支、配置校验 |
| `tests/gate.test.js` | 用假 Cordis 上下文驱动真实的 `llm/stream` 监听器：放行、审批通道、问答通道、拒绝块、无通道降级、子智能体、决策记忆、信号取消、卸载 |
| `tests/switch.test.js` | 开关持久化、`/api/peak-guard/state` 的 GET/POST/405/400、关掉后守卫不介入 |
| `tests/client.test.js` | 按客户端模块契约真实**执行** `lib/client.js`：注册 id、导出面、槽位、样式与布局锚点、构建戳、宽/窄渲染 |

写测试时请注意两条**这个仓库已经踩过**的坑：

- **别依赖真实时钟**（`tests/gate.test.js` 里的 `alwaysPeak()` 就是为此而存在）。
  之前有个夹具写死 `00:00–23:59` 当作「全天」，但窗口语义是含头不含尾，
  于是**每天有 1 分钟**它突然失效，测试在那个时刻集中变红。
- **别让测试读写真实状态文件**。`.peak-guard-state.json` 记录的是用户自己的开关，
  若测试没指定 `statePath`，读到 `enabled: false` 就会让所有断言退化成「放行」——
  看起来全绿，其实什么都没验。

---

## 提 PR / Pull requests

请填 `.github/PULL_REQUEST_TEMPLATE.md`。重点两条：

- 说清**你实际怎么验的**，不要只写「测试通过」。
- 界面改动**必须附截图**，且要覆盖**宽边栏与窄轨（56px）两种形态** ——
  窄轨才会暴露文本裁切、开关溢出这类问题。

---

## 提交信息 / Commit messages

惯例如下（并非强制）：

```
<type>: <一句话说明做了什么>

<为什么这么做；若修了 bug，说明它原本怎么坏>
```

`type` 用 `feat` / `fix` / `docs` / `build` / `ci` / `chore` / `refactor`。
正文里说明**原因**比复述 diff 有用得多。

---

## 版本与发布 / Versioning and releases

- 遵循语义化版本。
- **破坏性变更**要特别注意 `package.json` 的 `name`：它同时是浏览器模块表的注册 id
  （`dsh.client` 的清单名），改它会让已安装用户的浏览器加载不到 bundle。
- 发布流程见下（维护者）：

```powershell
npm version patch|minor|major   # 更新版本号并打 tag
npm publish                     # prepublishOnly 会先跑测试与产物校验
git push --follow-tags
```

发布前请更新 `CHANGELOG.md`：把 `[Unreleased]` 的内容整理到新版本号下。
