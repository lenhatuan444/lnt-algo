
## Run all (no concurrently)
```bash
npm run start:all
```
ENV toggles:
```
RUN_SCAN=1 RUN_TP=1 RUN_SL=1 RUN_API=1
SCAN_LOOP=1            # schedule by 4H close
SCAN_IMMEDIATE=1       # also run scanner once on start
SCAN_AFTER_CLOSE_MIN=1 # start scan +1m after each 4H close
TIMEFRAME_MS=14400000  # 4h
```
