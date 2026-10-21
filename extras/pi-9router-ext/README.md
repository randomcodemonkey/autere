# pi-9router-ext (autere fork)

Fork of [pi-9router-ext](https://github.com/irfansofyana/pi-9router-ext) 0.2.4
(MIT), maintained in `autere/extras/`. It connects pi to 9router through
9router's OpenAI-compatible API and registers the `9router` provider.

Differences from upstream (see the `index.ts` header for the full rationale):

- **No external metadata service.** Upstream fetched
  `https://models.dev/api.json` (24h disk cache) to derive model metadata. The
  only field it actually used was image input support, which 9router reports
  itself as `capabilities.vision` on `/v1/models`. Capabilities now come
  entirely from 9router's own payload; the metadata fetch, cache, index and
  fuzzy id lookup are gone. Upstream's lookup also failed on combo routes:
  `deepseek-combo` resolved to no metadata (images silently stripped) and
  `glm-5.3-flash-combo` could resolve to `glm-5.3`.
- **Combo thinking levels are pinned off inline** in `mapNineRouterModel`,
  replacing the separate `pi-combo-reasoning` extension that had to
  re-register the provider after async discovery to avoid racing it.

Deployment note: this extension is **always installed and not user-toggleable**
for 9router deployments. It is excluded from Settings → Extensions and from the
dashboard Extensions card by `ALWAYS_ENABLED_EXTRAS` in
`src/backend/user-settings.ts`. When `AUTERE_PROVIDER` names a different
provider, it is not installed at all.

Development:

```bash
npx tsc --noEmit -p extras/pi-9router-ext/tsconfig.json
npx eslint extras/pi-9router-ext/
```
