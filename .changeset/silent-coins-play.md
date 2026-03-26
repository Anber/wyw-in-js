---
'@wyw-in-js/shared': patch
'@wyw-in-js/transform': patch
---

Add support for custom `conditionNames` during eval-time fallback resolution so transform can honor package export conditions in monorepo development setups, while keeping extension retry limited to extensionless subpath requests.
