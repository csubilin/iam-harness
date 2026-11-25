# The patches this platform keeps against DeepSeek Harness

Two files, and they are the whole of what this repository changes in the harness
checkout. Everything else the platform adds to the harness — the three plugins,
the brand mark, the appearance and language the preview is given — is a *plugin*,
installed into a profile, and needs no patch at all.

| Patch | What it does | Why it cannot be a plugin |
|---|---|---|
| `desktop-webgpu.patch` | Turns on Vulkan for WebGPU in the Electron shell | It is a Chromium process switch, set before any page exists |
| `iam-harness-rebrand.patch` | The product's name and icon, in the harness's own user-visible strings and assets | A window title, an installer name and a tab icon belong to the application, not to a plugin mounted inside it |

## Why patches, and not a fork

The harness is a separate checkout on its own upgrade schedule. A branch would
have to be rebased, a vendored copy would have to be re-vendored, and both turn
"upgrade the harness" into a merge. A patch is versioned with the thing that
needs it, applies in one command, and — the part that matters — is *readable*:
each file says what it changes and how to tell whether a future harness still
needs it.

## Read this first: this fork already carries both

`D:\dev\MiningFlatform\iam-harness` is a **fork**, and both changes are committed
in it — `5825bbbb75` and `0d42d522bd` carry the rebrand, and the Vulkan switches
are in `apps/desktop/src/main.ts` and in the built `apps/desktop/lib/main.js`.
`git apply --check` on either patch therefore FAILS against this checkout, and
that is the expected answer rather than a broken patch: the changes are already
there.

Measured 2026-10-09 on this fork:

```
$ git apply --check desktop-webgpu.patch
error: patch failed: apps/desktop/src/main.ts:141
$ git apply --check iam-harness-rebrand.patch
error: git diff header lacks filename information ... at iam-harness-rebrand.patch:122
```

So there is nothing to apply here. The rest of this file is what the patches are
**for** — applying them to a pristine `deepseek-ai/deepseek-harness` checkout,
which is what a fresh clone gives and what an upgrade back to upstream would
leave you with. Everything else the platform adds is a plugin and needs none of
this.

## Applying them, to an upstream checkout (not to this fork)

```sh
cd /path/to/deepseek-harness        # a pristine upstream clone
git apply /path/to/IAX/IAM/plugin/harness/desktop-webgpu.patch
git apply /path/to/IAX/IAM/plugin/harness/iam-harness-rebrand.patch

# The client libraries and the web application are built artifacts.
pnpm build:lib:client
pnpm build:web

# The desktop shell's runtime bundle.  Both halves are needed and neither is
# enough: `tsc -b` emits under apps/desktop/lib/types and leaves lib/main.js --
# what Electron actually loads -- untouched, while `tsdown` bundles lib/types
# and so cannot see a change `tsc -b` has not compiled yet.  The package's own
# `build` script is the two in order, which is why it, and not `tsdown` alone,
# is the command here.  Measured 2026-10-07: running only `tsdown` after the
# patches left both switches out of lib/main.js, silently.
pnpm --filter @deepseek-ai/dsh-desktop run build
```

Order matters only in that `desktop-webgpu.patch` should go first if you apply
both in one go: both touch `apps/desktop/src/main.ts`, and while they touch
different parts of it, applying the rebrand first would leave the context its
hunks expect unchanged and is therefore fine as well. Both were re-generated
2026-10-07 against the fork's head `5825bbbb75` — upstream's `5badb15009`
(0.2.1-alpha.1) plus the Linux-desktop commits this platform keeps in the fork —
and verified to apply cleanly one after the other. They were also verified to
apply cleanly to a pristine upstream `5badb15009` on its own, which is what a
fresh clone of `deepseek-ai/deepseek-harness` gives.

## `desktop-webgpu.patch`

Explained in full inside the file. In one line: the Electron shell does not
enable Chromium's Vulkan backend, so a page in the desktop carrier gets
`navigator.gpu` and no adapter, and the preview pane cannot draw. The file also
carries the check for whether a future harness still needs it.

## `iam-harness-rebrand.patch`

### What it changes

Only what a user can see, and only the product's own name — never the model
provider's, and never a package identifier.

