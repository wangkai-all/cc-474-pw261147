# TimeVault · 数据表时间旅行

一个支持**按时间点 / 版本恢复分区**的数据表管理工具。每次写入分区都会生成不可变版本；
恢复前先计算**差异**与**下游影响**，执行中**检测并发写入并暂停等待选择**，恢复全程写入
**只追加、哈希串联**的审计链，保留原始版本、操作者与依据。

界面提供版本时间线、逐文件/逐行差异、下游影响清单、冲突处理面板和实时恢复进度。

---

## 快速开始

```bash
npm start            # http://127.0.0.1:4173 ，首次启动自动生成演示数据
npm test             # 20 个 API / 领域测试（Node 内置 test runner）
npm run test:e2e     # 6 个浏览器端到端测试（需要 Chromium，见下文）
```

需要 **Node.js ≥ 24**（使用内置 `node:sqlite`，无外部运行时依赖）。
`playwright-core` 只用于端到端测试。

演示数据包含两张表：

| 表 | 分区 | 说明 |
| --- | --- | --- |
| `dwd_orders` | `city=beijing` / `city=chengdu` / `city=hangzhou` / `city=shanghai` | 订单事实表，7 个版本，含一次“误删成都文件”事故版本 |
| `dwd_shipments` | `city=beijing` / `city=shanghai` | 运单表 |

取消环境变量 `TV_AUTOSEED=false` 可禁止自动播种；`npm run seed:reset` 手动重建。

---

## 核心概念

### 版本是不可变的

- 分区文件以 NDJSON 存放，**提交 / 恢复完成时会把每个文件写入内容寻址对象库**
  （`data/objects/<sha256 前两位>/<sha256>`），版本清单 `manifest` 记录
  `{ partition, path, checksum, bytes, rows }`。
- 因此任意历史版本都能**逐字节还原**，即使活动分区后来被覆盖或删除。
- 版本只追加；重复恢复到同一目标仍会记录一个新版本（或标记为 `noop`），
  时间线完整保留“谁在什么时候恢复过”。

### 恢复按时间点或版本

```http
POST /api/restores
{
  "tableId": "tbl_orders",
  "partition": "city=chengdu",
  "seq": 4,                     // 或 "versionId": "v_xxx" / "at": "2026-11-19T05:22:00Z"
  "operator": "李京",
  "reason": "误删成都文件，恢复至 v4",
  "ticket": "OPS-5001",
  "conflictAction": "pause"     // pause | keep_current | overwrite_target | abort
}
```

`at` 会解析为“该时间点及之前最近的版本”。`dryRun: true` 只计算差异与影响、不写文件。

### 差异与下游影响

- **文件级**：新增 / 修改 / 删除 / 未变化，以及字节、行数增减。
- **行级**：按主键（表定义的 `partitionKey`，默认 `id`）对比，输出新增行、删除行、
  修改行及具体变更字段（界面展示 `before → after`）。
- **下游影响**：表定义中的下游资产可声明依赖的分区（`*` 或精确分区名）、字段、严重级别、
  SLA 和调度；恢复时会筛选命中该分区的消费者并给出处置建议。

### 避免覆盖并发写入

三层保护：

1. **分区写锁** —— 恢复进行中（`checking/running/conflict/verifying/finalizing`）时，
   对该分区的直接写入返回 `409 partition_locked`；同一分区同时只允许一个恢复任务。
2. **预检快照比对** —— 创建任务时记录每个文件当前校验和作为基线；任务真正开始写入前
   再次比对。任何不一致（包括计划中“已一致将跳过”的文件）都会被视为并发写入。
3. **写前再比对** —— 每个文件落盘前再检查一次，缩小竞态窗口。

发现并发写入时（`conflictAction: "pause"`，默认）：

- 任务进入 `conflict` 状态并**暂停**，冲突文件保持原样，不会被覆盖；
- 界面弹出冲突面板，列出每个文件的 **基线 / 当前 / 目标** 校验和；
- 操作者必须选择 **覆盖目标 / 保留当前 / 中止回滚**，并填写决策依据；
- 决策连同校验和、操作者、依据写入审计链。

也支持 `keep_current`（保留他人写入）、`overwrite_target`（以目标为准）、`abort`（发现即中止）三种预设策略。

### 审计

`audit_events` 为只追加表，每条记录包含 `actor / action / reason / evidence / snapshot`，
并用 `prev_hash → hash` 串联成防篡改链（`GET /api/audit/verify`）。

恢复相关事件覆盖完整生命周期：`restore.requested`（含目标版本快照哈希与文件计划）、
`restore.conflict_detected`、`restore.conflict_decision`、`restore.completed`
（含基线版本、新版本、冲突数）、`restore.failed`、`restore.cancelled`、`restore.noop`。
每条都保留**原始版本、操作者、依据**。

