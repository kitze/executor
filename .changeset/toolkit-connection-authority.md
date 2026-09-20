---
"@executor-js/plugin-toolkits": minor
---

Use toolkit connection membership as the operation authorization boundary. Included connections allow all operations without plugin-default or per-tool policy prompts; excluded connections and workspace ownership limits remain enforced. Remove toolkit policy editing from the toolkit UI.

Historical policy rows no longer grant connection access. Before upgrading, convert any policy-only connection grants into explicit toolkit connections. Existing toolkit API authentication and key revocation are unchanged; this does not bind account-wide API keys to a particular toolkit.
