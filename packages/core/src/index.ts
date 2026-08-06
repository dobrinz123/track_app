export * from './contracts';

// A trivial, non-domain runtime value (package identity marker). Interfaces and
// type aliases in contracts.ts are erased at compile time, so a pure type-only
// import cannot prove @circuit/core is actually resolved and bundled by a
// consumer's build tool (e.g. Metro). This constant exists solely so
// apps/mobile can perform a real *value* import to verify that wiring.
export const CORE_PACKAGE_ID = '@circuit/core' as const;
