/**
 * Python strategies copied into the pinned Schemathesis image before the authentication hook.
 * Formats describe refinements JSON Schema cannot express; generated values still pass the normal
 * schema constraints and runtime validators, and negative generation keeps every check enabled.
 */
import {
  BASE62_ALPHABET,
  CREDENTIAL_PREFIX,
  LIMITS,
  RESERVED_DEVICE_NAMES,
  TOKEN_CRC_LENGTH,
  TOKEN_ID_LENGTH,
  TOKEN_SECRET_LENGTH,
} from '@iridium/contracts';

// paths.ts tests the first/last UTF-16 code unit with JavaScript's whitespace class. Python's
// str.isspace has a different vocabulary, so carry the runtime's actual set into the hook.
const ECMASCRIPT_WHITESPACE = Array.from({ length: 0x1_00_00 }, (_, unit) =>
  String.fromCharCode(unit),
)
  .filter((character) => /\s/.test(character))
  .join('');

const FORMAT_POLICY = {
  maxNameBytes: LIMITS.NODE_NAME_MAX_BYTES,
  // One format serves both fields. Stay inside the narrower vault UTF-16 bound as well as the
  // shared byte bound; Unicode names can still reach the full byte limit.
  maxNameUtf16: LIMITS.VAULT_NAME_MAX_CHARS,
  reservedDeviceNames: RESERVED_DEVICE_NAMES,
  whitespace: ECMASCRIPT_WHITESPACE,
  maxSafeInteger: Number.MAX_SAFE_INTEGER,
  base62Alphabet: BASE62_ALPHABET,
  credentialPrefix: CREDENTIAL_PREFIX,
  tokenIdLength: TOKEN_ID_LENGTH,
  tokenSecretLength: TOKEN_SECRET_LENGTH,
  tokenCrcLength: TOKEN_CRC_LENGTH,
} as const;

