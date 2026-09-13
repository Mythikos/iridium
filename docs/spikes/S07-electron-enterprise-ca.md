# S07 — Enterprise CA trust and certificate pinning in Electron

## Question

Does Electron 44.3.0 trust a private enterprise CA installed in the operating system certificate
store (Windows certificate store, macOS keychain, Linux NSS `certutil -d sql:$HOME/.pki/nssdb`) for
renderer `fetch` and WebSocket issued from `app://iridium` and for `net.fetch` in main; does
`certificate-error` fire for subresources; and does a `setCertificateVerifyProc` pin scoped to one
host work?

## Why it blocks

Enterprises terminate TLS with a private CA. Electron's network stack does not read
`/etc/ssl/certs` on Linux, and the behaviour differs per operating system, so an undocumented answer
turns a desktop rollout into an opaque first-launch failure
(`14-risks-and-open-questions.md`, "S7"). Three M5 scope rows are written from the answer: the
server-profile store's `pinnedCertSha256` field and the `setCertificateVerifyProc` wiring scoped to
the pinned host (`12-milestones.md` §4.4, `apps/desktop/src/main`), the enterprise CA trust guidance
kept in `docs/ops/deployment.md`, and M5's demonstrable behaviour "sign-in succeeds against an
enterprise CA-issued certificate trusted from the OS store". M0 also owes the desktop shell an
answer about `certificate-error`, because the shell must never override a certificate error and needs
to know which requests the event can even be observed for.

## Pinned versions

| Component | Exact version | Where it comes from |
|---|---|---|
| `electron` | `44.3.0` | `pnpm-workspace.yaml` catalog; confirmed at runtime as `process.versions.electron = 44.3.0` |
| Chromium (inside Electron) | `152.0.7977.78` | `process.versions.chrome` |
| Node (inside Electron) | `24.20.0` | `process.versions.node` |
| V8 (inside Electron) | `15.2.124.19-electron.0` | `process.versions.v8` |
| Node (harness and TLS server) | `24.11.0` | the development machine's pinned toolchain |
| `openssl` (throwaway PKI) | `OpenSSL 3.2.3 3 Sep 2024` | MSYS2 `/mingw64/bin/openssl` |
| Operating system | Windows 11 Home 10.0.26200, `win32-x64` | the only host available for this spike |
| `certutil.exe` | Windows 11 in-box | `%SystemRoot%\System32\certutil.exe` |

Hardening under test: the harness window's `webPreferences` are loaded from the committed snapshot
`apps/desktop/src/main/__snapshots__/desktop.webPreferences.json`, with only `preload` and
`partition` overridden, so the probes run behind `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false` and `webSecurity: true` exactly as a packaged load does. The renderer
reported its own origin as `app://iridium`.

## Method

Harness: `apps/desktop/spikes/s07/` (throwaway; deleted when M5 lands the real profile store).

- `endpoints.mjs` — four loopback TLS endpoints. Hostnames are `*.localhost` labels
  (`iridium-test.localhost`, `other-test.localhost`, `pinmiss-test.localhost`), because Chromium's
  host resolver maps `localhost` and every `*.localhost` label to loopback internally. That yields
  two *distinct* hostnames — which the host-scoping clause needs — with **no `hosts` entry and
  therefore no administrator rights**, while `subjectAltName` DNS verification is still exercised for
  real. No leaf uses an IP SAN.
- `tls-server.mjs` — the four HTTPS servers, each with `GET /ok` (JSON, `Access-Control-Allow-Origin: *`),
  `GET /pixel.png` (a 1×1 PNG used as the subresource) and a hand-rolled RFC 6455 echo endpoint on
  `/ws`. Every request, WebSocket upgrade and `tlsClientError` is appended to a `.jsonl` log, so each
  clause has a server-side witness independent of what the client reports.
- `main.mjs` — the Electron harness: `app.enableSandbox()` and `protocol.registerSchemesAsPrivileged`
  for `app` and `iridium-attachment` at module top level with the same privilege set as
  `src/main/scheme.ts`, a dedicated `persist:iridium-s07` partition,
  `session.protocol.handle('app', …)` serving the probe page with a per-load CSP of the packaged
  shape, `app.on('certificate-error')` recording every event and always answering `callback(false)`,
  and `session.webRequest.onErrorOccurred` recording the Chromium error string per URL and resource
  type.