### 重复恢复与部分文件损坏

- **重复恢复**：当前分区已与目标一致时，任务以 `result: "noop"` 完成，不产生写操作，
  审计记录 `restore.noop`。有差异时重复执行也会因为目标内容相同而收敛到同一状态。
- **部分文件损坏**：预检会逐个读取目标版本的对象并校验哈希。任一对象缺失或哈希不符，
  任务以 `result: "integrity_failed"` 失败，**不写入任何文件**；差异接口也会标记
  `damagedFiles` 而不是抛 500。损坏只影响引用该对象的版本，其他分区/版本的恢复不受影响。

---

## 界面

- `#/` 数据表总览（版本数、分区、行数、最近恢复）。
- `#/table/<id>` 版本时间线 + 选定版本的差异 / 行级样本 / 下游影响 + 活动分区文件
  + 恢复对话框 + 恢复进度 / 冲突面板。
- `#/jobs` 恢复任务列表；`#/jobs/<id>` 任务详情（文件明细、差异摘要、任务审计链）。
- `#/audit` 审计事件流与链完整性校验。

恢复进度按 **完整性校验 → 写入 → 回读校验 → 提交版本** 四阶段展示，列出每个文件状态。

---

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与播种状态 |
| GET | `/api/tables` | 数据表列表 |
| GET | `/api/tables/:id` | 表详情（分区、版本、提交） |
| GET | `/api/tables/:id/partitions/:p/live` | 活动分区文件清单 |
| GET | `/api/tables/:id/resolve?at=&seq=` | 解析时间点/序号对应版本 |
| POST | `/api/tables/:id/diff` | 差异与下游影响（`versionId`/`seq`/`at` + `fromVersionId`） |
| POST | `/api/tables/:id/commit` | 写入分区并生成版本（恢复期间返回 409） |
| POST | `/api/restores` | 创建恢复任务（支持 dryRun） |
| GET | `/api/restores/:id` | 任务详情与文件明细 |
| GET | `/api/restores/:id/progress` | 轻量进度轮询 |
| POST | `/api/restores/:id/conflict` | 冲突决策（`overwrite_target` / `keep_current` / `abort`） |
| POST | `/api/restores/:id/cancel` | 取消并回滚已写入文件 |
| POST | `/api/restores/:id/rollback` | 使用备份手动回滚 |
| GET | `/api/audit` · `/api/audit/verify` | 审计事件 / 链校验 |

写操作需要操作者：请求体 `operator` 或 `X-Operator` 头；恢复与取消还需要 `reason`。

---

## 目录结构

```
server/
  index.js      HTTP 路由、静态资源、安全响应头
  start.js      启动入口（自动播种）
  db.js         SQLite schema、事务、数据目录
  tables.js     表/分区/版本/提交，内容寻址清单
  diff.js       文件级+行级差异、下游影响
  restore.js    恢复任务状态机、并发检测、冲突、回滚、校验
  storage.js    对象库、原子写入、损坏检测、备份
  audit.js      哈希链审计
  locks.js      分区写锁（由任务状态派生）
  seed.js       演示数据
test/
  api.test.js   领域/接口测试
  e2e.test.js   浏览器端到端测试
public/         无构建步骤的原生 ES Modules 前端
```

## 设计取舍

- **文件级锁 + 快照比对，而非数据库行锁**：分区数据以文件为中心，恢复的原子单位是文件；
  以“基线校验和”而非时间来判定冲突，能捕获任何来源的并发写入。
- **预检全量校验对象**：宁可让损坏版本整体失败，也不产生“部分文件恢复、部分仍是旧数据”的
  混合状态；回读校验失败会自动回滚已写入文件。
- **版本只追加**：恢复不删除历史，而是生成新版本，便于二次恢复与审计复盘。
- **前端无框架**：原生模块 + 事件驱动，`npm start` 即可运行，降低演示与审计环境的依赖面。

## 端到端测试环境

`npm run test:e2e` 需要 Chromium。普通开发机执行
`npx playwright-core install chromium-headless-shell` 即可。在本沙箱中，浏览器所需的
共享库与字体被解压到 `/tmp/libs`，通过以下环境变量注入（脚本 `test/browser.js` 读取）：

```bash
EXTRA_LD_LIBRARY_PATH=/tmp/libs/rootfs/usr/lib/x86_64-linux-gnu:/tmp/libs/rootfs/lib/x86_64-linux-gnu \
FONTCONFIG_FILE=/tmp/libs/fc/fonts.conf \
node --test test/e2e.test.js
```

未设置这些变量时会回退到系统库。