/** Custom format registrations for the runtime's name, ETag, line-range and CRC refinements. */
export const SCHEMATHESIS_FORMATS_HOOK: string = String.raw`
import binascii
import json
import re
import unicodedata
from urllib.parse import unquote

import schemathesis
from hypothesis import strategies as st

_IRIDIUM_FORMAT_POLICY = json.loads(${JSON.stringify(JSON.stringify(FORMAT_POLICY))})
_IRIDIUM_RESERVED_NAMES = frozenset(_IRIDIUM_FORMAT_POLICY["reservedDeviceNames"])
_IRIDIUM_WHITESPACE = frozenset(_IRIDIUM_FORMAT_POLICY["whitespace"])
_IRIDIUM_PERCENT_ESCAPE = re.compile(r"%[0-9a-fA-F]{2}")
_IRIDIUM_BAD_PERCENT_ESCAPE = re.compile(r"%(?![0-9a-fA-F]{2})")


def _iridium_shallow_name(name):
    if not name or name[0] == "." or name[-1] == ".":
        return False
    if name[0] in _IRIDIUM_WHITESPACE or name[-1] in _IRIDIUM_WHITESPACE:
        return False
    if "/" in name or "\\" in name:
        return False
    # Exclude unassigned code points as well as surrogates and controls: the pinned Python and
    # Node can use different Unicode versions, while normalization of assigned characters is stable.
    if any(unicodedata.category(character) in ("Cc", "Cs", "Cn") for character in name):
        return False
    if unicodedata.normalize("NFC", name) != name:
        return False
    if name.split(".", 1)[0].upper() in _IRIDIUM_RESERVED_NAMES:
        return False
    return len(name.encode("utf-8")) <= _IRIDIUM_FORMAT_POLICY["maxNameBytes"]


def _iridium_percent_decode_once(name):
    # decodeURIComponent rejects a malformed percent sequence or invalid UTF-8 before decoding
    # any bytes. paths.ts then decodes each well-formed escape as a code unit instead.
    if not _IRIDIUM_BAD_PERCENT_ESCAPE.search(name):
        try:
            return unquote(name, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            pass
    return _IRIDIUM_PERCENT_ESCAPE.sub(lambda match: chr(int(match[0][1:], 16)), name)


def _iridium_safe_name(name):
    if not _iridium_shallow_name(name):
        return False
    if len(name.encode("utf-16-le")) // 2 > _IRIDIUM_FORMAT_POLICY["maxNameUtf16"]:
        return False
    # Decoding strictly shortens an escaped string, so the fixed point is bounded by its length.
    # Requiring every decoded form to remain safe also covers the runtime's bounded decoding loop.
    decoded = name
    while _IRIDIUM_PERCENT_ESCAPE.search(decoded):
        following = _iridium_percent_decode_once(decoded)
        if following == decoded:
            break
        if not _iridium_shallow_name(following):
            return False
        decoded = following
    return True


def _iridium_bounded_name(raw):
    normalized = unicodedata.normalize("NFC", raw)
    utf8_bytes = 0
    utf16_units = 0
    kept = []
    for character in normalized:
        next_bytes = utf8_bytes + len(character.encode("utf-8"))
        next_units = utf16_units + (2 if ord(character) > 0xFFFF else 1)
        if (next_bytes > _IRIDIUM_FORMAT_POLICY["maxNameBytes"]
                or next_units > _IRIDIUM_FORMAT_POLICY["maxNameUtf16"]):
            break
        kept.append(character)
        utf8_bytes = next_bytes
        utf16_units = next_units
    return "".join(kept)


_IRIDIUM_NODE_NAMES = st.text(
    alphabet=st.characters(exclude_categories=("Cc", "Cs", "Cn"), exclude_characters="/\\"),
    min_size=1,
    max_size=_IRIDIUM_FORMAT_POLICY["maxNameUtf16"],
).map(_iridium_bounded_name).filter(_iridium_safe_name)


_IRIDIUM_STRONG_ETAGS = st.integers(
    min_value=1, max_value=_IRIDIUM_FORMAT_POLICY["maxSafeInteger"],
).map(lambda version: '"' + str(version) + '"')


_IRIDIUM_LINE_RANGES = st.tuples(
    st.integers(min_value=1, max_value=_IRIDIUM_FORMAT_POLICY["maxSafeInteger"]),
    st.integers(min_value=1, max_value=_IRIDIUM_FORMAT_POLICY["maxSafeInteger"]),
).map(lambda ends: str(min(ends)) + "-" + str(max(ends)))


def _iridium_base62(value, width):
    alphabet = _IRIDIUM_FORMAT_POLICY["base62Alphabet"]
    encoded = ""
    while value:
        value, remainder = divmod(value, len(alphabet))
        encoded = alphabet[remainder] + encoded
    return encoded.rjust(width, alphabet[0])


def _iridium_spl_credential(parts):
    public_id, secret = parts
    body = _IRIDIUM_FORMAT_POLICY["credentialPrefix"] + "spl_" + public_id + "_" + secret
    checksum = binascii.crc32(body.encode("ascii"))
    return body + _iridium_base62(checksum, _IRIDIUM_FORMAT_POLICY["tokenCrcLength"])


_IRIDIUM_SPL_CREDENTIALS = st.tuples(
    st.text(
        alphabet=_IRIDIUM_FORMAT_POLICY["base62Alphabet"],
        min_size=_IRIDIUM_FORMAT_POLICY["tokenIdLength"],
        max_size=_IRIDIUM_FORMAT_POLICY["tokenIdLength"],
    ),
    st.text(
        alphabet=_IRIDIUM_FORMAT_POLICY["base62Alphabet"],
        min_size=_IRIDIUM_FORMAT_POLICY["tokenSecretLength"],
        max_size=_IRIDIUM_FORMAT_POLICY["tokenSecretLength"],
    ),
).map(_iridium_spl_credential)


schemathesis.openapi.format("iridium-node-name", _IRIDIUM_NODE_NAMES)
schemathesis.openapi.format("iridium-strong-etag", _IRIDIUM_STRONG_ETAGS)
schemathesis.openapi.format("iridium-line-range", _IRIDIUM_LINE_RANGES)
schemathesis.openapi.format("iridium-credential-spl", _IRIDIUM_SPL_CREDENTIALS)
`;
