---
"@executor-js/execution": patch
"@executor-js/plugin-openapi": patch
"@executor-js/sdk": patch
---

Keep request-only fields and public recursive schemas from making otherwise readable OpenAPI responses opaque, migrate stored catalogs to the new sensitivity contract, and prevent empty sensitive values from corrupting execution result envelopes.
