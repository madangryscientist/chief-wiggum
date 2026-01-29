---
description: Analyze current logs for patterns and inefficiencies
---
Read the file `.ralph/ralph-history.json` and present a concise loop summary.

The file contains:
- `iterations` — array of iteration objects with: `iteration`, `startedAt`, `endedAt`, `durationMs`, `toolsUsed` (Record<string, number>), `filesModified` (string[]), `exitCode`, `completionDetected`, `errors` (string[])
- `totalDurationMs` — total time across all iterations
- `struggleIndicators` — `repeatedErrors` (Record<string, number>), `noProgressIterations`, `shortIterations`

Present:
1. Total iterations, total time, avg time per iteration
2. How many iterations detected completion vs had errors
3. Top 5 tools used (aggregated across iterations)
4. Files modified (deduplicated, cap at 10)
5. Struggle indicators if any (no-progress iterations, short iterations, repeated errors)

If the file doesn't exist or has no iterations, say "No iteration history available."
