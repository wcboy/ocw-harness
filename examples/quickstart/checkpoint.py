#!/usr/bin/env python3
"""Replay-safe work command for the quickstart plan.

The runtime captures stdout and delivers it as one immutable file, so this
command must print the same bytes every time it runs for the same input
binding. `OCW_INPUT_DIGEST` changes when an upstream checkpoint is
invalidated, which is what makes a re-run produce a new delivery name
instead of colliding with the previous one.
"""
import json
import os
import sys

print(json.dumps({
    'checkpoint': os.environ['OCW_CHECKPOINT_ID'],
    'path': os.environ['OCW_PATH_ID'],
    'input_digest': os.environ['OCW_INPUT_DIGEST'],
    'claim': sys.argv[1],
}, sort_keys=True))