- `renderer/probe.js` — served from `app://iridium/probe.js` under `script-src 'self'`; runs the
  `fetch`, WebSocket and `<img>` probes and records `securitypolicyviolation` separately so a CSP
  refusal can never be misread as a TLS failure.
- `run.mjs <phase> <pkiDir> <outDir>` — starts the endpoints, launches Electron once for that phase,
  collects the JSON.

Throwaway PKI (`openssl`, RSA-2048, SHA-256, 2-day validity, `basicConstraints critical CA:TRUE,pathlen:0`
on the CAs, `extendedKeyUsage serverAuth` plus a DNS SAN on the leaves):

| Certificate | SHA-256 of DER | Purpose |
|---|---|---|
| CA **A** | `d0a7706210c3015c76a1c85f8a8d334ed66235284bd9d689301d10ec5170c979` | the "enterprise" CA, intended for the OS store |
| CA **B** | `444edcbeaa57083ae655ad80ff1dea4f3506b7eb42e08ff02fbf4cc6a7d0691c` | never installed anywhere |
| `leafA_iridium` (CA A, `DNS:iridium-test.localhost`, port 18701) | `8bccbabe3120908ab134f894f192438580ab9f19a810335d9b6f4447f9864284` | the OS-store leg |
| `leafB_iridium` (CA B, `DNS:iridium-test.localhost`, port 18702) | `84c9bd0d55408fad1f4310dc31f1888d199ee98e9787ddeb28ba121893330c13` | the pinned leaf |
| `leafB_other` (CA B, `DNS:other-test.localhost`, port 18703) | `d042621850113a4f25a59f59c0ad2b5fcc98632d917fcb7220417ce1d70f379b` | the host-scoping control |
| `leafB_pinmiss` (CA B, `DNS:pinmiss-test.localhost`, port 18704) | `f31f200f0433db9344ade7544cb676673c98e3805fdca2ab85c1aa5b11130905` | spare host, unused in the final runs |

Three phases, one Electron launch each with its own `userData`, so no certificate-verification cache
is shared between them:

| Phase | Trust state | What it runs |
|---|---|---|
| `trusted` | nothing added to any certificate store | renderer `fetch` / WebSocket / `<img>` against CA A and CA B, main `session.fetch` and bare `net.fetch` against both, and a top-level navigation in a second window as the `isMainFrame` baseline |
| `pinned` | nothing added; a verify proc pinned to (`iridium-test.localhost`, `84c9bd…0c13`) installed *after* a control stage | the control, then renderer `fetch` / WebSocket / `<img>` against the pinned leaf, a fetch to the *other* host on the same CA, a fetch to a publicly trusted origin, and five main-process fetches |
| `pinmiss` | nothing added; the same proc pinned to `iridium-test.localhost` with a deliberately wrong SHA-256 | renderer fetch and main `session.fetch` against the same leaf |

The verify proc is the design from `12-milestones.md` §4.4 verbatim: `callback(0)` when
`request.hostname` equals the profile's host **and** SHA-256 of the DER decoded from
`request.certificate.data` equals the profile's `pinnedCertSha256`; `callback(-3)` — defer to
Chromium — in every other case.

Reproduce:

```sh
cd apps/desktop/spikes/s07
node run.mjs trusted  <pkiDir> <outDir>
node run.mjs pinned   <pkiDir> <outDir>
node run.mjs pinmiss  <pkiDir> <outDir>
```

**What could not be run, and why.** The OS-store leg was not executed. `certutil -user -addstore Root`
needs no elevation on this machine (the shell was confirmed non-administrative:
`WindowsPrincipal.IsInRole(Administrator)` returned `False`), but it is **not non-interactive**: both
`certutil -user -addstore Root <ca.crt>` and `certutil -f -user -addstore Root <ca.crt>` block
indefinitely on a modal Windows `Security Warning` dialog (observed as a `certutil.exe` process whose
`MainWindowTitle` is `Security Warning`, still blocked after 15 s), and a human click was not
available in this environment. Both attempts were abandoned by terminating `certutil.exe` before the
dialog was answered.

