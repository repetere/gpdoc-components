"""Browser regressions for the reference site's responsive layout.

Run separately from the dependency-free profile suite:
  pip install playwright
  python -m playwright install chromium webkit
  python tests/browser/test_reference_layout.py
  BROWSER_ENGINE=webkit python tests/browser/test_reference_layout.py

CHROMIUM_EXECUTABLE may point to a locally installed Chromium binary.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
from threading import Thread
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
WIDTHS = (320, 360, 375, 390, 393, 430, 768, 800, 801, 1024, 1440)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


class ReferenceLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT / "docs"))
        )
        cls.server_thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.addClassCleanup(cls.server.server_close)
        cls.addClassCleanup(cls.server_thread.join)
        cls.addClassCleanup(cls.server.shutdown)
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/"
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        engine = os.environ.get("BROWSER_ENGINE", "chromium")
        launch = {}
        if engine == "chromium" and os.environ.get("CHROMIUM_EXECUTABLE"):
            launch["executable_path"] = os.environ["CHROMIUM_EXECUTABLE"]
        cls.browser = getattr(cls.playwright, engine).launch(**launch)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.open_page(390)

    def open_page(self, width):
        if hasattr(self, "context"):
            self.context.close()
        self.context = self.browser.new_context(
            viewport={"width": width, "height": 844},
            is_mobile=width <= 800, has_touch=width <= 800, device_scale_factor=1,
            reduced_motion="reduce",
        )
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.page.goto(self.url)

    def assert_contained(self, width):
        dimensions = self.page.evaluate("""() => {
            const root = document.documentElement;
            const docs = document.querySelector('.docs').getBoundingClientRect();
            const toc = document.querySelector('.toc').getBoundingClientRect();
            return {
                viewport: innerWidth, contentWidth: root.clientWidth, page: root.scrollWidth,
                docsRight: docs.right, tocRight: toc.right,
                clipped: [root, document.body].some(el =>
                    ['hidden', 'clip'].includes(getComputedStyle(el).overflowX)),
                badLinks: [...document.querySelectorAll('.toc a')].filter(el => {
                    const box = el.getBoundingClientRect();
                    return box.left < -1 || box.right > root.clientWidth + 1;
                }).map(el => el.textContent),
            };
        }""")
        self.assertEqual(dimensions["viewport"], width, dimensions)
        self.assertLessEqual(dimensions["page"], dimensions["contentWidth"] + 1, dimensions)
        self.assertLessEqual(dimensions["docsRight"], dimensions["contentWidth"] + 1, dimensions)
        self.assertLessEqual(dimensions["tocRight"], dimensions["contentWidth"] + 1, dimensions)
        self.assertFalse(dimensions["clipped"], "Overflow must be fixed, not hidden")
        self.assertEqual(dimensions["badLinks"], [], dimensions)

    def test_viewports_with_skill_collapsed_and_expanded(self):
        for width in WIDTHS:
            with self.subTest(width=width):
                self.open_page(width)
                self.assert_contained(width)
                self.page.locator("summary").click()
                self.assert_contained(width)
                self.page.locator("summary").click()
                self.assert_contained(width)

    def test_long_commands_scroll_inside_their_code_blocks(self):
        self.page.set_viewport_size({"width": 320, "height": 844})
        self.page.locator("summary").click()
        scrollers = self.page.locator("pre").evaluate_all("""blocks => blocks
            .filter(el => el.scrollWidth > el.clientWidth + 1)
            .map(el => {
                const text = el.textContent;
                el.scrollLeft = el.scrollWidth;
                return {
                    textUnchanged: el.textContent === text,
                    right: el.getBoundingClientRect().right,
                    scrolled: el.scrollLeft > 0,
                    overflow: getComputedStyle(el).overflowX,
                };
            })""")
        self.assertTrue(scrollers, "The fixture must exercise long code lines")
        for block in scrollers:
            self.assertTrue(block["textUnchanged"])
            self.assertTrue(block["scrolled"], block)
            self.assertEqual(block["overflow"], "auto", block)
            self.assertLessEqual(block["right"], 321, block)
        self.assert_contained(320)

    def test_reference_navigation_and_preview_remain_usable(self):
        for anchor in ("quickstart", "format", "clients", "resources"):
            self.page.locator(f'.toc a[href="#{anchor}"]').click()
            self.assertEqual(self.page.url, self.url + "#" + anchor)
            self.assert_contained(390)
        self.page.go_back()
        self.assertEqual(self.page.url, self.url + "#clients")
        self.page.go_forward()
        self.assertEqual(self.page.url, self.url + "#resources")
        for _ in range(2):
            self.page.locator("#accept").click()
            self.assertFalse(self.page.locator("#accept").is_enabled())
            self.assertEqual(self.page.locator("#review-text").inner_text(), "Tuesday")
            self.page.locator("#reset").click()
            self.assertTrue(self.page.locator("#accept").is_enabled())
            self.assertEqual(self.page.locator("#review-text del").inner_text(), "Monday")
            self.assert_contained(390)


if __name__ == "__main__":
    unittest.main(verbosity=2)
