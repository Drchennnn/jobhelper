/**
 * Strongly typed branded identifiers to prevent mixing task/run/epoch/call/confirmation IDs.
 * See docs/ARCHITECTURE.md Section 3.
 */
declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type TaskId = Brand<string, 'TaskId'>;
export type RunId = Brand<string, 'RunId'>;
export type Epoch = Brand<string, 'Epoch'>;
export type SessionId = Brand<string, 'SessionId'>;
export type CallId = Brand<string, 'CallId'>;
export type QuestionId = Brand<string, 'QuestionId'>;
export type ConfirmationId = Brand<string, 'ConfirmationId'>;
export type TodoId = Brand<string, 'TodoId'>;
export type ClientMessageId = Brand<string, 'ClientMessageId'>;
export type ProfileId = Brand<string, 'ProfileId'>;
export type ProfileVersionId = Brand<string, 'ProfileVersionId'>;
export type MaterialId = Brand<string, 'MaterialId'>;
export type PositionId = Brand<string, 'PositionId'>;
export type ProviderId = Brand<string, 'ProviderId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type TabId = Brand<string, 'TabId'>;
export type BrowserProfileId = Brand<string, 'BrowserProfileId'>;
export type ActionId = Brand<string, 'ActionId'>;
export type EventId = Brand<string, 'EventId'>;
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;
export type ContentHash = Brand<string, 'ContentHash'>;
