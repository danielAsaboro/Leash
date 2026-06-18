/**
 * Mesh-offload status — the phone borrows chat compute from a provider it auto-discovers in
 * its joined mesh (see `meshClient.pickChatProvider`). Borrowing is automatic: no provider key
 * is ever typed, hardcoded, or persisted. "online" = currently borrowing from a live provider;
 * "unset"/"offline" = chat is running on-device. Kept as a tiny shared type for the read-only
 * status shown on the Settings / Economy screens.
 */
export type OffloadStatus = "unset" | "online" | "offline";
