# models.dev snapshot provenance

- Source: `https://models.dev/api.json` (real fetch, not synthetic)
- Retrieved: 2026-07-16 (UTC), via `curl -sS https://models.dev/api.json -o fixtures/models-dev-api.snapshot.json`
- Size: 3,179,221 bytes — under the 5 MB trim threshold, so the snapshot is
  the FULL upstream payload, untrimmed (166 providers, 5666 models).
- sha256: `e6849995edce112efb56af64dd65777f0e73512546133572e62661aae56413a9`

## Pinning observations (feeds §7.3 "recorded upstream version")

- `api.json` carries NO version field of any kind: the top level is a pure
  `{provider_id: provider}` map (verified: zero non-provider top-level keys).
  There is nothing in-band to record as an "upstream version".
- models.dev publishes no standalone JSON Schema endpoint; its "CI-validated
  schema" lives as source-code validators in the models.dev repository. A pin
  therefore has to be **retrieval date + content sha256** (as recorded here),
  optionally plus the models.dev repo commit hash fetched separately — the
  payload alone cannot self-identify.
