# Open Questions And Challenges

## Open Questions
1. Should the edge API be reachable only over a private network, or must it support an outbound reverse tunnel by default?
2. Is the first production target Linux-only on the mini PC, or must macOS remain a supported runtime?
3. Do we need true movie streaming, or is repeated preview capture enough for the first release?
4. Should the control server own user-facing auth only, with the edge API accepting service-to-service credentials exclusively?
5. Is the first version single-camera forever, or should the edge runtime reserve room for multi-camera support soon?

## Current Decisions
- The first remote trust model uses service bearer tokens between the control server and each edge node.
- The control API may use its own bearer token for clients and should stay on a trusted network boundary.
- Runtime app configuration stays environment-driven in both services.
- The first media sync policy is `metadataOnly` with `edgeManaged` retention.
- The first production edge target remains Linux-first even though local development also works on macOS.

## Technical Challenges
- `gphoto2` access is exclusive and sensitive to competing host processes
- Camera capabilities vary by model and firmware
- Long-running live view or record sessions need careful lease ownership
- Media download, upload, and retention policy can conflict if not explicitly modeled
- Remote connectivity to edge devices must be secured without requiring fragile inbound networking

## Mitigations
- Introduce an explicit session manager and operation queue
- Build the API around capability discovery
- Prefer jobs for long-running actions
- Keep destructive storage actions opt-in only
- Design the edge-control link for private or outbound-only connectivity
