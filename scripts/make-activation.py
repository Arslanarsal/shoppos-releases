import base64
import hashlib
import os
import sys

import nacl.encoding
import nacl.signing

KEY = os.path.expanduser("~/.shoppos-license/license.key")


def computer_code(machine_id):
    h = hashlib.sha256(("shoppos-computer-v1:" + machine_id.strip().lower()).encode()).digest()[:8].hex().upper()
    return "-".join(h[i : i + 4] for i in range(0, 16, 4))


def activation(code):
    key = nacl.signing.SigningKey(open(KEY, "rb").read(), encoder=nacl.encoding.HexEncoder)
    sig = key.sign(("shoppos-license-v1:" + code.strip().upper()).encode()).signature
    return base64.urlsafe_b64encode(sig).decode().rstrip("=")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--machine-id":
        code = computer_code(sys.argv[2])
        print(code)
        print(activation(code))
    elif len(sys.argv) == 2:
        print(activation(sys.argv[1]))
    else:
        print("usage: make-activation.py COMPUTER-CODE   or   make-activation.py --machine-id GUID")
        sys.exit(1)
