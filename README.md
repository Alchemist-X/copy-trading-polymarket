# Polymarket Copy Trading Bot

自动跟单 Polymarket 交易者。通过轮询 Activity API 监控目标钱包，检测到新交易后自动执行跟单。支持最多 1000 个地址并发监控，四种跟单模式，高级过滤器，实时终端 Dashboard。

## Features

- **大规模跟单** — 并发监控最多 1000 个地址，基于优先级分层轮询（10s/30s/60s）
- **四种跟单模式** — 按比例、固定金额、范围限制、反向跟单
- **高级过滤器** — 最小触发金额、最大赔率、单市场上限、到期天数过滤
- **卖出策略** — 同比例跟卖、固定金额跟卖、自定义比例跟卖、不跟卖
- **安全机制** — 滑点保护（默认 5%）、交易去重、失败自动重试（3 次）
- **实时监控** — 终端 Dashboard 展示运行状态、最近执行、USDC 余额
- **完整管理** — 添加/编辑/暂停/恢复/删除地址，批量 CSV/JSON 导入
- **Dry Run** — 测试模式下不执行真实交易，验证配置无误

---

## 前置条件

- Node.js >= 18
- 一个 Polygon 钱包，存有 USDC（用于跟单下注）
- Polymarket 账户（已完成 deposit/proxy wallet 设置）

## 安装

```bash
git clone https://github.com/Alchemist-X/copy-trading-polymarket.git
cd copy-trading-polymarket
npm install
```

## 配置

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
FUNDER_ADDRESS=0xYOUR_POLYMARKET_PROXY_WALLET
SIGNATURE_TYPE=1
```

| 变量 | 说明 | 获取方式 |
|------|------|----------|
| `PRIVATE_KEY` | 钱包私钥 | 从 MetaMask 导出，或用 ethers 生成 |
| `FUNDER_ADDRESS` | Polymarket 代理钱包地址 | 登录 polymarket.com → Settings → 查看 Proxy Wallet |
| `SIGNATURE_TYPE` | 签名方式 | `0`=EOA 直接签名, `1`=代理钱包(常用), `2`=Gnosis Safe |

---

## 使用指南

所有命令通过 `npx tsx src/index.ts <command>` 执行。

### 1. 添加跟单地址

```bash
npx tsx src/index.ts add 0xd91cfb12e2d54a04f002E80f38bA7E1e473BE346
```

进入交互式配置流程：

```
Nickname (optional): smart_whale

Copy Mode:
  1) percentage - Copy X% of their trade amount
  2) fixed      - Always copy with fixed $amount
  3) range      - Percentage with min/max bounds
Select mode [1/2/3]: 1
Percentage (e.g. 0.1 for 10%): 0.1

Counter mode? (bet against) [y/N]: N

Priority (polling frequency):
  1) fast   - 10s interval
  2) normal - 30s interval (default)
  3) slow   - 60s interval
Select [1/2/3]: 1

Advanced Filters (press Enter to skip):
Min trigger amount ($): 10
Max odds (e.g. 0.8): 0.85
Max per market ($): 200
Max days out: 30

Sell Mode:
  1) same_pct    - Sell same % as trader (default)
  2) fixed       - Sell fixed amount
  3) custom_pct  - Sell custom % of your position
  4) ignore      - Don't copy sells
Select [1/2/3/4]: 1