**Certificate stores were left exactly as found. Nothing was installed and nothing was removed.**
`Cert:\CurrentUser\Root` held 63 certificates before the attempts and 63 after; a recursive search of
`Cert:\CurrentUser` and `Cert:\LocalMachine` for the throwaway CA's subject (`O=Iridium Spike S07`)
returned 0 matches after the run. The throwaway keys and certificates were generated in, and never
left, a scratch directory outside the repository; they expire two days after generation.

## Result

**`fail`** — against the register's pass criterion, which is a conjunction of four clauses. Three
were measured and hold; the OS-store clause was not measured on any operating system.

### Clause 1 — "TLS succeeds on all three OSes with the OS-store CA for both renderer and main": **not measured**

- **windows**: not run — the Windows user-store install is interactive (see Method). Recorded as a
  finding in its own right, below.
- **macos**, **ubuntu**: untested here; this machine is Windows only. Both belong in the
  `e2e-electron` job of `.github/workflows/ci.yml`, whose matrix is already
  `[ubuntu-latest, windows-latest, macos-latest]`.

What *was* established about the verifier itself, and what the CI re-run should assert:
`setCertificateVerifyProc` surfaces Chromium's own verdict on every handshake, and it distinguishes a
public root from a locally installed one. Measured verdicts, all from the `pinned` phase's proc log:

| `request.hostname` | `request.verificationResult` | `request.errorCode` | `request.isIssuedByKnownRoot` |
|---|---|---|---|
| `iridium-test.localhost` (CA B, not in any store) | `net::ERR_CERT_AUTHORITY_INVALID` | `-202` | `false` |
| `other-test.localhost` (CA B, not in any store) | `net::ERR_CERT_AUTHORITY_INVALID` | `-202` | `false` |
| `example.com` (public PKI) | `net::OK` | `0` | `true` |

So the platform verifier is live in this build and reachable from the proc. The assertion the per-OS
CI re-run should make is therefore exact and cheap: after the documented per-OS CA install, a
handshake to the private-CA host must report `verificationResult === 'net::OK'` **and**
`isIssuedByKnownRoot === false` — the second half being what distinguishes "the OS store was
honoured" from "a public root happened to match".

### Clause 2 — "fails for an untrusted CA": **holds**

`trusted` phase, with nothing in any certificate store. Every probe failed, from both sides:

| Probe | Result | Chromium error (`onErrorOccurred`) | Latency |
|---|---|---|---|
| renderer `fetch` → CA A leaf | `TypeError: Failed to fetch` | `net::ERR_CERT_AUTHORITY_INVALID` (`xhr`) | 34 ms |
| renderer WebSocket → CA A leaf | `error` event, no `open` | `net::ERR_FAILED` (`webSocket`) | 3 ms |
| renderer `<img>` → CA A leaf | `error` event | `net::ERR_CERT_AUTHORITY_INVALID` (`image`) | 2 ms |
| renderer `fetch` → CA B leaf | `TypeError: Failed to fetch` | `net::ERR_CERT_AUTHORITY_INVALID` (`xhr`) | 2 ms |
| renderer WebSocket → CA B leaf | `error` event, no `open` | `net::ERR_FAILED` (`webSocket`) | 2 ms |
| renderer `<img>` → CA B leaf | `error` event | `net::ERR_CERT_AUTHORITY_INVALID` (`image`) | 2 ms |
| main `session.fetch` → CA A leaf | rejects `Error: net::ERR_CERT_AUTHORITY_INVALID` | — | 27 ms |
| main bare `net.fetch` → CA A leaf | rejects `Error: net::ERR_CERT_AUTHORITY_INVALID` | — | 21 ms |
| main `session.fetch` → CA B leaf | rejects `Error: net::ERR_CERT_AUTHORITY_INVALID` | — | 2 ms |
| main bare `net.fetch` → CA B leaf | rejects `Error: net::ERR_CERT_AUTHORITY_INVALID` | — | 2 ms |

Server side, the four endpoints logged 11 `tlsClientError` events with code
`ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_UNKNOWN` and **zero** application requests and **zero** WebSocket
upgrades: the client aborted every handshake, so nothing reached the application layer. Zero
`securitypolicyviolation` events, so no failure above is a CSP artefact.

