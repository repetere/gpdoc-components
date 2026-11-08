"""Dependency-free checks for the public skill's example and linked resources."""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / 'skills' / 'gpdoc-markdown'


class SkillTests(unittest.TestCase):
    def test_local_links(self):
        for path in SKILL.rglob('*.md'):
            for link in re.findall(r'\]\(([^)]+)\)', path.read_text()):
                if '://' not in link and not link.startswith('#'):
                    self.assertTrue((path.parent / link.split('#')[0]).is_file(), link)

    def test_example(self):
        raw = (SKILL / 'examples' / 'review.md').read_text()
        match = re.match(r'^---\n([\s\S]*?)\n---\n', raw)
        self.assertIsNotNone(match)
        metadata = json.loads(match[1])
        body = raw[match.end():]
        self.assertNotIn('content', metadata)
        state = metadata['meta']['suggestions']
        self.assertEqual(body, state['baselineContent'])
        old = body.split('\n') if body else []
        items = sorted(state['items'].values(), key=lambda item: item['oldStart'])
        delta = end = 0
        for item in items:
            self.assertEqual(item['id'], state['items'][item['id']]['id'])
            self.assertGreaterEqual(item['oldStart'], end)
            self.assertEqual(item['newStart'], item['oldStart'] + delta)
            for side in ('old', 'new'):
                lines = item[side + 'Lines']
                self.assertEqual(item[side + 'End'] - item[side + 'Start'], len(lines))
                self.assertEqual(item[side + 'LineCount'], len(lines))
                self.assertEqual(item[side + 'Content'], '\n'.join(lines))
            self.assertEqual(old[item['oldStart']:item['oldEnd']], item['oldLines'])
            delta += len(item['newLines']) - len(item['oldLines'])
            end = item['oldEnd']
        proposed = list(old)
        for item in reversed(items):
            proposed[item['oldStart']:item['oldEnd']] = item['newLines']
        self.assertEqual('\n'.join(proposed), state['proposedContent'])
        for item in items:
            self.assertEqual(proposed[item['newStart']:item['newEnd']], item['newLines'])
        comments = metadata['meta']['comments']
        threads = comments['threads'].values()
        self.assertEqual(comments['metadata']['totalComments'], sum(len(t['comments']) for t in threads))
        for thread in threads:
            p = thread['position']
            self.assertEqual(old[p['lineNumber'] - 1], p['lineContent'])


if __name__ == '__main__':
    unittest.main()