- **The web application** — `<title>`, the PWA manifest's `name`/`short_name`,
  the two favicons, and `DEFAULT_CLIENT_TITLE`, which is the title a local build
  gets when `DSH_CLIENT_TITLE` is unset.
- **The product name in every dictionary that carried it** —
  `packages/client/locale`'s `brand.localBuild` (the sidebar's text fallback and
  the non-official build's `document.title`), plus the account, models, plugin
  manager and Office-preview dictionaries.
- **The Electron shell** — `productName`, `artifactName`, the registered URL
  protocol's display name and the microphone usage description in the
  electron-builder configuration; the About panel's `applicationName`; the
  desktop locale's menu, tray, welcome and update strings; the packaged `.app`
  and `.exe` names the packaging and smoke-test scripts look for; the Windows
  installer's NSIS strings and its extraction-failure report.
- **The artwork** — the application icons (SVG and PNG, macOS/Windows/tray) and
  the welcome page's brand row, all regenerated from
  `IAX/IAM/Assets/mining-platform-icon.svg`. The four raster files — the
  three PNGs and the Windows tray `.ico`, which no SVG hunks can carry — travel
  as `GIT binary patch` hunks, which is why this file is a few hundred kB rather
  than a few tens.
- **The sidebar's brand mark** — `ui-sidebar`'s two
  `renderSlot('sidebar.brand.mark', …, { fallback })` sites draw
  `IamBrandMark` (a new file beside them, holding the same four paths as
  `IAM/plugin/Brand`) instead of the whale `FishLogo`. Added 2026-10-07: until
  then the mark was the plugin's business alone, and every profile without that
  plugin installed — which is every fresh one, and both of this machine's — drew
  the harness's fish and the words from the rebranded `brand.localBuild`. The
  fallback is what a profile with no occupant shows, so patching it is what
  makes the mark the *default* rather than something each profile has to opt
  into. The fish itself is untouched: `FishLogo` and `ui-brand-official` still
  draw it, and an official build still occupies the slot with it.

  **The two copies of the mark have to be changed together** — this one and
  `IAM/plugin/Brand`'s — and they render identically, so a profile with the
  plugin installed draws the occupant and one without draws the fallback with
  nothing to tell them apart. The plugin's copy is the one that will drift
  first, being the one a designer edits, while the fallback is the one nobody
  looks at. The plugin is optional now: the fallback alone is enough, and
  `dsh plugin --profile <p> remove dsh-iam-brand` drops it.

### What it deliberately does NOT change

- **The npm scope `@deepseek-ai/`** and the **`dsh` command name**. Renaming
  either is not a UI change: the scope appears in roughly 4,800 files, in every
  plugin manifest's peer relations and in the plugin manager's own display of
  installed packages, and a rename would make the next harness upgrade
  unmergeable.
- **`ui-brand-official`'s artwork** — `BrandWordmark` and the `FishLogo` it
  draws. That package is what an *official* build occupies the slots with;
  `IAM/plugin/Brand` answers the same question for every other profile, and the
  patch changes only a comment in it.
- **The model provider's name.** "DeepSeek models", "DeepSeek Account" and the
  provider rows are about the service the harness talks to, not about the
  application, and a user reading "IAM Harness Account" would be reading
  something untrue.

### Known consequences

The harness's own test suite asserts the old brand in a handful of places:
`apps/web/tests/pwa-manifest.e2e.ts`, `apps/web/tests/assembled-boot.ts`,
`scripts/client-build-environment.client.spec.ts` and
`packages/client/ui-layout/tests/document-title.client.spec.tsx` among them, and
the desktop's `tests/expected/*` fixtures. **Those are not updated by the
patch.** This platform does not run the harness's suite; a checkout that does
will see those assertions fail, and the fix is to update the expected strings —
they are the same substitutions the patch makes.

### How to tell whether a future harness still needs it

```sh
cd /path/to/deepseek-harness
git apply --check /path/to/IAX/IAM/plugin/harness/iam-harness-rebrand.patch
```

A clean `--check` means the strings are still where the patch expects them. A
rejection naming a file means that file moved and the patch needs the same edit
made against the new one — the substitutions are listed above, and they are all
`DeepSeek Harness` → `IAM Harness` in user-visible copy.
