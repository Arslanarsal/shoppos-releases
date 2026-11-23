import base64
import hashlib
import sys

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey


def decode_box(b64_text):
    text = base64.b64decode(b64_text.strip()).decode()
    return [line for line in text.splitlines() if line.strip()]


def verify(pub_b64, file_path, sig_path):
    pub_lines = decode_box(pub_b64)
    pk = base64.b64decode(pub_lines[1])
    if pk[:2] != b"Ed":
        raise SystemExit("Unknown public key type")
    key_id, key = pk[2:10], VerifyKey(pk[10:42])

    sig_lines = decode_box(open(sig_path).read())
    sig = base64.b64decode(sig_lines[1])
    alg, sig_key_id, signature = sig[:2], sig[2:10], sig[10:74]
    if sig_key_id != key_id:
        raise SystemExit("FAIL: signed with a different key")
    data = open(file_path, "rb").read()
    message = hashlib.blake2b(data, digest_size=64).digest() if alg == b"ED" else data
    try:
        key.verify(message, signature)
        trusted = sig_lines[2].split("trusted comment: ", 1)[1].encode()
        key.verify(signature + trusted, base64.b64decode(sig_lines[3]))
    except (BadSignatureError, IndexError):
        raise SystemExit(f"FAIL: signature does not match {file_path}")
    print(f"OK: {file_path} is signed by the release key")


if __name__ == "__main__":
    pub, files = sys.argv[1], sys.argv[2:]
    exes = [f for f in files if not f.endswith(".sig")]
    if not exes:
        raise SystemExit("No installer to check")
    for exe in exes:
        verify(pub, exe, exe + ".sig")
