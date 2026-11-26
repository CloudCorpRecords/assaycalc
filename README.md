# assaycalc

Three laboratory calculators, reached through one small local bridge. assaycalc is a forwarding client for the hosted Labreador MCP service: the tool list is answered from your own machine using captured definitions, and each call travels upstream with your measurement data, with the service's answer handed back exactly as it arrived. Nothing is calculated or stored locally.

All three of the service's captured tools are exposed. Fit an ELISA standard curve — a 4PL or 5PL logistic model over your standard concentrations and their optical-density signals — and optionally convert sample signals back into concentrations. Work out dietary exposure risk for contaminants in food: Estimated Daily Intake, a Target Hazard Quotient per element, the combined Hazard Index, and cancer risk where a slope factor is supplied. And score one sample's pollution load: a contamination factor and geoaccumulation index per element, rolled into a single Pollution Load Index. Each result echoes the inputs it was given, lists data-quality or plausibility warnings, and carries the Labreador citation the service requires.

## The tools

- **`fit_standard_curve`** — Fit a 4PL or 5PL logistic curve to ELISA standards. Takes `concentrations` and `signals` (4 to 96 paired values each, concentrations nonzero), an optional `model` (`4PL` by default, or `5PL`), and optional `sampleSignals` (up to 384) to interpolate into concentrations.
- **`dietary_risk`** — Dietary health risk for food contaminants. Takes `ingestionRateKgPerDay`, `bodyWeightKg`, and 1 to 40 `elements`, each with a `name`, a `concentrationMgPerKg`, an `rfdMgPerKgDay` reference dose, and an optional `csf` cancer slope factor. Returns EDI, THQ per element, HI, and cancer risk where a slope factor was given.
- **`pollution_indices`** — Pollution indices for one sample. Takes 1 to 40 `elements`, each with a `name`, the measured `sample` concentration, and a `baseline` background concentration in the same unit. Returns the contamination factor and geoaccumulation index per element plus the overall Pollution Load Index.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/assaycalc mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "assaycalc": {
      "command": "npx",
      "args": ["-y", "@reneturcios/assaycalc", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/assaycalc
docker run --rm ghcr.io/cloudcorprecords/assaycalc pollution_indices '{"elements":[{"name":"Pb","sample":45,"baseline":20}]}'
```

## CLI

A single binary covers both the command line and the MCP server. Every tool is a subcommand whose one argument is a JSON string of that tool's inputs:

```bash
assaycalc fit_standard_curve '{"concentrations":[0.1,1,10,100],"signals":[0.05,0.4,1.2,2.1]}'
assaycalc dietary_risk '{"ingestionRateKgPerDay":0.02,"bodyWeightKg":70,"elements":[{"name":"Hg","concentrationMgPerKg":0.5,"rfdMgPerKgDay":0.0001}]}'
assaycalc pollution_indices '{"elements":[{"name":"Pb","sample":45,"baseline":20}]}'
assaycalc --version
```

Exit codes: `0` for a successful forwarded call, `1` when the result that comes back is an error, and `2` for usage mistakes like an unknown subcommand or a JSON argument that does not parse.

## Configuration

- `LABREADOR_MCP_URL` — Replaces the upstream endpoint. Defaults to the pinned hosted endpoint, `https://labreador.com/mcp`. (This override variable is a reconstruction introduced by this rebuild.)

The Labreador registry record lists no headers for its remote, so assaycalc never attaches an authentication header — every call goes upstream keyless.

When the upstream cannot answer — it returns a JSON-RPC error, answers with a non-2xx status, sends a body that cannot be read, or the request itself fails — the caller receives an error result whose text begins with `assaycalc error:`.

## How forwarding works

The first call of a process opens a session against the upstream: an `initialize` request (protocol version `2025-03-26`), a `notifications/initialized` notification, and then the `tools/call`. If the service issues an `Mcp-Session-Id` header during initialize, assaycalc repeats it on subsequent requests and keeps reusing that one session until the process ends. Replies are understood in both plain JSON and server-sent-events framing. Successful results are passed through untouched, `isError` flag and any extra fields included.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The suite compares the served tool list against the captured surface tool for tool, walks the session handshake and its reuse, proves no `Authorization` header is sent under any environment, and confirms that arguments travel upstream unchanged and results return unchanged.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