### Clause 3 — "succeeds for an untrusted CA only when the pin matches the leaf SHA-256, and only for that hostname": **holds**

`pinned` phase. Control stage first, with the proc not yet installed: renderer `fetch` to the CA A
host failed (`net::ERR_CERT_AUTHORITY_INVALID`, 18 ms) and main `session.fetch` failed the same way
(3 ms). Then the proc pinned to (`iridium-test.localhost`, `84c9bd…0c13`):

| Probe | Expected | Measured | Latency |
|---|---|---|---|
| renderer `fetch` → pinned host, pinned leaf | succeeds | HTTP 200, body `{"ok":true,"endpoint":"untrustedCA_iridium",…}` | 5 ms |
| renderer WebSocket → pinned host, pinned leaf | succeeds | opened, echo `echo:s07` received | 3 ms |
| renderer `<img>` subresource → pinned host | succeeds | `load`, `naturalWidth = 1` | 3 ms |
| renderer `fetch` → **other** host, same CA | fails | `TypeError: Failed to fetch`, proc returned `-3` | 2 ms |
| main `session.fetch` → pinned host, pinned leaf | succeeds | HTTP 200 | 1 ms |
| main **bare** `net.fetch` → pinned host, pinned leaf | *see finding below* | rejects `net::ERR_CERT_AUTHORITY_INVALID` | 19 ms |
| main `session.fetch` → **other** host, same CA | fails | rejects `net::ERR_CERT_AUTHORITY_INVALID` | 2 ms |
| main `session.fetch` → pinned host, **different** leaf | fails | rejects `net::ERR_CERT_AUTHORITY_INVALID` | 2 ms |
| main `session.fetch` → publicly trusted origin | succeeds | HTTP 200 | 1 ms |

Server side, the pinned endpoint logged a real `GET /ok` with `Origin: app://iridium` and
`sec-fetch-mode: cors`, a real WebSocket upgrade with `Origin: app://iridium` and
`sec-websocket-version: 13`, the `/pixel.png` subresource with `sec-fetch-dest: image` /
`sec-fetch-mode: no-cors` and no `Origin`, and the main-process fetch with no `Origin` and
`sec-fetch-mode: no-cors`. `other-test.localhost` logged only `tlsClientError`. So the pin does not
merely suppress an error — it completes the handshake and carries traffic, for `fetch`, WebSocket and
subresources alike, in both processes.

`pinmiss` phase, the same leaf against a pin of `0000…0001`: the proc was consulted once, returned
`-3`, and both the renderer `fetch` (20 ms) and main `session.fetch` (3 ms) failed with
`net::ERR_CERT_AUTHORITY_INVALID`; the server logged only `tlsClientError`. The pin therefore accepts
exactly one (hostname, leaf SHA-256) pair and nothing else.

The `-3`-for-everything-else half of the design is load-bearing and it works: with a host-scoped pin
installed, `main.session.fetch` to a publicly trusted origin still succeeded. A profile pin does not
break ordinary TLS for other hosts.

Two mechanical details worth carrying into the implementation:

- `request.certificate.fingerprint` is exactly `sha256/` + base64 of the same SHA-256 over the DER
  that the profile stores. Verified: the proc reported
  `sha256/hMm9DVVAj60fQxDcMfGIjRme6Y6Xh93rKLoSGJMzDBM=` for the leaf whose DER SHA-256 is
  `84c9bd0d55408fad1f4310dc31f1888d199ee98e9787ddeb28ba121893330c13`, and re-encoding the hex to
  base64 reproduces the string. The pin comparison needs no PEM or DER parsing — compare against
  `fingerprint` directly, or decode once and compare bytes.
- `renderer fetch` to the publicly trusted origin failed (`TypeError: Failed to fetch`, 103 ms,
  `net::ERR_FAILED` on `xhr`) while the *same* origin succeeded from main and the proc reported
  `net::OK` for it. That failure is CORS, not TLS: an `app://iridium` page is a foreign origin and
  `example.com` sends no `Access-Control-Allow-Origin`. No `certificate-error` and no
  `securitypolicyviolation` accompanied it. It is recorded only so the row is not misread.

