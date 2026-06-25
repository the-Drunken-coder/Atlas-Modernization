from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from seed_command_catalog import _api_auth_headers, _validate_command_catalog_data


def valid_catalog_with_parameter_type(parameter_type: Any) -> dict[str, object]:
    return {
        "type": "command_catalog",
        "name": "Atlas Command Catalog",
        "description": "Test catalog",
        "commands": [
            {
                "id": "test_command",
                "name": "Test Command",
                "description": "Test command",
                "parameters_schema": {
                    "test_param": {
                        "type": parameter_type,
                        "description": "Test parameter",
                        "required": True,
                    }
                },
            }
        ],
    }


def valid_catalog_without_parameter_type() -> dict[str, object]:
    catalog = valid_catalog_with_parameter_type("string")
    del catalog["commands"][0]["parameters_schema"]["test_param"]["type"]
    return catalog


class SeedCommandCatalogValidationTest(unittest.TestCase):
    def test_api_auth_headers_use_atlas_specific_key_first(self) -> None:
        with patch.dict(
            "os.environ",
            {"ATLAS_API_AUTH_KEY": " atlas-specific ", "API_AUTH_KEY": "generic"},
            clear=True,
        ):
            self.assertEqual(_api_auth_headers(), {"X-API-Key": "atlas-specific"})

    def test_api_auth_headers_fall_back_to_api_auth_key(self) -> None:
        with patch.dict("os.environ", {"API_AUTH_KEY": " generic "}, clear=True):
            self.assertEqual(_api_auth_headers(), {"X-API-Key": "generic"})

    def test_api_auth_headers_omit_empty_keys(self) -> None:
        with patch.dict("os.environ", {"ATLAS_API_AUTH_KEY": " ", "API_AUTH_KEY": ""}, clear=True):
            self.assertEqual(_api_auth_headers(), {})

    def test_accepts_valid_scalar_parameter_types(self) -> None:
        for parameter_type in ["string", "number", "boolean"]:
            with self.subTest(parameter_type=parameter_type):
                _validate_command_catalog_data(valid_catalog_with_parameter_type(parameter_type))

    def test_rejects_unvalidated_nested_parameter_types(self) -> None:
        invalid_types = [
            "object",
            "array",
            "foo",
            123,
            "",
            None,
            "String",
        ]
        for parameter_type in invalid_types:
            with self.subTest(parameter_type=parameter_type):
                with self.assertRaisesRegex(ValueError, r"type must be one of: .*boolean.*number.*string"):
                    _validate_command_catalog_data(valid_catalog_with_parameter_type(parameter_type))
        with self.subTest(parameter_type="omitted"):
            with self.assertRaisesRegex(ValueError, r"type must be one of: .*boolean.*number.*string"):
                _validate_command_catalog_data(valid_catalog_without_parameter_type())

    def test_omitted_parameter_type_does_not_duplicate_bound_errors(self) -> None:
        catalog = valid_catalog_without_parameter_type()
        parameter = catalog["commands"][0]["parameters_schema"]["test_param"]
        parameter["minimum"] = 1

        with self.assertRaises(ValueError) as raised:
            _validate_command_catalog_data(catalog)

        message = str(raised.exception)
        self.assertIn("type must be one of", message)
        self.assertNotIn("minimum and maximum are only valid for number parameters", message)

    def test_rejects_non_number_parameter_bounds(self) -> None:
        catalog = valid_catalog_with_parameter_type("string")
        parameter = catalog["commands"][0]["parameters_schema"]["test_param"]
        parameter["minimum"] = 1
        parameter["maximum"] = 10

        with self.assertRaisesRegex(ValueError, "minimum and maximum are only valid for number parameters"):
            _validate_command_catalog_data(catalog)

    def test_accepts_number_parameter_bounds(self) -> None:
        catalog = valid_catalog_with_parameter_type("number")
        parameter = catalog["commands"][0]["parameters_schema"]["test_param"]
        parameter["minimum"] = 1
        parameter["maximum"] = 10

        _validate_command_catalog_data(catalog)

    def test_reports_invalid_type_and_bounds_together(self) -> None:
        catalog = valid_catalog_with_parameter_type("foo")
        parameter = catalog["commands"][0]["parameters_schema"]["test_param"]
        parameter["minimum"] = 1
        parameter["maximum"] = 10

        with self.assertRaises(ValueError) as raised:
            _validate_command_catalog_data(catalog)

        message = str(raised.exception)
        self.assertIn("type must be one of", message)
        self.assertIn("minimum and maximum are only valid for number parameters", message)


if __name__ == "__main__":
    unittest.main()
