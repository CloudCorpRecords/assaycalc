# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Labreador MCP server, a set of bioassay and ecotoxicology calculators. All three captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `fit_standard_curve` (fit a 4PL or 5PL logistic curve to ELISA standards, optionally interpolating sample concentrations), `dietary_risk` (Estimated Daily Intake, Target Hazard Quotient per element, Hazard Index and optional cancer risk for food contaminants), `pollution_indices` (contamination factor, geoaccumulation index and Pollution Load Index for one sample).
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `assaycalc error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `LABREADOR_MCP_URL`. The registry record declares no headers on the remote, so no auth header is ever sent.
