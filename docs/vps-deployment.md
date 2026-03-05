# VPS 永久部署指南

将 copy-trading-polymarket 部署到 VPS 上 7×24 运行需要考虑的所有事项。

---

## 1. 进程持久化

`npx tsx src/index.ts start` 是一个前台进程——SSH 断开即死。需要一个进程管理器。

### 方案 A: pm2（推荐）

```bash
npm install -g pm2

# 启动（--no-dashboard 因为无交互终端）
pm2 start "npx tsx src/index.ts start --no-dashboard" --name copy-trade

# 开机自启
pm2 startup
pm2 save

# 常用操作
pm2 logs copy-trade          # 实时日志
pm2 restart copy-trade       # 重启
pm2 stop copy-trade          # 停止
```

### 方案 B: systemd

```ini
# /etc/systemd/system/copy-trade.service
[Unit]
Description=Polymarket Copy Trading
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/home/deploy/copy-trading-polymarket
ExecStart=/usr/bin/npx tsx src/index.ts start --no-dashboard
Restart=always
RestartSec=10
EnvironmentFile=/home/deploy/copy-trading-polymarket/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable copy-trade
sudo systemctl start copy-trade
journalctl -u copy-trade -f    # 查看日志
```

> **关键**: VPS 上必须用 `--no-dashboard`，因为没有 TTY 终端。所有输出走 `logs/` 文件系统。

---

## 2. 私钥安全

`.env` 文件包含钱包私钥，是整个系统最敏感的部分。

| 风险 | 措施 |
|------|------|
| 私钥明文存储 | 文件权限 `chmod 600 .env`，仅 owner 可读 |
| 服务器被入侵 | 使用独立的跟单钱包，不存放大额资金 |
| Git 泄露 | `.env` 已在 `.gitignore`，部署时手动创建 |
| 内存泄露 | 定期重启进程（pm2 `--cron-restart="0 4 * * *"` 每天凌晨 4 点） |

**最佳实践**:
- 跟单钱包只放够用几天的 USDC，定期从冷钱包补充
- 设置 Polymarket API key 有效期，定期轮换
- 考虑用 `FUNDER_ADDRESS` 对应的 proxy wallet 做资金隔离

---

## 3. 网络与延迟

跟单系统对延迟敏感——10 秒的轮询间隔已经是竞争劣势，网络再慢就更滞后。

- **VPS 选址**: 选择美东（us-east-1）机房，离 Polymarket 的 Cloudflare CDN 和 Polygon RPC 最近
- **DNS 缓存**: 安装 `dnsmasq` 避免每次 API 请求都做 DNS 解析
- **连接复用**: Node.js 默认启用 HTTP keep-alive，确认不要额外关闭
- **Polygon RPC**: 当前使用公共 RPC (`polygon-bor-rpc.publicnode.com`)，有限流风险；生产环境建议用 Alchemy / Infura 的付费 RPC
- **API Rate Limit**: Polymarket Activity API 无官方限流文档，但高并发下可能返回 429。当前 `p-limit(15)` 在 1000 地址下可能需要降到 10

---

## 4. 数据持久化与备份

所有运行时数据在 `data/` 目录：

| 文件 | 丢失后果 | 备份频率 |
|------|---------|---------|
| `addresses.json` | 所有跟单配置丢失，需重新添加 | 每次变更后 |
| `state.json` | `seenHashes` 丢失会导致重复跟单 | 每小时 |
| `history.json` | 执行记录丢失，可从链上恢复 | 每天 |

```bash
# crontab 示例：每小时备份 data/ 到 ~/backups/
0 * * * * tar czf ~/backups/copy-trade-$(date +\%Y\%m\%d\%H).tar.gz -C /home/deploy/copy-trading-polymarket data/

# 保留 7 天的备份
0 5 * * * find ~/backups/ -name "copy-trade-*.tar.gz" -mtime +7 -delete
```

### state.json 膨胀

`seenHashes` 数组会持续增长。当前代码在超过 50000 条时裁剪到 30000，但如果跟踪的地址交易频繁，文件可能达到数 MB。监控文件大小：