✓ Added smart_whale (percentage, fast priority)
```

### 2. 批量导入地址

准备 CSV 文件（每行: `地址,昵称`）：

```csv
0xd91cfb12e2d54a04f002E80f38bA7E1e473BE346,whale_1
0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,whale_2
0x1234567890abcdef1234567890abcdef12345678,degen_trader
```

或 JSON 文件：

```json
[
  { "address": "0xd91cfb12e2d54a04f002E80f38bA7E1e473BE346", "nickname": "whale_1" },
  { "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "nickname": "whale_2" }
]
```

导入：

```bash
npx tsx src/index.ts import wallets.csv
# 或
npx tsx src/index.ts import wallets.json
```

批量导入使用默认配置：percentage 10%、normal 优先级、无过滤器。导入后可用 `edit` 命令逐个调整。

### 3. 查看地址列表

```bash
npx tsx src/index.ts list
```

输出：

```
Followed Addresses (3):

Status   Nickname       Address        Mode         Amount     Priority Counter
────────────────────────────────────────────────────────────────────────────────
  ● ON   whale_1        0xd91c..E346   percentage   10%        fast     no
  ● ON   whale_2        0xA0b8..eB48   percentage   10%        normal   no
  ● OFF  degen_trader   0x1234..5678   fixed        $25        slow     YES
```

### 4. 编辑跟单配置

```bash
npx tsx src/index.ts edit 0xd91cfb12e2d54a04f002E80f38bA7E1e473BE346
```

进入交互式编辑，按 Enter 保留当前值。

### 5. 暂停 / 恢复

```bash
# 暂停单个地址
npx tsx src/index.ts pause 0xd91cfb12e2d54a04f002E80f38bA7E1e473BE346

# 暂停全部
npx tsx src/index.ts pause all

# 恢复单个地址
npx tsx src/index.ts resume 0xd91cfb12e2d54a04f002E80f38bA7E1e473BE346

# 恢复全部
npx tsx src/index.ts resume all
```

### 6. 删除地址

```bash
npx tsx src/index.ts remove 0xd91cfb12e2d54a04f002E80f38bA7E1e473BE346
```

### 7. 启动跟单引擎

**建议先用 dry-run 测试：**

```bash
npx tsx src/index.ts start --dry-run
```

Dry run 模式下所有检测到的交易都会记录，但不会执行真实下单。确认无误后：

```bash
npx tsx src/index.ts start
```

启动后显示实时 Dashboard：

```
╔══════════════════════════════════════════════════════════════════╗
║        Polymarket Copy Trading Monitor                         ║
╠══════════════════════════════════════════════════════════════════╣
║ Status: ● RUNNING                                              ║
║ USDC Balance: $1,234.56                                        ║
║ Cycle: 42  Last: 3200ms                                        ║
╠══════════════════════════════════════════════════════════════════╣
║ Addresses: 150 total  148 active  2 paused                     ║
║ Trades: 23 detected  18 executed  3 skipped  2 failed          ║
╠══════════════════════════════════════════════════════════════════╣
║ Recent Executions                                              ║
╠══════════════════════════════════════════════════════════════════╣
║  14:23:01 ✓ BUY $10.0  0xd91c.. Will Trump win 2026?          ║
║  14:22:45 ✓ SELL $5.0   0xA0b8.. Bitcoin above 100k by July?  ║
║  14:21:12 ○ BUY $0.0   0x1234.. (dry run)                     ║
╠══════════════════════════════════════════════════════════════════╣
║  [q] quit                                                      ║
╚══════════════════════════════════════════════════════════════════╝
```

按 `q` 退出。

#### Start 选项

```bash
npx tsx src/index.ts start [options]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--dry-run` | 不执行真实交易，仅记录和展示 | `false` |
| `--concurrency <n>` | 并发 API 请求数 | `15` |
| `--verbose` | 详细日志输出（含 API 响应） | `false` |
| `--no-dashboard` | 禁用实时 Dashboard，仅输出日志 | Dashboard 开启 |

### 8. 查看执行历史

```bash
# 默认最近 20 条
npx tsx src/index.ts history

# 指定数量
npx tsx src/index.ts history --limit 50
```

输出：

```
Recent Executions (last 20):

  ✓ 2026-03-05 14:23:01 BUY $10.00   0xd91cfb.. Will Trump win the 2026 midterms?
  ✓ 2026-03-05 14:22:45 SELL $5.00   0xA0b869.. Bitcoin above 100k by July 2026?
  ○ 2026-03-05 14:21:12 BUY $0.00    0x123456.. (dry run)
  ✗ 2026-03-05 14:20:30 BUY $25.00   0xabcdef.. (slippage 8.2% > max 5.0%)
```

### 9. 查看状态概览

```bash
npx tsx src/index.ts status
```

---

## 跟单模式详解

### Percentage（按比例）

跟随目标交易金额的 X%。例如目标下注 $1000，你设 0.1 (10%)，则跟单 $100。

```
percentage = 0.1 → 跟单金额 = 原始金额 × 10%
```

### Fixed（固定金额）

不管目标交易多少，每次固定跟单 $X。适合想要严格控制每笔投入的场景。

```
fixedAmount = 25 → 每次跟单固定 $25
```

### Range（范围）

按比例跟单，但限制在 [min, max] 范围内。避免跟单金额过小或过大。

```
percentage = 0.1, minAmount = 5, maxAmount = 100
→ 目标下 $30 → 跟 $5 (min)
→ 目标下 $500 → 跟 $50 (10%)
→ 目标下 $5000 → 跟 $100 (max)
```

### Counter（反向跟单）

以上任意模式 + 反向操作。目标 BUY 你 SELL，目标 SELL 你 BUY。用于对冲或做反方向交易。

---

## 高级过滤器详解

在 `add` 或 `edit` 时配置：

| 过滤器 | 说明 | 示例 |
|--------|------|------|
| `minTrigger` | 原始交易金额低于此值则跳过（过滤小额测试单） | `10` → 忽略低于 $10 的交易 |
| `maxOdds` | 价格/赔率超过此值不跟（避免买很贵的合约） | `0.85` → 忽略 > 85 cents 的交易 |
| `maxPerMarket` | 对同一市场累计投入不超过此值 | `200` → 同一市场最多投 $200 |
| `maxDaysOut` | 只跟 N 天内到期的市场 | `30` → 忽略 30 天后才结算的市场 |

### 卖出策略

| 模式 | 说明 |
|------|------|
| `same_pct` | 目标卖出仓位的 X%，你也卖出同比例（默认） |
| `fixed` | 目标卖出时，你固定卖出 $X |
| `custom_pct` | 目标卖出时，你卖出自己仓位的 X% |
| `ignore` | 不跟卖，只跟买 |

---

## 数据存储

运行时数据保存在项目根目录 `data/` 下（已 gitignore）：

| 文件 | 说明 |
|------|------|
| `data/addresses.json` | 所有跟单地址及其配置 |
| `data/state.json` | 运行时状态：每个地址的轮询游标、已处理交易 hash（去重用） |
| `data/history.json` | 执行历史记录（最多保留 10,000 条） |

---

## 架构

```
src/
├── index.ts              # 主入口 + CLI 命令注册 (commander)
├── cli/
│   ├── commands.ts       # 10 个 CLI 命令实现
│   └── dashboard.ts      # 终端实时看板 (每 2s 刷新)
├── core/
│   ├── monitor.ts        # 交易监控引擎 (p-limit 并发, 优先级调度, 增量轮询)
│   ├── executor.ts       # 交易执行器 (FOK 市价单, 滑点检查, 3 次重试)
│   ├── copy-logic.ts     # 跟单金额计算 (4 种模式)
│   └── filters.ts        # 高级过滤器链
├── lib/
│   ├── client.ts         # Polymarket CLOB 客户端初始化
│   ├── polymarket-api.ts # Activity API / Gamma API / CLOB Price API 封装
│   ├── store.ts          # JSON 文件持久化
│   └── logger.ts         # 彩色日志 (info/warn/error/trade/skip/debug)
└── types/
    └── index.ts          # TypeScript 类型定义
```

### 监控流程

```
Monitor.runCycle()
  → 加载所有 enabled 地址
  → 按 priority + lastActivityAt 筛选 due 地址
  → p-limit 并发轮询 Activity API (增量: startTimestamp)
  → 检测新交易 (transaction hash 去重)
  → applyFilters() → 检查 minTrigger / maxOdds / maxPerMarket / maxDaysOut
  → calculateCopy() → 根据 copyMode 计算跟单金额
  → executeCopyTrade() → 滑点检查 → FOK 市价单 → 失败重试 → 记录结果
```

---

## 技术栈

| 依赖 | 用途 |
|------|------|
| `@polymarket/clob-client` | Polymarket CLOB 下单 / 撤单 / 查询 |
| `ethers` | Polygon 钱包签名 |
| `commander` | CLI 框架 |
| `chalk` | 终端彩色输出 |
| `p-limit` | 并发控制 |
| `dotenv` | 环境变量管理 |

## License

MIT
