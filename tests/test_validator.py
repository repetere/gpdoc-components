import copy
import importlib.util
import json
from pathlib import Path
import unittest
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('validator', ROOT / 'tools/validate_gpdoc.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

class ValidatorTests(unittest.TestCase):
    def test_fixture_manifest(self):
        for case in json.loads((ROOT/'fixtures/manifest.json').read_text()):
            with self.subTest(case=case['path']):
                p=ROOT/'fixtures'/case['path']
                data,body=v.parse(p.read_bytes().decode(),p.name.endswith('.gpdoc.json'))
                if case['valid']:
                    self.assertTrue(v.validate(data,body))
                    self.assertEqual(body,case['baseline'])
                else:
                    with self.assertRaises(v.ValidationError):v.validate(data,body)
    def test_example(self):
        p=ROOT/'skills/gpdoc-markdown/examples/review.md'
        self.assertTrue(v.validate(*v.parse(p.read_text())))
    def test_duplicate_json_keys(self):
        with self.assertRaises(v.ValidationError):v.parse('---\n{"id":"a","id":"b"}\n---\n')
    def test_json_nonfinite(self):
        with self.assertRaises(v.ValidationError):v.json_load('{"x":NaN}')
    def test_boolean_ranges_rejected(self):
        p=ROOT/'fixtures/insert.md';data,body=v.parse(p.read_text())
        next(iter(data['meta']['suggestions']['items'].values()))['oldStart']=True
        with self.assertRaises(v.ValidationError):v.validate(data,body)
    def test_yaml_if_installed(self):
        try:import yaml
        except ImportError:self.skipTest('optional PyYAML unavailable')
        for raw in ('gpdoc_metadata: &x {id: a}\nother: *x','gpdoc_metadata: {id: a, id: b}','gpdoc_metadata: !!python/object {}'):
            with self.assertRaises((v.ValidationError,yaml.YAMLError)):v.parse('---\n'+raw+'\n---\n')

if __name__=='__main__':unittest.main()