```bash
# 加到 crontab，超过 5MB 告警
*/30 * * * * [ $(stat -f%z data/state.json 2>/dev/null || echo 0) -gt 5242880 ] && echo "state.json > 5MB" | mail -s "Alert" you@email.com
```

---

## 5. 监控与告警

VPS 上没有 dashboard 交互，需要外部监控。

### 进程存活

```bash
# pm2 心跳检查（crontab）
*/5 * * * * pm2 pid copy-trade > /dev/null || pm2 restart copy-trade
```

### 日志监控

系统已输出 JSONL 日志到 `logs/`。关注以下信号：

- `errors.log` 中连续出现 `EXEC_INSUFFICIENT_BALANCE` → USDC 余额不足
- `POLL_RATE_LIMITED` 大量出现 → 降低并发或增加轮询间隔
- 长时间无 `engine-*.log` 写入 → 进程可能假死

### Telegram/Discord 告警（建议后续实现）

在 `executor.ts` 的交易成功/失败回调中，发送通知到 Telegram Bot：

```
✅ COPY BUY $50.00 "Will Trump win 2028?" @ 0.42
❌ FAIL BUY $50.00 → EXEC_FOK_NOT_FILLED (3 retries)
⚠️ USDC Balance low: $12.50
```

---

## 6. 自动更新

```bash
# 手动更新流程
cd /home/deploy/copy-trading-polymarket
git pull origin main
npm install
pm2 restart copy-trade
```

自动化（可选，谨慎使用）：

```bash
# crontab: 每天凌晨 3 点检查更新
0 3 * * * cd /home/deploy/copy-trading-polymarket && git pull --ff-only && npm install && pm2 restart copy-trade
```

> **注意**: 自动更新有风险——一个 bug commit 可能导致资金损失。建议保持手动更新，或加入 tag/release 校验。

---

## 7. 资源需求

| 指标 | 预估 | 说明 |
|------|------|------|
| CPU | 1 core | Node.js 单线程，轮询 + 计算负载低 |
| RAM | 256-512 MB | 1000 地址的 seenSet + eventLog |
| 磁盘 | 1 GB | 日志 30 天约 500MB，data/ < 50MB |
| 带宽 | 低 | 每秒约 15 个 HTTP 请求，每个 < 5KB |

**推荐机型**: 最低 1C1G 的 VPS 即可（Vultr $5/mo, DigitalOcean $4/mo, AWS Lightsail $3.5/mo）。

---

## 8. Node.js 版本

```bash
# 安装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20
```

项目需要 Node.js ≥ 18（ESM + top-level await）。推荐 v20 LTS。

---

## 9. 快速部署清单

```
1. [ ] 创建 VPS (Ubuntu 22.04+, us-east-1)
2. [ ] 安装 Node.js 20, npm, pm2
3. [ ] git clone + npm install
4. [ ] 创建 .env（chmod 600）
5. [ ] 添加跟单地址: npx tsx src/index.ts add <username>
6. [ ] 验证: npx tsx src/index.ts list
7. [ ] 试运行: npx tsx src/index.ts start --dry-run --no-dashboard
8. [ ] 检查 logs/: 确认 detect 正常
9. [ ] 正式启动: pm2 start ... --name copy-trade
10. [ ] pm2 startup && pm2 save
11. [ ] 配置 crontab 备份
12. [ ] 配置日志/余额告警
```

---

## 10. 已知限制与后续优化

| 项目 | 现状 | 建议 |
|------|------|------|
| 通知 | 仅文件日志 | 接入 Telegram Bot API |
| RPC | 公共节点 | 换 Alchemy/Infura 付费 RPC |
| 重启恢复 | 从 state.json cursor 继续 | 加心跳文件检测假死 |
| 多钱包 | 单 .env 单钱包 | 支持多 .env profile 轮换 |
| Web UI | 无 | 后续可加 Express + WebSocket 远程监控 |
| 资金管理 | 手动充值 | 自动从冷钱包 bridge USDC |
