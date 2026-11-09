"""Synthetic bounded-format checks, not client import/render certification."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import validate_structured as v
from validate_gpdoc import ValidationError, json_load


class StructuredTests(unittest.TestCase):
    def load(self, name):
        return json_load((ROOT / 'fixtures/structured' / (name + '.gpdoc.json')).read_text())

    def test_profiles(self):
        for name, profile in [('slides', 'slides/string-array'), ('notebook-web', 'notebook/web'), ('notebook-desktop', 'notebook/desktop'), ('script-web', 'script/web'), ('script-desktop', 'script/desktop')]:
            with self.subTest(name=name):
                self.assertEqual(v.validate(self.load(name)), profile)

    def test_invalid_and_unsupported(self):
        cases = []
        d = self.load('slides'); d['content']['slides'] = '\n'.join(d['content']['slides']); cases.append(d)
        cases.append(self.load('slides-objects-unsupported'))
        d = self.load('slides'); d['content']['slides'][1] = 42; cases.append(d)
        d = self.load('notebook-web'); d['content']['cells'][1]['id'] = 'intro'; cases.append(d)
        d = self.load('notebook-web'); d['content']['cells'][0]['source'] = 'ambiguous'; cases.append(d)
        d = self.load('notebook-web'); d['content']['cells'][1] = self.load('notebook-desktop')['content']['cells'][1]; cases.append(d)
        d = self.load('notebook-desktop'); d['content']['cells'][0]['source'] = [1]; cases.append(d)
        d = self.load('script-web'); d['content']['script'] = d['content']['code']; cases.append(d)
        d = self.load('script-web'); d['content']['code'] = ['not a string']; cases.append(d)
        d = self.load('script-web'); d['content']['language'] = None; cases.append(d)
        for d in cases:
            with self.subTest(data=d):
                original = copy.deepcopy(d)
                with self.assertRaises(ValidationError): v.validate(d)
                self.assertEqual(original, d)

    def test_read_only_cli(self):
        for name, status in [('slides', 0), ('slides-objects-unsupported', 1)]:
            path = ROOT / 'fixtures/structured' / (name + '.gpdoc.json')
            before = path.read_bytes()
            result = subprocess.run([sys.executable, '-S', str(ROOT / 'tools/validate_structured.py'), str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, status, result.stdout + result.stderr)
            self.assertEqual(path.read_bytes(), before)
            self.assertNotIn('Traceback', result.stderr)

    def test_duplicate_and_nonfinite_json_rejected(self):
        for raw in ['{"id":"x","id":"y"}', '{"value":NaN}', '{"value":Infinity}']:
            with self.assertRaises(ValidationError): json_load(raw)


if __name__ == '__main__':
    unittest.main()
