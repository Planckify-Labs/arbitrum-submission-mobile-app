/**
 * Node resolve hook for `EvmWalletKit.test.ts`.
 *
 * Plumbing only — NO kit logic here. Registers a hook (see
 * `_test-resolver-hook.mjs`) that:
 *   - Rewrites `@/*` to absolute file URLs (mirrors `tsconfig.json`).
 *   - Appends `.ts` / `.tsx` extensions to extensionless relative imports.
 *   - Stubs RN / Expo native modules (`expo-secure-store`, MMKV) that
 *     can't load under plain Node. The kit itself never calls these;
 *     they're only reachable via `services/walletService.ts` dwell-site
 *     imports that Task 05 is preserving unchanged.
 *
 * Loaded via `--import` + `module.register`.
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";

globalThis.__DEV__ ??= true;

register("./_test-resolver-hook.mjs", pathToFileURL(`${import.meta.dirname}/`));
