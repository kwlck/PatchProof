# Verify the fixture evidence

The bundle in [`fixture-proof/patchproof.evidence.json`](fixture-proof/patchproof.evidence.json) was produced from the checked-in [`fixtures/pass`](../../fixtures/pass) example with PatchProof 0.9.3. The base exits with `EXPECTED_BUG`; the head passes. This is a **synthetic fixture**, not an external user case study or a claim that a GitHub App ran on a public webhook.

From a built source checkout, verify the committed bundle **without executing the scenario**:

```text
pnpm build
node packages/cli/dist/main.js verify docs/examples/fixture-proof/patchproof.evidence.json --json
```

The result should contain `"valid":true`, `"digestValid":true`, and `"artifactsValid":true`. To run the scenario yourself, select a new output directory:

```text
node packages/cli/dist/main.js run fixtures/pass/local.patchproof.yml --base fixtures/pass/base --head fixtures/pass/head --output work/my-fixture-run
```

The second command runs code locally because the fixture's trusted config explicitly opts into the development `local` backend. Only use this backend with source code you trust. With Docker and a production policy, use [`fixtures/pass/.patchproof.yml`](../../fixtures/pass/.patchproof.yml).

The hash verifies the bundle's bytes and logs. It does not prove who produced the evidence or attest that the recorded execution happened on an independent host.
