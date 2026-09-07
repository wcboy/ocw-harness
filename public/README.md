# OCW 路径与检查点控制台

当前设计：虚线 ALL 分组、独立检查点、同起终点备选连线与折叠详情。采用为流动绿色实线，证伪为红线加叉，待定为虚线。演示位于 `?demo=paths`，不请求真实 harness API。

使用项目内 `./init.sh run` 或已安装的桌面入口启动。入口验证 `ui-release.json` 与构建摘要，必要时重建，服务版本不匹配时拒绝复用。浏览器发现新版本后保留 URL 中的任务/选择并刷新。不要从历史备份中单独复制旧前端。

新任务显式注册：`./init.sh register /absolute/runtime/root session-id`。不自动绑定某个历史任务。界面保留 SSE 和每秒只读快照，不提供执行写接口。

新执行计划使用 `ocw-plan-2`，通过 `./init.sh runtime init --root <new-root> --plan <plan.json>` 初始化。分组、路径、验收 oracle 与全部必要依赖由运行时合同校验。执行恢复和备份仍由独立 CLI 管理。
