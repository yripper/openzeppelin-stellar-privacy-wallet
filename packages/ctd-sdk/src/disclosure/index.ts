// Off-chain selective-disclosure layer (SELECTIVE_DISCLOSURE.md).
// Holder side: proveDisclosure. Receiver side: generateRecipientKeys,
// newDisclosureRequest, verifyDisclosure. Both sides load the SAME circuit
// artifact + VK from @ctd/disclosure (§5.5 shared-artifact rule).
export * from "./types.js";
export * from "./recipient.js";
export * from "./prove.js";
export * from "./verify.js";
