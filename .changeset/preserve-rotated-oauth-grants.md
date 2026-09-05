---
"@executor-js/sdk": patch
---

Keep a successful OAuth refresh usable when another host rejects the spent token. Preserve provider metadata when clearing a stale rejection, expose connection failure reasons to agents, and direct non-terminal refresh failures to diagnosis rather than another login.
