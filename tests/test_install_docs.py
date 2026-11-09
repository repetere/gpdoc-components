"""Keep install instructions complete, linked, and non-destructive."""
import html
from html.parser import HTMLParser
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.ids = []; self.links = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs: self.ids.append(attrs['id'])
        if tag == 'a' and 'href' in attrs: self.links.append(attrs['href'])

class InstallDocsTests(unittest.TestCase):
    def test_site_links_and_full_skill(self):
        source = (ROOT/'docs/index.html').read_text()
        page = Links(); page.feed(source)
        self.assertEqual(len(page.ids), len(set(page.ids)))
        for href in page.links:
            if href.startswith('#') and len(href) > 1:
                self.assertIn(href[1:], page.ids)
        self.assertIn(html.escape((ROOT/'skills/gpdoc-markdown/SKILL.md').read_text()), source)
        for anchor in ['quickstart', 'install-claude', 'install-codex', 'install-manual']:
            self.assertIn(anchor, page.ids)

    def test_readme_links(self):
        for file in [ROOT/'README.md', ROOT/'skills/README.md']:
            for href in re.findall(r'\]\(([^)]+)\)', file.read_text()):
                if '://' not in href and not href.startswith('#'):
                    self.assertTrue((file.parent/href.split('#')[0]).exists(), href)

    def test_documented_copy_commands_and_existing_install(self):
        doc = (ROOT/'skills/README.md').read_text()
        blocks = re.findall(r'```sh\n(.*?)```', doc, re.S)
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            # The clone was independently tested; isolate the copy steps from the network.
            (work/'gpdoc-components').symlink_to(ROOT, target_is_directory=True)
            for block in blocks:
                command = '\n'.join(line for line in block.splitlines() if not line.startswith('git clone '))
                subprocess.run(['sh', '-c', command], cwd=work, check=True, capture_output=True)
                prefix = '.claude' if '.claude/' in block else '.agents'
                target = work/prefix/'skills/gpdoc-markdown'
                original = ROOT/'skills/gpdoc-markdown'
                for src in original.rglob('*'):
                    if src.is_file(): self.assertEqual(src.read_bytes(), (target/src.relative_to(original)).read_bytes())
                marker = target/'SKILL.md'
                marker.write_text('local edit')
                repeat = subprocess.run(['sh', '-c', command], cwd=work, capture_output=True)
                self.assertNotEqual(repeat.returncode, 0)
                self.assertEqual(marker.read_text(), 'local edit')

if __name__ == '__main__': unittest.main()
