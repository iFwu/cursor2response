# Trace Viewer

- This is an operational investigation tool whose presentation and derived views change frequently.
- Do not add complex unit or regression tests for UI layout, translations, filters, or display-only projections by default. Prefer type-checking, a production build, and browser verification against a representative trace.
- Add the smallest focused test only when it protects a stable protocol contract, an input or security boundary, data integrity, or a costly-to-reproduce parser failure.
