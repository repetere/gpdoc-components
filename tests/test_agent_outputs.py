"""Regression assertions over one actual agent-use run's synthetic outputs.

These replay artifact assertions, not an LLM invocation or universal agent guarantee.
"""
import copy
import json
from datetime import datetime
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import validate_structured as v
from validate_gpdoc import parse


class AgentOutputTests(unittest.TestCase):
    def load(self, directory, name):
        return json.loads((ROOT / 'fixtures' / directory / name).read_text())

    def test_targeted_edits_preserve_every_other_field(self):
        for name in ['slides', 'notebook-web', 'notebook-desktop', 'script-web', 'script-desktop']:
            with self.subTest(name=name):
                before = self.load('structured', name + '.gpdoc.json')
                target = ('slides-edited' if name == 'slides' else name) + '.gpdoc.json'
                after = self.load('agent-run', target)
                expected = copy.deepcopy(before)
                if name == 'slides':
                    expected['content']['slides'][1] = expected['content']['slides'][1].replace('10 units', '12 units')
                elif name == 'notebook-web':
                    expected['content']['cells'][0]['content'] = '# Analysis\n\nVerified summary.'
                elif name == 'notebook-desktop':
                    expected['content']['cells'][0]['source'] = ['# Analysis\n', '\n', 'Verified summary.']
                else:
                    key = 'code' if name == 'script-web' else 'script'
                    expected['content'][key] = expected['content'][key].replace('Hello, ', 'Welcome, ')
                self.assertGreater(datetime.fromisoformat(after['updated_at']), datetime.fromisoformat(before['updated_at']))
                expected['updated_at'] = after['updated_at']
                self.assertEqual(expected, after)
                self.assertEqual(v.validate(before), v.validate(after))

    def test_creation_and_representation(self):
        outputs = [self.load('agent-run', 'new-' + kind + '.gpdoc.json') for kind in ['slides', 'notebook', 'script']]
        self.assertEqual(outputs[0]['content']['slides'], ['# Plan', '# Next steps'])
        self.assertEqual(outputs[1]['content']['cells'][0]['content'], '# Plan')
        self.assertEqual(outputs[2]['content']['code'], "print('Hello')\n")
        self.assertEqual(outputs[2]['content']['language'], 'python')
        self.assertEqual(len({d['id'] for d in outputs}), 3)
        for d in outputs:
            v.validate(d)
            self.assertEqual(d['created_at'], d['updated_at'])
            datetime.fromisoformat(d['created_at'])

    def test_markdown_creation_optional_yaml(self):
        try: import yaml
        except ImportError: self.skipTest('optional PyYAML unavailable')
        metadata, body = parse((ROOT / 'fixtures/agent-run/markdown-slides.md').read_text())
        self.assertEqual(metadata['filetype'], 'slides')
        delimiter = '<div style="page-break-after: always;"></div>'
        self.assertEqual([s.strip() for s in body.split(delimiter)], ['# Plan', '# Next steps'])
        self.assertNotIn('content', metadata)

    def test_external_review_not_embedded(self):
        review = (ROOT / 'fixtures/agent-run/review.txt').read_text()
        self.assertIn('Revenue is 15 units.', review)
        self.assertIn('External review', review)
        original = self.load('structured', 'slides.gpdoc.json')
        self.assertIn('Revenue is 10 units.', original['content']['slides'][1])
        self.assertNotIn('suggestions', original['meta'])
        objects = self.load('structured', 'slides-objects-unsupported.gpdoc.json')
        self.assertEqual([s['id'] for s in objects['content']['slides']], ['title', 'keep'])


if __name__ == '__main__':
    unittest.main()
