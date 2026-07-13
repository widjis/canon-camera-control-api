# Security And Access Model

## Trust Boundaries
- The edge API is trusted only by the control server or an operator on a private network.
- The control API is trusted by internal clients, automation, or an admin UI.
- The camera itself is not a trust boundary; it is a hardware dependency behind the edge agent.

## First Implementation
- Control API auth: bearer token via `CONTROL_API_BEARER_TOKEN`
- Edge API auth: bearer token via `API_BEARER_TOKEN`
- Control-to-edge trust: one stored bearer credential per registered edge device
- Edge credentials are stored only in the control database and are returned masked in control responses

## Audit Requirements
- Every control-plane action should record:
  - actor type
  - actor id
  - device id when applicable
  - action name
  - outcome
  - correlation id when provided
  - serialized details payload

## Hard Rules
- Do not expose the edge API directly to the public internet
- Prefer private networking, VPN, or an outbound tunnel initiated from the edge side
- Keep camera session ownership at the edge; the control plane must lease before mutating camera state
- Do not treat saved profiles or local config as the source of truth for live camera state

## Future Hardening
- Replace static bearer tokens with rotated credentials or mutual TLS
- Encrypt stored edge credentials at rest
- Add role-aware auth for control-plane users and audit log retention policies
