# Releasing OmniGPT

OmniGPT uses `package.json` as the release version source. The generated `OmniGPT.user.js` metadata must match it exactly.

## Automated repository pipeline

For every push to `main` that touches source, build, test, or release files, GitHub Actions will:

1. run `npm run check`;
2. rebuild `OmniGPT.user.js`;
3. verify `@version`, `@updateURL`, `@downloadURL`, and the stable namespace;
4. reject a changed distributable if the corresponding `vX.Y.Z` tag already exists (this forces a version bump);
5. commit the generated userscript back to `main` when needed;
6. create the `vX.Y.Z` git tag and GitHub Release if that version has not been released yet.

The distributable source of truth is:

```text
https://raw.githubusercontent.com/sakur7a/OmniGPT/main/OmniGPT.user.js
```

## One-time Greasy Fork setup

Greasy Fork script ID: `590463`.

Greasy Fork does not provide a write API for publishing updates. Its supported automatic publishing path is code synchronization plus a repository webhook.

While signed in as the owner of the Greasy Fork listing:

1. Open the OmniGPT script administration/edit page on Greasy Fork.
2. Configure code synchronization to use the raw URL above.
3. Select the webhook synchronization mode (wording may vary slightly in the UI).
4. Run one manual synchronization and confirm Greasy Fork can fetch the current userscript.
5. Open Greasy Fork's **Set up webhook** page (`/users/webhook-info`).
6. Generate a webhook secret if one does not already exist.
7. Copy the **GitHub webhook payload URL** and the **secret** shown there. Treat both as credentials; do not commit them to this repository.

Then, in GitHub for `sakur7a/OmniGPT`:

1. Open **Settings → Webhooks → Add webhook**.
2. Paste the payload URL supplied by Greasy Fork.
3. Set **Content type** to `application/json`.
4. Put the Greasy Fork webhook secret in GitHub's **Secret** field.
5. Keep SSL verification enabled.
6. Select **Just the push event**.
7. Keep the webhook active and save it.
8. Check **Recent Deliveries** and confirm the ping/push receives a successful 2xx response.

Once this one-time binding exists, a normal release is fully automatic:

```text
source change + package version bump
        ↓
GitHub Actions: build / verify / test
        ↓
OmniGPT.user.js updated on main
        ↓
GitHub push webhook
        ↓
Greasy Fork fetches the raw userscript
        ↓
Greasy Fork publishes the new version
        ↓
Tampermonkey users installed from Greasy Fork receive the update normally
```

## Publishing a new version

Before merging a distributable change, bump `package.json`, for example:

```json
{
  "version": "0.2.1"
}
```

Then run locally:

```bash
npm run check
```

After the change lands on `main`, the rest is automated. Do not hand-edit `@version` in `OmniGPT.user.js`; the build script generates it from `package.json`.

## Why the version bump is mandatory

Greasy Fork webhook synchronization reacts to changes to the synchronized file, not only to version-number changes. OmniGPT therefore enforces one immutable git tag per published version. If the userscript output changes after `vX.Y.Z` already exists, CI fails and requires a new version number.

## Verification after a release

Check these three places:

- GitHub Raw `OmniGPT.user.js` reports the expected `@version`.
- GitHub Releases contains the matching `vX.Y.Z` release and userscript asset.
- Greasy Fork script `590463` reports the same version.

If GitHub succeeds but Greasy Fork does not update, inspect **GitHub Settings → Webhooks → Recent Deliveries** first. A successful delivery with no Greasy Fork update usually means the Greasy Fork synchronization URL/mode is incorrect or the webhook is no longer associated with the owning Greasy Fork account.
