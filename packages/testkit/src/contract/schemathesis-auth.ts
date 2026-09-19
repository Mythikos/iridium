/** Python hook loaded only inside the pinned fuzzer's disposable container. */
export const SCHEMATHESIS_AUTH_HOOK: string = String.raw`
import atexit
import json
import math
import threading
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import requests
import schemathesis

with open("/tmp/iridium-auth.json", encoding="utf-8") as fixture_file:
    fixture = json.load(fixture_file)


class FixtureSessionCache:
    """Own session recovery independently of Schemathesis's global 401 replay breaker."""

    def __init__(self):
        self._lock = threading.Lock()
        self._token = None
        self._session_id = None
        self._expires = 0
        self._failure = None
        self._stats = {
            "controlLogins": 0,
            "fixtureBearerRequests": 0,
            "protectedSuccesses": 0,
            "revocationInvalidations": 0,
            "wrongPassword401": 0,
            "expiredBearerInvalidations": 0,
        }

    def get(self):
        with self._lock:
            if self._failure is not None:
                raise RuntimeError(self._failure)
            if self._token is not None and time.monotonic() < self._expires:
                return self._token
            try:
                return self._login()
            except Exception:
                # A broken control fixture must fail visibly, never hammer login once per case.
                self._failure = "Isolated fixture authentication failed; start a fresh fuzz fixture."
                raise

    def _login(self):
        # This control URL has its own real source-IP bucket. Fuzz requests use the direct target.
        # The production 10/IP/minute limit still applies, including after repeated real logouts.
        deadline = time.monotonic() + 120
        while True:
            response = requests.post(
                fixture["url"],
                headers={"Host": fixture["host"], "X-Iridium-Client": "desktop"},
                json={
                    "email": fixture["email"],
                    "password": fixture["password"],
                    "client": "desktop",
                    "deviceName": "schemathesis",
                },
                timeout=10,
            )
            if response.status_code != 429:
                break
            retry_after = response.headers.get("Retry-After")
            if retry_after is None:
                raise RuntimeError("Isolated fixture login returned 429 without Retry-After")
            try:
                delay = float(retry_after)
            except ValueError:
                delay = (parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds()
            if not math.isfinite(delay):
                raise RuntimeError("Isolated fixture login returned invalid Retry-After")
            delay = max(1, delay)
            if time.monotonic() + delay >= deadline:
                raise RuntimeError("Isolated fixture login exceeded its bounded Retry-After wait")
            time.sleep(delay)
        if response.status_code != 201:
            raise RuntimeError("Isolated fixture login failed: HTTP " + str(response.status_code))
        body = response.json()
        token = body.get("token")
        session_id = body.get("session", {}).get("id")
        if not isinstance(token, str) or not token.startswith("irid_ses_"):
            raise RuntimeError("Isolated fixture login returned no session bearer")
        if not isinstance(session_id, str) or not session_id:
            raise RuntimeError("Isolated fixture login returned no session identifier")
        self._token = token
        self._session_id = session_id.lower()
        self._expires = time.monotonic() + 300
        self._stats["controlLogins"] += 1
        return token

    def observe(self, case, response):
        request = response.request
        with self._lock:
            # Inspect what was actually sent: auth checks can override Case headers deliberately.
            # Their rejected synthetic bearers must not invalidate the fixture's live session.
            if self._token is None or request.headers.get("Authorization") != "Bearer " + self._token:
                return
            self._stats["fixtureBearerRequests"] += 1
            security = case.operation.definition.raw.get(
                "security", case.operation.schema.raw_schema.get("security", []),
            )
            if security and all(security) and 200 <= response.status_code < 300:
                self._stats["protectedSuccesses"] += 1
            path = case.operation.path
            revoked = False
            if request.method.upper() == "DELETE" and 200 <= response.status_code < 300:
                if path == "/api/v1/auth/sessions/current":
                    revoked = True
                elif path == "/api/v1/me/sessions/{sessionId}":
                    session_id = (case.path_parameters or {}).get("sessionId")
                    revoked = isinstance(session_id, str) and session_id.lower() == self._session_id
            if revoked:
                self._stats["revocationInvalidations"] += 1
            if response.status_code == 401:
                try:
                    problem = response.json()
                except ValueError:
                    problem = {}
                # Wrong-password refusals are expected semantic checks; replacing the session
                # cannot change them. An expired/revoked bearer must be replaced before the next case.
                code = problem.get("code") if isinstance(problem, dict) else None
                if code == "invalid_credentials" and path in (
                    "/api/v1/auth/reauthenticate", "/api/v1/me/password",
                ):
                    self._stats["wrongPassword401"] += 1
                revoked = code in ("unauthenticated", "invalid_token")
                if revoked:
                    self._stats["expiredBearerInvalidations"] += 1
            if revoked:
                self._token = None
                self._session_id = None
                self._expires = 0


    def report(self):
        with self._lock:
            proof = dict(self._stats)
            proof["authenticationFailed"] = self._failure is not None
        print("IRIDIUM_SCHEMATHESIS_AUTH_PROOF " + json.dumps(proof, sort_keys=True), flush=True)


_fixture_sessions = FixtureSessionCache()
atexit.register(_fixture_sessions.report)


# 4.26.1 unions retry_on across providers into one global breaker: three intentionally wrong
# passwords would disable refresh for every operation. Own caching and invalidation instead.
@schemathesis.auth(refresh_interval=None).skip_for(
    path=["/api/v1/auth/sessions", "/api/v1/auth/set-password", "/healthz", "/readyz", "/metrics"]
)
class FixtureAuth:
    def get(self, case, context):
        return _fixture_sessions.get()

    def set(self, case, data, context):
        case.headers["Authorization"] = "Bearer " + data


@schemathesis.hook
def after_call(context, case, response):
    _fixture_sessions.observe(case, response)
`;
