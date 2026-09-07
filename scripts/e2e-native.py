"""Isolated native runtime fixture for browser tests. Never a registered real worker."""
import json
from pathlib import Path
import sys
from test_ocw_graph import native_plan
from ocw_runtime import Runtime
root = Path(sys.argv[2])
if sys.argv[1] == 'seed':
    runtime = Runtime.initialize(root, native_plan(root.parent))
    failed = runtime.claim('fixture-retry'); runtime.finish(failed, {'error':'transient'}, False)
    a = runtime.claim('fixture-oracle'); runtime.finish(a, {'ok':True})
    a2 = runtime.claim('fixture-agent-a',120)
    b1 = runtime.claim('fixture-agent-b',120)
    (root.parent/'fixture-tokens.json').write_text(json.dumps([a2,b1]))
    runtime.decide_path('PATH-A-2',actor='fixture-coordinator',reason='重复执行的反例',expected_revision=runtime.status()['revision'],verdict='refuted',evidence={'counterexample':'重复交付'})
elif sys.argv[1] == 'advance':
    runtime = Runtime(root)
    a2,b1 = json.loads((root.parent/'fixture-tokens.json').read_text())
    runtime.finish(a2,{'ok':True})
    a3=runtime.claim('fixture-agent-a');runtime.finish(a3,{'ok':True})
    runtime.finish(b1,{'ok':True})
    b2=runtime.claim('fixture-agent-b');runtime.finish(b2,{'ok':True})
    c=runtime.claim('fixture-agent-c',120)
    assert c['checkpoint']=='CP-C1'
elif sys.argv[1] == 'refute':
    runtime=Runtime(root)
    runtime.decide_path('PATH-C-1',actor='fixture-coordinator',reason='方案证据被推翻',expected_revision=runtime.status()['revision'],verdict='refuted',evidence={'counterexample':'失效证据'})
print(json.dumps({'revision':runtime.status()['revision']}))
