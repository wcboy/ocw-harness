# OCW 原生图与执行合同 v2

当前设计由 `ui-release.json` 声明，当前为 `checkpoint-paths-2`。图合同 `ocw-graph-2`，计划合同 `ocw-plan-2`。设计继续沿用分层虚线区域、区域内多点 AND、相同端点的多条简称路径，以及单一可折叠详情面板。

## 数据与执行

- `groups`: `{id,label,checkpoint_ids,policy:"all"}`。每个检查点属于且只属于一个区域。区域全部必要点通过才完成。区域内只有显式 `depends_on` 构成先后顺序，其余可并行。
- `transitions`: `{id,from:[groupId],to:groupId,initial_path_id?}`。一个目标区域有一个入口；多个源区域表示 AND 汇合。入口为空数组表示从 ROOT 开始。无初始选择的区域等待决策。
- `paths`: `{id,transition_id,label,short_label,mechanism,commands?}`。同一转换的备选路径共享端点。简称 1–32 字符。`commands` 可按目标区域的检查点 ID 覆盖其 `argv`；未覆盖时用检查点默认命令。工作目录、资源限额和验收 oracle 仍由检查点声明。路径不能覆写其他区域的命令。
- `checkpoints`: `{id,label,objective,cwd,argv,execution:"replay_safe",depends_on,acceptance}`。`acceptance` 必须含 `version` 和非空 `argv`，可设 `timeout_seconds`（默认 60，上限 300）。所有命令都继承已授权本地执行的边界。

检查点命令可以读取 `OCW_PATH_ID`、`OCW_CHECKPOINT_ID`、`OCW_INPUT_DIGEST`。独立验收命令读取 `OCW_RESULT_FILE` 指向的 JSON：`{checkpoint_id,result,context}`。`result.receipt` 含真实交付文件地址与摘要；验收应读取和检查产物，而非只检查工作命令退出码。退出 0 表示验收通过；其他退出码保留失败证据并重试。验收输出有 1 MiB 上限，主命令输出有 8 MiB 上限。

生成器与验收器可以是不同本地程序，或由外部调度器调用 `Runtime.claim/heartbeat/finish`。这里的独立验收是独立命令与证据记录，并不等同于另一位独立审计人员；没有 R5 审计时 UI 不制造 R5 通过。

## 决策、失效与历史

`Runtime.decide_path(path_id, actor=..., reason=..., expected_revision=..., verdict=..., adopt=..., evidence={...})` 以及 CLI `decide-path` 使用预期 revision 比较后写入；旧 revision 拒绝。`verdict` 为 `pending/supported/refuted/invalidated`。记录 verdict 必须传结构化证据。`adopt` 与 verdict 分离：绿色流动线表示已采用，不能被当成所有检查点完成或 agent 正在工作。待定为虚线，证伪为红线与叉；运行失败只进入尝试历史，不自动证伪。

已选路径的结论改变、改选路径、或 `invalidate-checkpoint` 会撤销相应点及其依赖后继，递增输入代数并作废运行中的租约。旧 worker 无法提交、续租或调用受保护交付。重新验收使用新的输入摘要和交付名称，保留先前交付字节与验收历史。重复确认采用也是一次新决策，会触发重新验收，应避免无意义地反复提交。

每个尝试固定 `checkpoint/attempt/worker/lease epoch`、选中路径、路径决策 revision、上游验收摘要、命令摘要、oracle version、输入代数。验收提交前再检查这些输入和租约。v2 幂等操作键为 task/checkpoint/operation/inputDigest；同一输入的重试共享键。外部结果未知时仍必须对账，不能因换路径而盲目重放。

## 投影与实时观察

SQLite 是可执行事实源。导出器生成哈希校验的不可变 generation，并最后切换 `ocw-head.json`。`ocw-graph-2` 显式提供每点 `execution_status`、`acceptance_policy`、验收记录引用/摘要、每条稳定路径的 verdict/selection/attempt_history 和区域关系。adapter 验证结构和证据字节，不从区域完成反推同区域每个点完成。

agent 必须带精确 `checkpoint_ids/path_ids`、`attempt_id`、`worker_instance_id`、`lease_epoch/lease_expires_at`。精确记录不会继承到其他点或路径。租约到期不算正在工作；历史归属仍可查。

心跳递增 `observationSeq` 并发布，不伪增业务 revision。浏览器同时拒绝旧 dataEpoch、旧 revision、同 revision 的旧源观察序号、旧 adapter 响应序号和退休 binding。SSE 推送与每秒 GET 并用，不重叠请求。恢复的新 dataEpoch 允许较旧 revision；旧页面选中对象保留。

## 兼容、恢复和最新设计

既有 v1 计划继续可读可执行，以单点区域、稳定 `PATH-{checkpoint}` 和 `legacy_command_receipt` 标注。旧协议文件继续按历史证据粒度展示，不改写原文件，也不会捏造逐点验收。要采用多点区域与独立验收，为新执行实例编写 v2 计划；不要就地替换历史不可变计划。

备份恢复到新目录。恢复脚本迁移已声明的 cwd、主命令、路径命令和验收命令参数路径，保留历史字节，作废旧租约并暂停。操作人核对脚本/依赖、交付文件、旧主机隔离和未知操作后才激活。嵌在 `-c` 字符串中的路径不能自动可靠改写，应使用独立脚本参数。

以维护中的 reference 当前源码为唯一 UI 模板；历史提交仅作变更证据。`scripts/scaffold_console.py --reference <reference> --destination <new-dir>` 复制当前渲染器、运行时与启动入口，不带历史数据或预构建页面。新目录先 `npm ci`，显式注册数据源后启动。

`ui-release.json` 是设计/合同版本入口；`ui-build.json` 记录源码指纹、index 与 JS/CSS 哈希。入口执行 `ensure-ui`，源码或产物不匹配则隔离构建再发布；旧 adapter 不能因端口相同被复用。页面每 5 秒观察构建版本并保留选择刷新，同一新指纹最多自动刷新一次。预构建文件可直接运行的前提是源码与配置指纹匹配；恢复到改变配置的新位置时需要重建依赖。

## 可复用验证

`npm run check` 覆盖原生图、路径决策、单点验收、租约、幂等、恢复、同步、类型和构建。`npm run e2e` 另跑真实浏览器，使用隔离 registry 与合成 fixture；`?demo=paths` 是明确标记的演示，不连接真实任务 API。新设计必须保留相同端点连线、红叉/虚线/绿色流线、全部必要点、折叠详情及移动端画布滚动。
