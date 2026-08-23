import { describe } from "bun:test"

// Skipped: this spec was committed against an AttachmentStore API that does not
// exist (static `AttachmentStore.materialize` / `AttachmentStore.Default`).
// The real service exposes materialize/copyTo/inventory through
// AttachmentStore.Service, which requires the location-services graph that is
// still mid-migration on this branch. Rewrite against the Service API once the
// location-services migration lands. The attachment lowering itself is covered
// by test/session-runner-attachment.test.ts.
describe.skip("AttachmentStore", () => {})
