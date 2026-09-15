#!/usr/bin/env python3
"""Independent acceptance oracle for the quickstart plan.

The runtime writes `{checkpoint_id, result, context}` to the file named by
`OCW_RESULT_FILE` and runs this as a separate process. Exit 0 accepts the
checkpoint; any other exit code keeps the failure evidence and retries.

This oracle inspects the delivered artifact rather than trusting the work
command's exit code, which is the whole point of a separate acceptance
command: `result.receipt` carries the real delivery path and digest.
"""
import hashlib
import json
import os
import pathlib
import sys

payload = json.loads(pathlib.Path(os.environ['OCW_RESULT_FILE']).read_text())
receipt = payload['result'].get('receipt') or {}

if receipt.get('status') != 'confirmed':
    sys.exit('delivery was not confirmed by the connector')

delivered = pathlib.Path(receipt['evidence'])
if not delivered.is_file():
    sys.exit(f'delivery {delivered} named in the receipt does not exist')

actual = hashlib.sha256(delivered.read_bytes()).hexdigest()
if actual != receipt['sha256']:
    sys.exit(f'delivery digest mismatch: receipt {receipt["sha256"]} vs file {actual}')

record = json.loads(delivered.read_text())
if record['checkpoint'] != payload['checkpoint_id']:
    sys.exit('delivered artifact belongs to a different checkpoint')

print(f'verified {delivered.name} sha256={actual[:16]}')
