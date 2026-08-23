# Manual GitHub App validation

The `app-validation` workflow is a deliberately manual, credentialed smoke test for the GitHub App. It is separate from the release workflow and has no inputs. It runs only on `refs/heads/main` in the `app-validation` environment. A missing or inconsistent environment value fails the job before the harness starts.

The harness exercises the configured installation against the public `kwlck/PatchProof` repository. It sends one synthetic `pull_request` delivery under the one-job, one-worker contract, then replays that same delivery to check duplicate handling, queue state, worker execution, the managed Check, and the managed summary comment. It does not send `issue_comment` events or exercise slash-command authorization; those paths are covered by automated tests, not this live credentialed harness. The harness uses localhost delivery. It does not validate a public endpoint. Public TLS webhook delivery is a separate authorization and deployment concern.

## One-time administrator setup

Create a GitHub App specifically for this validation environment, or use a dedicated installation of an existing App. Select only `kwlck/PatchProof`. Do not grant access to all repositories.

Configure these App permissions:

- Metadata: read
- Contents: read
- Pull requests: read
- Checks: read/write
- Issues: read/write

Subscribe only to the `pull_request` and `issue_comment` events. The App should not receive unrelated repository events.

Create a separate GitHub Actions environment named `app-validation` with all of the following protections:

- restrict deployment branches to `main`;
- require `kwlck` to approve before the job can access the environment;
- set the wait timer to zero;
- leave self-review prevention disabled while `kwlck` is the only maintainer; and
- do not use an administrator bypass during normal operation.

This solo-maintainer approval is a deliberate checkpoint against accidental execution, not independent review or account-compromise protection. A fresh human review of the exact harness SHA is mandatory before each credentialed run. When a trusted second maintainer exists, or before production use, require that maintainer as the reviewer and enable self-review prevention.

The environment has no secrets or variables yet. During setup, add exactly these environment secrets. Do not put them in repository variables, workflow files, command arguments, `GITHUB_ENV`, or step outputs:

- `PATCHPROOF_VALIDATION_APP_PRIVATE_KEY`
- `PATCHPROOF_VALIDATION_WEBHOOK_SECRET`

Add exactly these environment variables:

- `PATCHPROOF_VALIDATION_APP_ID`
- `PATCHPROOF_VALIDATION_INSTALLATION_ID`
- `PATCHPROOF_VALIDATION_REPOSITORY`
- `PATCHPROOF_VALIDATION_PR_NUMBER`
- `PATCHPROOF_VALIDATION_BASE_REF`
- `PATCHPROOF_VALIDATION_BASE_SHA`
- `PATCHPROOF_VALIDATION_HEAD_SHA`
- `PATCHPROOF_VALIDATION_PATCHPROOF_SHA`

`PATCHPROOF_VALIDATION_REPOSITORY` must be `kwlck/PatchProof`, `PATCHPROOF_VALIDATION_BASE_REF` must be `main`, and the SHA variables must be full lowercase commit IDs. `PATCHPROOF_VALIDATION_PATCHPROOF_SHA` must equal the SHA displayed by the manual dispatch. The other values identify the harmless validation pull request and the installation. The workflow fails closed when any required value is absent or inconsistent. Never record example secret values in documentation or issues.

## Safe validation procedure

1. In `kwlck/PatchProof`, create a harmless validation pull request from a branch in the same repository. Use a change that does not contain credentials, deployment actions, or untrusted commands.
2. Set the environment variables to the intended pull request and exact approved `main` SHA. Confirm that the base and head SHAs identify the expected commits.
3. From the `main` branch, open Actions, select **App validation**, choose **Run workflow**, and approve the protected environment request. There are no dispatch inputs to edit.
4. Inspect the fixed summary artifact and the Check and managed comment in the controlled repository. Confirm that the result names the expected repository, pull request, base, and head revisions.
5. Re-run only when the previous run is complete and the environment values still describe the intended validation pull request.

Do not use a third-party fork. Fork workflows are outside this authorization boundary and are intentionally not part of manual credential validation. A same-repository branch is sufficient to exercise the App installation without exposing its credentials to fork-controlled workflow code.

## Same-commit bundle boundary

The protected CI workflow creates `patchproof-app-validation-bundle` only after the normal checks succeed on a main push. The bundle is tied to the exact `github.sha` and contains the compiled production workspaces, the app-validation harness, fixtures including the Docker fixture, package metadata, and a dereferenced production runtime dependency closure. It contains no GitHub App secrets.

The manual workflow uses its read-only `GITHUB_TOKEN` only to find a completed successful `CI` run for the exact approved main SHA. It requires the workflow path, event, branch, conclusion, head SHA, repository, and numeric run/artifact identity. It downloads the fixed artifact name, checks archive paths, verifies the manifest inventory and every SHA-256 digest, then invokes `node scripts/app-validation.mjs` with no arguments. It does not install packages or resolve dependencies from a registry while credentials are available.

Only `work/app-validation/summary.json` is uploaded after the harness secret scan succeeds. The artifact is short-lived. A failed scan prevents upload.

For local deployment configuration, webhook transport, and worker boundaries, see [GitHub App setup](github-app-setup.md) and [Deployment](deployment.md).
