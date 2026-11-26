# BUILD REPORT — assaycalc

Clean-room rebuild of `com.labreador/labreador` v1.0.0
(remote-only MCP server at `https://labreador.com/mcp`),
built 2026-10-28 as a forwarding client. Package: `@reneturcios/assaycalc`
0.1.0, registry name `io.github.CloudCorpRecords/assaycalc`.

## Surface built

Full surface: **all 3 captured tools built**, none omitted.

| Tool | Required fields as served |
|------|---------------------------|
| `fit_standard_curve` | `concentrations`, `signals` |
| `dietary_risk` | `ingestionRateKgPerDay`, `bodyWeightKg`, `elements` |
| `pollution_indices` | `elements` |

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`, with the `inputSchema.$schema`
marker (`https://json-schema.org/draft/2020-12/schema`) exactly
as captured, and `additionalProperties: false` on every tool,
as captured. `fit_standard_curve` carries the captured array
bounds (4–96 standards; `sampleSignals` up to 384), the `model`
enum `["4PL", "5PL"]` with default `"4PL"`, and the captured
`exclusiveMinimum: 0` on `concentrations` items only;
`dietary_risk` and `pollution_indices` carry their captured
nested element item schemas (names, bounds, and per-field rules
verbatim, including the optional `csf` on dietary elements,
which is not in that item schema's `required` array). The tool
literals were generated programmatically from
`harness/fixtures/labreador-tools-original.json` by the script
at `/tmp/laneb7-assaycalc-scratch/gen.py` (parse + re-serialise,
spliced into `src/forward.ts` between the TOOL_DEFS_GENERATED
markers) — never retyped — and the generator's own round-trip
check confirmed the spliced block deep-equals the fixture's 3
tool objects, in order. Tools are registered via the MCP SDK
low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

The surface is three compute-only scientific calculators over
caller-supplied laboratory numbers; nothing is sent, stored,
screened or sold by the rebuild itself, and no tool was
omitted.

## Fixture conflicts

**None.** The spec and the fixture agree on the tools' names,
titles, descriptions, the `required` arrays
(`concentrations`/`signals`; `ingestionRateKgPerDay`/
`bodyWeightKg`/`elements`; `elements`), and the property
shapes. The fixture's per-tool key set is exactly
`name`/`title`/`description`/`inputSchema` (the capture's
`annotations` key was dropped at slimming, per the fixture's
own `_source` note), and that is what is served.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://labreador.com/mcp`.
- Env override `LABREADOR_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no
  auth header is ever sent, under any environment. Tests
  assert that no `Authorization` header (and no `X-API-Key`
  header) is sent with an empty environment, with a
  `LABREADOR_API_KEY`-style variable present, and with
  `AUTHORIZATION` / `API_KEY` / `LABREADOR_TOKEN` variables
  present.
- Error rendering `assaycalc error:` text for upstream
  failures — labelled reconstruction.
- Upstream results pass through verbatim, including `isError`
  and extra fields. tools/call is forwarded as streamable-HTTP
  JSON-RPC: initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring
  `Mcp-Session-Id` when issued; plain-JSON and SSE replies are
  both parsed. The forwarding core takes an injectable fetch;
  tests stub the upstream — no live network calls in tests,
  and no live call is claimed beyond the coordinator's
  tools/list capture.

## Deviations

**None.** No write-guard workaround was needed in this
session: the lockfile, `npm ci`, `tsc` build, test suite and
parity run all completed through the normal routes, in
session, in the prescribed order. `dist/` is the direct
output of `./node_modules/.bin/tsc` over the validated
sources.

## Lockfile

**Status: COMPLETE, Route 3 from birth.**

- Generated first, in a clean directory (no `node_modules`,
  no pre-existing lockfile):
  `npm install --package-lock-only --ignore-scripts --offline`
  → success. Parses as JSON; `name` ==
  `@reneturcios/assaycalc`; exactly **128** package entries;
  sha256
  `764965eb169995ee4d72ec6f0d575a86e8c7e12b6df3b9b55347ffc24082fc6f`.
- `npm ci --ignore-scripts --offline` → success; lockfile
  sha256 re-verified **unchanged** afterwards.

## server.json

- Description exactly: "Bioassay and ecotoxicology calculators: ELISA curve fitting, dietary risk and pollution indices." — **96 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/assaycalc:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio.
  Dockerfile (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/assaycalc"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/assaycalc`
  and its smoke test asserts the server name `assaycalc`.

## Verification (run 2026-10-28, builder session)

1. Lockfile: Route 3 as above — parses, name
   `@reneturcios/assaycalc`, **128** entries, sha256 unchanged
   after `npm ci`.
2. `./node_modules/.bin/tsc --noEmit` → exit 0.
3. `./node_modules/.bin/tsc` (build) → exit 0; `dist/` complete.
4. `node dist/cli.js --version` → `0.1.0`.
5. `npm test` → **65 tests, 65 pass, 0 fail** (registration
   integrity deep-equals the served tools/list against the
   fixture's 3 tools, at both the TOOL_DEFS level and through
   an in-memory MCP transport; per-tool schema assertions for
   the captured bounds, enums, defaults and nested element
   schemas; session handling/reuse, env override, the
   no-Authorization-header assertions under every environment,
   verbatim argument forwarding and result pass-through
   including upstream isError, SSE parsing, error rendering,
   MCP-layer validation, and CLI behaviour).
6. Parity (harness, tools-file mode):
   `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/labreador-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/assaycalc/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/assaycalc/parity-out`
   → **verdict PASS, parity 100.0** (3/3 identical, 0 missing,
   0 extra, no schema diffs). Output in `parity-out/`.
7. Consistency sweep: `package.json` version = `server.json`
   top-level version = npm-entry version = OCI identifier tag
   = core `VERSION` = newest CHANGELOG heading (`0.1.0`);
   `package.json` `mcpName` = `server.json` `name` = Dockerfile
   server-name label; exactly 19 factory files present.
