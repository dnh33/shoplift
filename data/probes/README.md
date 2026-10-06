# data/probes — live probe output vs pinned offline pins

Live probes (`scripts/probe-dandomain.mjs`, MCP `dandomain_probe`) write
per-run JSON and `probe-log.jsonl` here. Those run artifacts stay **gitignored**.

These files are **tracked** so a fresh clone can pass `npm test` without a
DanDomain shop (the DanDomain client suites and the probe kit load them at
import time — they do not “skip loudly” when missing):

| File | Used by |
|---|---|
| `service.wsdl` | `test/operations.test.mjs`, `test/xml.test.mjs`, `scripts/probe-dandomain.test.mjs` (`wsdlPageOps`), generator |
| `gaps.json` | `test/operations.test.mjs`, `test/xml.test.mjs`, `test/client.test.mjs` |
| `scale.json` | `test/xml.test.mjs`, `test/client.test.mjs` |
| `gqlshapes.json` | `test/graphql.test.mjs`, registry pin in `src/dandomain/graphql.js` |
| `pagebase.json` | page-base evidence / client assertions (R34) |
| `completeness-blog.json` | `test/source-dandomain.test.mjs` blog field pin |

Do not commit `probe-log.jsonl`, shop-specific matrices, or write-probe scratch
JSON. Re-run probes on a scratch shop when the platform changes; refresh the
pins above only when a deliberate offline-test update is required.
