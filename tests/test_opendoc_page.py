"""Check the public OpenDoc page's paths, contract, and scope disclosures."""
from html.parser import HTMLParser
from pathlib import Path
import unittest
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
PAGE = DOCS / 'opendoc' / 'index.html'
PUBLIC_REPO = 'https://github.com/repetere/gpdoc-components'


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.ids = []
        self.elements = []
        self.links = []
        self.assets = []
        self.text_parts = []
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.elements.append((tag, attrs))
        if 'id' in attrs:
            self.ids.append(attrs['id'])
        if tag == 'a' and 'href' in attrs:
            self.links.append(attrs['href'])
        if tag in {'script', 'img'} and 'src' in attrs:
            self.assets.append(attrs['src'])
        if tag == 'link' and attrs.get('rel') == 'stylesheet':
            self.assets.append(attrs['href'])

    def handle_data(self, data):
        self.text_parts.append(data)

    @property
    def text(self):
        return ' '.join(' '.join(self.text_parts).split())


class OpenDocPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = PAGE.read_text()
        cls.page = Page(cls.source)

    def test_reachable_from_existing_site(self):
        home = Page((DOCS / 'index.html').read_text())
        self.assertIn('opendoc/', home.links)
        self.assertIn('../', self.page.links)
        self.assertIn('../#format', self.page.links)

    def test_local_links_assets_and_fragments_resolve(self):
        self.assertEqual(len(self.page.ids), len(set(self.page.ids)))
        for target in self.page.links + self.page.assets:
            with self.subTest(target=target):
                url = urlsplit(target)
                if url.scheme or url.netloc:
                    self.assertEqual(url.scheme, 'https')
                    continue
                # Relative URLs must also work on a GitHub project Pages path.
                self.assertFalse(url.path.startswith('/'))
                resolved = (PAGE.parent / unquote(url.path)).resolve() if url.path else PAGE
                self.assertTrue(resolved.is_relative_to(DOCS))
                if resolved.is_dir():
                    resolved = resolved / 'index.html'
                self.assertTrue(resolved.is_file(), target)
                if url.fragment:
                    self.assertIn(unquote(url.fragment), Page(resolved.read_text()).ids)

    def test_public_source_links_have_no_other_repository(self):
        for target in self.page.links:
            if urlsplit(target).netloc == 'github.com':
                self.assertTrue(target.startswith(PUBLIC_REPO + '/'), target)
        self.assertIn(PUBLIC_REPO + '/tree/main/opendoc', self.page.links)
        self.assertIn(PUBLIC_REPO + '/blob/main/LICENSE', self.page.links)
        self.assertIn(PUBLIC_REPO + '/blob/main/assets/NOTICE.md', self.page.links)

    def test_quickstart_and_local_safety_boundary(self):
        for command in (
            'git clone https://github.com/repetere/gpdoc-components.git',
            'cd gpdoc-components/opendoc',
            'npm ci --ignore-scripts',
            'npm test',
            'npm run demo',
        ):
            self.assertIn(command, self.page.text)
        for statement in (
            'Node.js 22',
            'pinned adapter dependencies',
            'local temporary token',
            'not enterprise OIDC login',
            'binds to loopback',
            'Do not expose it to the internet',
            'Documents are stored in memory and disappear when the process stops',
            'Local prototype, not production-ready',
        ):
            self.assertIn(statement, self.page.text)

    def test_working_and_planned_capabilities_are_explicit(self):
        for statement in (
            'AVAILABLE IN V0.5',
            'tenant and role checks',
            'Revision conflict handling',
            'Signed deployment-profile verification',
            'Conformance tests and cloud-neutral interfaces',
            'PostgreSQL storage with transactional revision checks',
            'Pinned-key RS256 access-token validation and server-owned membership',
            'PLANNED / NOT IMPLEMENTED',
            'Production identity-provider validation, cross-instance collaboration, and rich-text editor integration',
            'Experimental authenticated WebSocket/Yjs rooms with durable PostgreSQL snapshots',
            'collaboration remains a separate experiment',
            'Sessions default to memory, with an optional PostgreSQL adapter',
            'Optional encrypted PostgreSQL state for shared browser authentication',
            'Authenticated text editing with explicit saves and revision-conflict review',
            'Browser OIDC login, protected sessions, and server-owned account mapping',
            'Production database operations and S3 / GCS / Blob storage adapters',
            'Cloud infrastructure as code',
            'Configurable branding and rebrandable VS Code clients',
            'This page is not a hosted document service',
            'Verified air-gap operation',
            'roadmap goals, not release promises',
            'does not distribute the complete GPDoc or GPEditor applications',
        ):
            self.assertIn(statement, self.page.text)

    def test_all_clouds_are_reference_targets(self):
        for service in (
            'ECS Fargate', 'Application Load Balancer (ALB)', 'RDS PostgreSQL', 'S3',
            'Cloud Run', 'Cloud SQL for PostgreSQL', 'Google Cloud Storage (GCS)',
            'Container Apps', 'PostgreSQL Flexible Server', 'Blob Storage',
            'Kubernetes', 'CloudNativePG (CNPG)', 'Rook Ceph', 'Keycloak', 'Envoy Gateway',
        ):
            self.assertIn(service, self.page.text)
        self.assertIn('not deployed or tested clouds', self.page.text)
        self.assertIn('no cloud infrastructure is created by the quickstart', self.page.text)
        self.assertEqual(self.page.text.count('REFERENCE TARGET '), 4)

    def test_semantics_and_progressive_enhancement(self):
        headings = [attrs for tag, attrs in self.page.elements if tag == 'h1']
        self.assertEqual(len(headings), 1)
        self.assertIn(('html', {'lang': 'en'}), self.page.elements)
        self.assertIn('#main', self.page.links)
        buttons = [attrs for tag, attrs in self.page.elements if tag == 'button']
        self.assertEqual(len(buttons), 1)
        self.assertEqual(buttons[0]['type'], 'button')
        self.assertEqual(buttons[0]['aria-controls'], 'quickstart-commands')
        self.assertIn('hidden', buttons[0])
        statuses = [attrs for _, attrs in self.page.elements if attrs.get('role') == 'status']
        self.assertEqual(statuses[0]['aria-live'], 'polite')
        self.assertEqual(statuses[0]['aria-atomic'], 'true')
        for _, attrs in self.page.elements:
            for key in ('aria-labelledby', 'aria-controls'):
                if key in attrs:
                    for target in attrs[key].split():
                        self.assertIn(target, self.page.ids)
        script = (PAGE.parent / 'app.js').read_text()
        self.assertIn('navigator.clipboard.writeText(commands.textContent)', script)
        self.assertIn('Select the commands and copy them manually.', script)
        self.assertNotIn('innerHTML', script)
        self.assertNotIn('fetch(', script)


if __name__ == '__main__':
    unittest.main()