### Clause 4 — "`certificate-error` behaviour for subresources documented": **holds — it does fire**

`app.on('certificate-error')` fires for subresource requests, with `isMainFrame: false`. In the
`trusted` phase it fired 7 times: once for each of the six renderer probes and once for the top-level
navigation baseline.

| Request | `isMainFrame` | `error` |
|---|---|---|
| `https://iridium-test.localhost:18701/ok` (renderer `fetch`) | `false` | `net::ERR_CERT_AUTHORITY_INVALID` |
| `wss://iridium-test.localhost:18701/ws` (renderer WebSocket) | `false` | `net::ERR_CERT_AUTHORITY_INVALID` |
| `https://iridium-test.localhost:18701/pixel.png` (`<img>`) | `false` | `net::ERR_CERT_AUTHORITY_INVALID` |
| `https://iridium-test.localhost:18702/ok` (renderer `fetch`) | `false` | `net::ERR_CERT_AUTHORITY_INVALID` |
| `wss://iridium-test.localhost:18702/ws` (renderer WebSocket) | `false` | `net::ERR_CERT_AUTHORITY_INVALID` |
| `https://iridium-test.localhost:18702/pixel.png` (`<img>`) | `false` | `net::ERR_CERT_AUTHORITY_INVALID` |
| `https://iridium-test.localhost:18702/ok` (top-level navigation) | `true` | `net::ERR_CERT_AUTHORITY_INVALID` |

Notable and asymmetric: the event is **renderer-only**. Across the three phases, 14 main-process
`net.fetch` / `session.fetch` failures produced **zero** `certificate-error` events — those calls
simply reject with `Error: net::ERR_CERT_AUTHORITY_INVALID`. The event also does not fire when the
verify proc has already accepted the certificate (`callback(0)` produced no event), and it *does*
still fire when the proc defers with `-3` and Chromium then rejects.

The top-level navigation baseline is worth stating, because it is the only path with a UI
consequence: `loadURL` to the untrusted host emitted `did-fail-load` with code `-202`
(`ERR_CERT_AUTHORITY_INVALID`) and left a blank window. There is no interstitial and no "proceed
anyway" affordance — Electron has no equivalent of Chrome's bypass page. Answering
`callback(false)`, which the shell always does, is therefore the whole of the behaviour: the user
sees an empty window unless the application renders its own message.

### Two things the plan did not anticipate

1. **The Windows user-store install is not scriptable.** `certutil -user -addstore Root`, with or
   without `-f`, raises a modal `Security Warning` and waits. It needs no elevation, but it needs a
   human. The register's method ("install the CA per OS … launch the packaged app on each OS") reads
   as an unattended step and is not one on Windows. This changes the deployment guidance rather than
   the code: a managed fleet must push the CA into `LocalMachine\Root` by Group Policy or Intune,
   where it is silent and machine-wide, and the per-user `certutil` route belongs in the
   documentation only as a single-machine procedure with the warning dialog described so the user
   knows what to click.
2. **A bare `net.fetch` in main does not inherit the profile's pin.** `net.fetch(url)` runs on
   `session.defaultSession`; the verify proc is installed on the app's own partition. Measured in the
   `pinned` phase: `session.fetch` to the pinned host succeeded (1 ms) while bare `net.fetch` to the
   same URL rejected with `net::ERR_CERT_AUTHORITY_INVALID` (19 ms). Every M5 main-process request —
   `ApiTransport`, the `iridium-attachment` handler, `updater.ts` — must therefore issue on the app
   session (`session.fromPartition('persist:iridium').fetch(…)`, or `net.fetch` with the session
   passed explicitly), never bare, or a pinned profile silently fails for exactly the requests the
   pin exists to serve. This is a guard worth grepping for.

Also observed, and flagged for confirmation rather than asserted: Chromium appears to cache
certificate-verification outcomes per session. In the `pinned` phase the proc was consulted 3 times
for 4 distinct verifications — the host that had already been verified-and-rejected during the
control stage was never re-offered to the proc after it was installed, and the request failed on the
cached outcome. The consequence to design around is that editing a profile's `pinnedCertSha256` at
runtime cannot be assumed to take effect for a host already contacted in that session.

