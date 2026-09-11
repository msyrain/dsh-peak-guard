<!--
多谢贡献。下面的检查项不是形式——每一条都对应这个仓库里真实踩过的坑，
CI 也会强制其中一部分。
Thanks! Each item below maps to a failure this repository has actually hit.
-->

## 这个 PR 做了什么 / What this changes

<!-- 一两句话说清动机与结果。Motivation and outcome. -->

## 关联 issue / Related issue

<!-- 如 Closes #12。没有就写「无 / none」。 -->

## 类型 / Type

- [ ] 修 bug / fix
- [ ] 新功能 / feature
- [ ] 文档 / docs
- [ ] 重构或内部调整（行为不变）/ refactor, no behaviour change
- [ ] 构建、CI、工具链 / build, CI, tooling

## 检查清单 / Checklist

- [ ] **`npm test` 全绿**（72 项）/ the suite passes
- [ ] **改了 `src/client.js` 就跑了 `npm run build:client` 并提交了产物**
      / if `src/client.js` changed, `lib/client.js` was rebuilt and committed
      <!-- CI 会跑 build:client:check 拦住这一点：产物过期 = 构建失败。
           测试抓不到它，因为测试读的就是那个（旧的）产物。 -->
- [ ] **`npm run build:client:check` 通过** / the artifact is current
- [ ] 新增行为有对应测试 / new behaviour is covered by a test
- [ ] 用户可见的改动更新了 `README.md` 与 `README.zh.md`（两份都要）
      / user-visible changes update BOTH READMEs
- [ ] 破坏性变更已在下方说明 / breaking changes are described below

## 破坏性变更 / Breaking changes

<!--
例如：改了配置键的含义、改了默认时段、改了包名或客户端注册 id。
没有就写「无 / none」。

特别提醒：`package.json` 的 `name` 同时是浏览器模块表的注册 id
（`dsh.client` 的清单名），改它会让已安装用户的浏览器加载不到 bundle。
-->

## 验证方式 / How this was verified

<!--
别只写「测试通过」。说清你实际怎么验的：用了什么数据、复现了什么场景、
或跑过什么命令。涉及浏览器半部的改动，请说明是否在真实 GUI 里刷新验证过。
-->

## 截图（界面改动必填）/ Screenshots (required for UI changes)

<!--
侧边栏那一行在宽边栏与窄轨两种形态下都要看：宽边栏容易过，窄轨
（56px）才暴露文本裁切、开关溢出这类问题。
-->
