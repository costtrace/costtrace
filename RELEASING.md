# Releasing CostTrace

All seven packages (`costtrace`, `@costtrace/focus`, `core`, `aws`, `azure`, `gcp`, `mcp`) are
versioned together and released from GitHub Actions with
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). No npm token exists anywhere,
and every package carries signed provenance.

## How changes get into a release

Every pull request that changes a package includes a **changeset**, a short note saying what changed
and whether it's a patch, minor or major change:

```bash
npx changeset          # pick the bump type and write a one-line summary
```

The changeset file (`.changeset/*.md`) is committed with the PR. Docs-only or CI-only changes don't
need one.

## Cutting a release

1. **Prepare the release PR.** From an up-to-date `main`:
   ```bash
   git checkout -b release/next
   npm run version-packages   # applies the changesets: bumps all versions, writes CHANGELOG.md files
   git commit -am "Release vX.Y.Z"
   git push -u origin release/next
   ```
   Open a PR, check the versions and changelogs, and merge it once CI passes.

2. **Tag the merged commit:**
   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. **Approve in GitHub (gate 1).** The Release workflow verifies the tag matches every package
   version and runs the tests, then pauses. Open **Actions → Release → Review deployments**, select
   `npm`, and approve. The libraries (`focus`, `core`, `aws`, `azure`, `gcp`) are then published.

4. **Approve on npm with 2FA (gate 2).** The CLI and MCP server, which people run directly, are
   only *staged*. After npm's automated review (about 5–10 minutes), approve them, **the CLI first**:
   ```bash
   npm stage list costtrace           # note the stage id
   npm stage approve <stage-id>
   npm stage list @costtrace/mcp
   npm stage approve <stage-id>
   ```
   "Automated review hasn't finished" just means wait a few more minutes.

5. **The website deploys automatically** from the same tag (the Website workflow), so costtrace.io
   always matches what's on npm.

6. **Verify:**
   ```bash
   npm view costtrace version
   npx -y costtrace@X.Y.Z --help
   ```

## If something goes wrong

- **Re-running is safe.** Both workflows skip package versions that are already on npm. After fixing
  the cause, use **Re-run failed jobs** on the same tag. Release tags are protected and can't be
  moved, so a broken tag means a new patch version.
- **`E401` / "Unable to authenticate" for one package:** its trusted publisher is missing or wrong.
  Check it with `npm trust list <package>`. It must be GitHub Actions, `costtrace/costtrace`,
  `release.yml`, environment `npm`. The CLI and MCP server need *stage publish*; the libraries need
  *publish*.
- **A brand-new package:** npm only allows trusted publishing for packages that already exist.
  Publish its first version by hand (`npm publish -w <name> --access public`, with 2FA), then add
  the trusted publisher:
  ```bash
  npm trust github <name> --file release.yml --repo costtrace/costtrace --env npm --allow-publish --yes        # library
  npm trust github <name> --file release.yml --repo costtrace/costtrace --env npm --allow-stage-publish --yes  # CLI-like
  ```
- **The website only:** Actions → Website → Run workflow.
