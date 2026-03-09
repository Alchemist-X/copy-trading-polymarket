# VPS 永久部署指南

当前推荐部署形态:

- `systemd`
- `npm run build`
- `node dist/index.js start --no-dashboard`
- SQLite (`data/copy-trade.db`) 持久化

## 1. 首次部署

```bash
git clone https://github.com/Alchemist-X/copy-trading-polymarket.git
cd copy-trading-polymarket
npm install
cp .env.example .env
npm run build
```

最少需要配置:

- `PRIVATE_KEY`
- `FUNDER_ADDRESS`
- `POLYGON_RPC_URL`
- `TG_BOT_TOKEN`
- `TG_CHAT_ID`
- `ALERT_EMAIL_TO`
- SMTP 相关变量

## 2. systemd

仓库内模板:

- `deploy/copy-trade.service`

推荐放置:

```bash
sudo cp deploy/copy-trade.service /etc/systemd/system/copy-trade.service
sudo systemctl daemon-reload
sudo systemctl enable copy-trade
sudo systemctl start copy-trade
```

说明:

- `Restart=always`
- `RestartSec=5`
- `RestartPreventExitStatus=78`

退出码 `78` 用于全局风控锁定后的“禁止自动重启”。

## 3. 运行时文件

`data/` 目录:

- `copy-trade.db`: 主数据库，启用 SQLite WAL
- `heartbeat.json`: 可选心跳文件
- `addresses.json` / `state.json` / `history.json`: 旧 JSON 数据源，仅首次导入时读取

首次启动如果发现数据库不存在，会自动导入现有 JSON 数据。

## 4. 风控

默认规则:

- 单个被跟地址相对成本基准亏损 `20%` 时，自动暂停该地址
- 总净值相对服务启动基准亏损 `30%` 时，触发全局停机锁

恢复方式:

```bash
node dist/index.js risk status
node dist/index.js risk reset global
node dist/index.js resume <address>
```

## 5. 告警

支持双通道:

- Telegram
- Email

测试:

```bash
node dist/index.js alerts test
```

默认会对以下事件发送告警:

- 服务启动 / 停止
- endpoint 连续失败退化
- 低 USDC
- 余额不足导致下单失败
- source 风控暂停
- global 风控停机
- redeem 失败

## 6. 常用运维命令

```bash
sudo systemctl status copy-trade
sudo journalctl -u copy-trade -f
node dist/index.js status
node dist/index.js risk status
node dist/index.js logs --errors
```

## 7. 升级

```bash
git pull --ff-only
npm install
npm run build
sudo systemctl restart copy-trade
```

升级前建议先执行:

```bash
node dist/index.js status
node dist/index.js risk status
```