## Decision

The plan keeps the per-profile `pinnedCertSha256` pin as designed — `setCertificateVerifyProc`
returning `0` only for a matching (hostname, leaf SHA-256) pair and `-3` otherwise, which is now
measured to accept exactly that pair for renderer `fetch`, renderer WebSocket, renderer subresources
and main `session.fetch` while leaving public TLS intact — promotes it from the Linux-only route to
the primary documented route for every private-CA deployment on all three operating systems, requires
every main-process request to issue on the app session rather than through a bare `net.fetch`, and
defers the operating-system trust-store leg to the `e2e-electron` matrix.

## Fallback executed

The register's recorded fallback, in full: *"Per-profile `pinnedCertSha256` through
`setCertificateVerifyProc` becomes the primary Linux route, with the per-OS admin guidance in
`docs/ops/deployment.md` written from the observed behaviour."* Because the OS-store leg is unmeasured
on **all three** operating systems rather than on Linux alone, the fallback is executed with that
wider scope:

1. **`docs/ops/deployment.md`** — the enterprise CA section is written from this note's observed
   behaviour: the per-profile fingerprint pin is presented as the primary path for a private-CA
   deployment on every operating system; the OS trust-store route is documented per operating system
   (Windows `LocalMachine\Root` by Group Policy or Intune as the fleet mechanism, with the per-user
   `certutil -user -addstore Root` procedure and its `Security Warning` dialog described as the
   single-machine alternative; macOS keychain; Linux NSS `certutil -d sql:$HOME/.pki/nssdb`) and
   carries the plain statement that it is verified by CI on each operating system rather than by this
   spike; and the failure a user sees when neither route is in place is described exactly — a blank
   window, `did-fail-load` with `-202`, no interstitial and no bypass.
2. **`apps/desktop/src/main`** (M5 scope row, unchanged in shape) — the profile store's
   `pinnedCertSha256` and the host-scoped `setCertificateVerifyProc` stay as specified, with the
   comparison made against `request.certificate.fingerprint`, and every main-process request issued
   on the `persist:iridium` session.
3. **`14-risks-and-open-questions.md`** — the S7 row's mitigation and the Impact score are re-scored
   to match: the pin is primary everywhere, and the OS-store route is a documented convenience whose
   verification lives in CI.

Executed by commit 71915f5, the M0 milestone commit on `main` that lands items 1–3; the three edits
above are the whole of the fallback.

## Follow-ups

- **`e2e-electron` gains the OS-store leg.** A `@smoke`-tagged Playwright electron test per
  operating system: install the throwaway CA by the per-OS mechanism the runner allows
  (`LocalMachine\Root` on `windows-latest`, `security add-trusted-cert` on `macos-latest`,
  `certutil -d sql:$HOME/.pki/nssdb -A` on `ubuntu-latest`), then assert through
  `setCertificateVerifyProc` that a handshake to the private-CA host reports
  `verificationResult === 'net::OK'` **and** `isIssuedByKnownRoot === false`, and that the same
  handshake fails once the CA is removed. This is the assertion that closes clause 1; until it is
  green, the OS trust-store route is documented but unverified.
- **A guard against bare `net.fetch` in main.** `apps/desktop/src/main` must not call `net.fetch`
  without a session for anything but `file://` reads inside `protocol.handle`. Add it to the CI greps
  of `07-client-applications.md` §7.4 alongside `webSecurity: false` and `ignore-certificate-errors`.
- **No upstream issue filed.** Nothing observed is an Electron defect: the renderer-only scope of
  `certificate-error`, the per-session scope of `setCertificateVerifyProc`, and the absence of a
  certificate interstitial are all documented Electron behaviour, and the `certutil` dialog is
  Windows'.
- **Confirm the verification cache.** The per-session caching described above is inferred from a
  missing proc invocation, not from an Electron API. If a profile's pin is editable without a
  restart, that needs a test; the simpler resolution is that changing `pinnedCertSha256` requires a
  window reload on a fresh partition.
- **Harness lifetime.** `apps/desktop/spikes/s07/` is throwaway and is deleted when M5 lands the real
  profile store, with the parts worth keeping moving into the `e2e-electron` test above.
