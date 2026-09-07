# OCW Harness

本地检查点执行器与实时路径图控制台。用分层虚线区域组织必须全部满足的检查点，用同一对端点之间的连线展示备选路径；点击后展开执行者、验收证据与历史尝试。

- 已采用：流动绿色实线；待定：虚线；证伪：红线与叉。
- 多任务、多会话显式注册；SSE 推送与每秒只读刷新并用。
- SQLite 租约、并发领取、过期执行者隔离、有限重试与交付对账。
- 不可变快照、观察缓存、故障重启，以及校验后暂停恢复的备份。
- 原生 `ocw-plan-2` 与历史 v1 / OCW 协议数据均可展示。当前设计由 [ui-release.json](ui-release.json) 声明。

## 运行与演示

需要 macOS 或 Linux、Node.js 22.12+、npm 与 Python 3.10+。Python 执行器仅使用标准库。桌面 App 和登录服务入口仅支持 macOS。

```sh
git clone https://github.com/wcboy/ocw-harness.git
cd ocw-harness
npm ci
npm run ensure-ui
npm start
```

打开 <http://127.0.0.1:4173/?demo=paths> 查看可播放、暂停、逐步推进的演示。演示使用正式渲染器，明确标记模拟身份，不读取真实任务 API。根页面显示已注册任务；首次使用时目录为空。

`ensure-ui` 核对源码和构建文件哈希，仅在过期时重建。更新源码后重新运行它并重启自己的控制台进程。`PORT` 可指定其他端口，`OCW_BUILD_DIR` 可指定构建目录。仓库发布版默认使用 `dist/`。

## 接入真实任务

显式指定已存在的 canonical workflow / executor root；注册不会创建或修改任务状态。

```sh
node scripts/harness-registry.mjs register --source /absolute/runtime-root --session session-a
```

默认 registry 位置由 `scripts/harness_registry.py` / `harness-registry.mjs` 决定，可通过 `OCW_HARNESS_REGISTRY_DIR` 指定隔离目录。注册、控制台和执行者须使用同一 registry。任务拥有者应保存注册返回的身份并续报心跳；仅有历史 assignment 不会显示为正在工作。

新执行任务先按 [原生图合同](docs/native-graph-v2.md) 编写计划，然后选择一个尚不存在的运行目录：

```sh
python3 scripts/ocw_runtime.py init --root /absolute/new-runtime --plan /absolute/plan.json
python3 scripts/ocw_runtime.py run --root /absolute/new-runtime --workers 3 --registry /absolute/registry
python3 scripts/ocw_runtime.py status --root /absolute/new-runtime
```

原生计划将区域成员、依赖关系、备选路径、采用决策和逐点验收分开记录。每个点需要可重放的本地命令与独立验收命令；没有真实终审记录时不会制造 R5 通过。

[运行、并发与恢复说明](RUNTIME-RELIABILITY.md) 包含心跳、守护进程、幂等交付、备份与新目录恢复入口。macOS 可通过 `scripts/install-desktop-launcher.sh` 安装桌面入口，通过 `scripts/manage-service.py --help` 查看登录服务选项。

## 开发与验证

```sh
npm run check
npx playwright install chromium
npm run e2e
```

`check` 覆盖图合同、投影、并发、失效、验收、恢复、同步、类型与构建。`e2e` 使用合成任务和隔离 registry，检查实际浏览器交互、每秒 GET、快速切换、移动布局和 UI 版本切换，不写入真实任务。可用 `OCW_E2E_PORT` 避免测试端口冲突。

源码结构：`src/` 为唯一 UI，`server.mjs` 为只读适配器，`scripts/ocw_runtime.py` 为可选执行器，`scripts/ocw_graph.py` 为计划校验与投影，`scripts/ocw_backup.py` 为备份恢复。

## Skill 与复用

[SKILL.md](SKILL.md) 是可选 agent 入口，直接使用本仓库脚本和文档，不另存一份 UI 或执行器。可以将仓库克隆到 agent 的 skills 目录下，或直接在项目中指定此入口。

新控制台使用维护中的当前源码生成，保留最新设计：

```sh
python3 scripts/scaffold_console.py --reference /absolute/ocw-harness --destination /absolute/new-console
```

生成器排除本地任务标签、注册数据和预构建文件。公开仓库采用干净源码快照，不包含开发者历史任务记录或本地 Git 历史。

执行器的租约保护限于它自己的提交和交付边界，不构成任意命令的系统沙箱。外部操作必须由目标端支持幂等键和权威查询；结果不明时需要对账。恢复始终写入新目录并暂停，核对交付和路径后才可继续。
