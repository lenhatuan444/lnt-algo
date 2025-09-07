# lnt-algo (multi-strategy)

## Run
```bash
cp .env.example .env
npm i
npm run start     # API + Scheduler + Realtime watcher (if enabled)
# or
npm run start:api
npm run start:scheduler
npm run start:rt
```

## Realtime Watch
- `RT_WATCH_MODE=active-only`  — chỉ theo dõi các symbol đang có position (paper) chưa thoát.
- `RT_WATCH_MODE=manual`       — chỉ theo dõi danh sách thủ công do API `/api/rt/watch` thiết lập.
- `RT_WATCH_MODE=all-active+manual` — hợp nhất cả 2 danh sách.

### API
- `GET  /api/health`
- `GET  /api/files`
- `GET  /api/latest/:kind` (`summary|trades|equity`)
- `GET  /api/:file/:kind`
- `GET  /api/paper/entries[.csv]?strategy=...`
- `GET  /api/paper/exits[.csv]?strategy=...`
- `GET  /api/paper/history[.csv]?strategy=...`
- `GET  /api/paper/equity[.csv]?strategy=...&normalize=1`
- `GET  /api/paper/positions?strategy=...`
- `GET  /api/paper/files?strategy=...`
- `GET  /api/paper/file/:name`
- `GET  /api/rt/watch?strategy=...`
- `POST /api/rt/watch?strategy=...` body: `{ "action":"add|remove|set", "symbols":["BTC/USDT"] }`

All paper endpoints support Mongo-first (when `MONGO_ENABLE=1`), else read CSV in `PAPER_DIR` with per-strategy prefix `<strategy>_`.
