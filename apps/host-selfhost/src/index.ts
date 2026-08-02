export { startServer } from "./serve";
export {
  makeSelfHostApp,
  makeSelfHostApiHandler,
  type SelfHostApiHandler,
  type MakeSelfHostAppOptions,
} from "./app";
export { loadConfig, type SelfHostConfig } from "./config";
export { BetterAuth, buildBetterAuth, betterAuthIdentityLayer } from "./auth";
export {
  verifyAndConsumePostdeployBinding,
  verifyPostdeployBinding,
  verifyReleaseEvidenceReceipt,
  type DeploymentVerificationExpectation,
  type PostdeployBindingAcceptanceInput,
  type PostdeployBindingVerificationInput,
  type ReleaseEvidenceVerifierLedger,
} from "./release-evidence/protocol";
export {
  createSqliteReleaseEvidenceVerifierLedger,
  initializeReleaseEvidenceVerifierLedger,
  type SqliteReleaseEvidenceVerifierLedgerOptions,
} from "./release-evidence/sqlite-verifier-ledger";
