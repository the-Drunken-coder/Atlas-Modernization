from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from atlas import DEFAULT_TUNNEL_HOSTNAME, public_base_url_from_hostname


class AtlasScriptHelpersTest(unittest.TestCase):
    def test_public_base_url_from_hostname_formats_bare_hostnames(self) -> None:
        self.assertEqual(public_base_url_from_hostname("example.com"), "https://example.com")
        self.assertEqual(public_base_url_from_hostname("example.com/"), "https://example.com")
        self.assertEqual(public_base_url_from_hostname("localhost:8080"), "https://localhost:8080")
        self.assertEqual(public_base_url_from_hostname("localhost:8080/"), "https://localhost:8080")

    def test_public_base_url_from_hostname_preserves_absolute_url_schemes(self) -> None:
        self.assertEqual(public_base_url_from_hostname("http://example.com/"), "http://example.com")
        self.assertEqual(public_base_url_from_hostname("https://example.com/"), "https://example.com")
        self.assertEqual(public_base_url_from_hostname("http://localhost:8080/"), "http://localhost:8080")
        self.assertEqual(public_base_url_from_hostname("https://example.com:443/"), "https://example.com:443")
        self.assertEqual(public_base_url_from_hostname("https://example.com/api/v1"), "https://example.com/api/v1")

    def test_public_base_url_from_hostname_uses_default_for_blank_values(self) -> None:
        want = f"https://{DEFAULT_TUNNEL_HOSTNAME}"
        self.assertEqual(public_base_url_from_hostname(""), want)
        self.assertEqual(public_base_url_from_hostname("  "), want)

    def test_public_base_url_from_hostname_uses_custom_default_for_blank_values(self) -> None:
        custom_default = "custom.example.com"
        want = f"https://{custom_default}"
        self.assertEqual(public_base_url_from_hostname("", custom_default), want)
        self.assertEqual(public_base_url_from_hostname("  ", custom_default), want)

    def test_public_base_url_from_hostname_handles_slash_edge_cases(self) -> None:
        want_default = f"https://{DEFAULT_TUNNEL_HOSTNAME}"
        self.assertEqual(public_base_url_from_hostname("https://"), want_default)
        self.assertEqual(public_base_url_from_hostname("http://"), want_default)
        self.assertEqual(public_base_url_from_hostname("//example.com"), "https://example.com")
        self.assertEqual(public_base_url_from_hostname("///example.com///"), "https://example.com")


if __name__ == "__main__":
    unittest.main()
