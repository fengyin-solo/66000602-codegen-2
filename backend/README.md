# Backend: Python FastAPI

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## API

- `POST /api/audit` — 合约审计。请求体 `{code, filename, gasBudget?}`，返回漏洞、Gas 测量（`gasMeasurements`）、优化建议（`gasIssues`）与预算评估（`gasBudget`）。
- `POST /api/gas/evaluate` — 用既有测量数据 + 新阈值配置重新评估预算，不重新采集消耗数据。请求体 `{measurements, noData, config}`。
- `GET /api/gas/rules` — 返回 Gas 估算常量与预算判定规则说明。
- `GET /api/patterns` / `GET /api/history` / `POST /api/report/{id}`

## Gas 预算判定规则

- 每个函数的适用上限 = 该函数单独阈值（优先） ?? 项目默认上限；两者都没有记为「未设限」。
- 估算消耗 > 适用上限 → 超标（记录超出比例与主要原因）；≥ 上限 × 预警比例（默认 0.8）→ 接近阈值提醒；其余正常。
- 阈值合法范围为 `[21000, 30000000]` 的整数（基础交易成本 / 区块 Gas Limit），预警比例须在 `(0, 1)` 开区间。非法取值被拦截并附标准说明，其余合法条目仍生效。
- 评估是纯函数：调整阈值只改变判定口径，不改变已采集的消耗数据。
- 没有函数体的声明（接口/抽象函数）无法估算，列入 `noData` 并说明原因，不计为 0。
