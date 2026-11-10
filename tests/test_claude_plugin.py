"""Check the published plugin resolves to the canonical standalone skill."""
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'plugins/gpdoc-markdown'


class ClaudePluginTests(unittest.TestCase):
    def test_marketplace_resolves_canonical_skill(self):
        marketplace = json.loads((ROOT / '.claude-plugin/marketplace.json').read_text())
        self.assertEqual(marketplace['name'], 'gpdoc-components')
        self.assertEqual(len(marketplace['plugins']), 1)
        entry = marketplace['plugins'][0]
        plugin_root = (ROOT / entry['source']).resolve()
        self.assertEqual(plugin_root, PLUGIN)
        plugin = json.loads((plugin_root / '.claude-plugin/plugin.json').read_text())
        self.assertEqual(entry['name'], plugin['name'])
        self.assertEqual(plugin['name'], 'gpdoc-markdown')
        self.assertRegex(plugin['version'], r'^\d+\.\d+\.\d+$')
        self.assertEqual(plugin['license'], 'MIT')
        self.assertTrue((plugin_root / 'LICENSE').is_file())
        skills = list((plugin_root / 'skills').glob('*/SKILL.md'))
        self.assertEqual(skills, [PLUGIN / 'skills/gpdoc-markdown/SKILL.md'])
        self.assertIn('name: gpdoc-markdown\n', skills[0].read_text())
        self.assertTrue((skills[0].parent / 'references/review.md').is_file())

    def test_skill_only_plugin_has_no_runtime_dependencies(self):
        plugin = json.loads((PLUGIN / '.claude-plugin/plugin.json').read_text())
        for field in ['hooks', 'mcpServers', 'lspServers', 'dependencies', 'settings', 'userConfig']:
            self.assertNotIn(field, plugin)
        for path in ['.mcp.json', '.lsp.json', 'hooks/hooks.json', 'settings.json']:
            self.assertFalse((PLUGIN / path).exists(), path)

    def test_install_commands_match_manifests(self):
        marketplace = json.loads((ROOT / '.claude-plugin/marketplace.json').read_text())
        plugin = json.loads((ROOT / '.claude-plugin/plugin.json').read_text())
        install = f"claude plugin install {plugin['name']}@{marketplace['name']}"
        invocation = f"/{plugin['name']}:gpdoc-markdown"
        for path in ['README.md', 'INSTALL.md', 'docs/index.html']:
            text = (ROOT / path).read_text()
            self.assertIn(install, text, path)
            self.assertIn(invocation, text, path)

    def test_readme_is_suitable_for_directory_description(self):
        prose = re.sub(r'```.*?```', '', (PLUGIN / 'README.md').read_text(), flags=re.S)
        self.assertGreaterEqual(len(prose.split()), 40)

    def test_directory_links_and_icon(self):
        plugin = json.loads((PLUGIN / '.claude-plugin/plugin.json').read_text())
        self.assertEqual(plugin['privacyPolicyUrl'],
                         'https://github.com/repetere/gpdoc-components/blob/main/PRIVACY.md')
        self.assertTrue((PLUGIN / 'PRIVACY.md').is_file())
        for key in ['documentationUrl', 'supportUrl', 'privacyPolicyUrl']:
            self.assertTrue(plugin[key].startswith('https://'), key)
        icon = (PLUGIN / plugin['icon']).read_bytes()
        self.assertEqual(icon[:8], b'\x89PNG\r\n\x1a\n')
        self.assertEqual(struct.unpack('>II', icon[16:24]), (512, 512))
        self.assertLess(len(icon), 2 * 1024 * 1024)

    def test_distribution_matches_canonical_sources(self):
        subprocess.run([sys.executable, str(ROOT / 'tools/build_claude_plugin.py')],
                       cwd=ROOT, check=True, capture_output=True)

    def test_distribution_has_only_supported_file_types(self):
        for path in PLUGIN.rglob('*'):
            self.assertFalse(path.is_symlink(), path)
            if path.is_file():
                self.assertTrue(path.name == 'LICENSE' or path.suffix in {'.md', '.json', '.png'}, path)
                self.assertFalse(path.read_bytes().startswith(b'#!'), path)

    def test_distribution_local_links_resolve(self):
        for path in PLUGIN.rglob('*.md'):
            for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
                if '://' not in target and not target.startswith('#'):
                    self.assertTrue((path.parent / target.split('#')[0]).is_file(), (path, target))


if __name__ == '__main__':
    unittest.main()
