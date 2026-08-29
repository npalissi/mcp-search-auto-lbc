from __future__ import annotations

import os
import re
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from lbc_worker import (
    MatchedMobileClient,
    VehicleCatalogClient,
    build_client,
    build_vehicle_catalog,
    search_location,
    simple_values,
)


class MatchedMobileClientTests(unittest.TestCase):
    def test_generates_an_android_lbc_user_agent(self) -> None:
        client = object.__new__(MatchedMobileClient)

        user_agent = client._generate_user_agent()

        self.assertRegex(
            user_agent,
            re.compile(
                r"^LBC;Android;14;Pixel 7;phone;[0-9a-f]{16};wifi;100\.85\.2$"
            ),
        )

    @patch("lbc_worker.MatchedMobileClient")
    def test_build_client_defaults_to_the_matching_android_profile(
        self,
        client_class,
    ) -> None:
        with patch.dict(os.environ, {}, clear=True):
            build_client()

        client_class.assert_called_once_with(
            proxy=None,
            impersonate="chrome_android",
            timeout=30.0,
            max_retries=1,
        )

    def test_builds_a_leboncoin_city_with_radius_in_metres(self) -> None:
        location = search_location(
            {
                "city": "Saintes",
                "latitude": 45.746,
                "longitude": -0.633,
                "radiusKm": 200,
            }
        )

        self.assertIsNotNone(location)
        assert location is not None
        self.assertEqual(location.city, "Saintes")
        self.assertEqual(location.lat, 45.746)
        self.assertEqual(location.lng, -0.633)
        self.assertEqual(location.radius, 200_000)

    def test_builds_vehicle_catalog_from_leboncoin_frontend_data(self) -> None:
        feature_data = {
            "features": {
                "u_car_brand": {
                    "values": {
                        "type": "grouped",
                        "groupedData": [
                            {
                                "header": "Marques",
                                "list": [
                                    {"value": "CITROEN", "label": "CITROEN"}
                                ],
                            }
                        ],
                    }
                },
                "u_car_model_citroen": {
                    "values": {
                        "type": "simple",
                        "simpleData": [
                            {"value": "CITROEN_C3", "label": "C3"},
                            {
                                "value": "CITROEN_C3 Aircross",
                                "label": "C3 Aircross",
                            },
                        ],
                    }
                },
            }
        }
        form_data = {
            "version": "test-version",
            "multi": {
                "u_car_brandFields": {
                    "CITROEN": [
                        {"type": "feature", "name": "u_car_model_citroen"}
                    ]
                }
            },
        }

        catalog = build_vehicle_catalog(feature_data, form_data)

        self.assertEqual(catalog["sourceVersion"], "test-version")
        self.assertEqual(catalog["brands"][0]["value"], "CITROEN")
        self.assertEqual(
            catalog["brands"][0]["models"][1]["value"],
            "CITROEN_C3 Aircross",
        )

    def test_reads_trim_options_from_simple_feature_data(self) -> None:
        values = simple_values(
            {
                "values": {
                    "type": "simple",
                    "simpleData": [
                        {"value": "CITROEN_C3_Feel", "label": "Feel"}
                    ],
                }
            }
        )

        self.assertEqual(
            values,
            [{"value": "CITROEN_C3_Feel", "label": "Feel"}],
        )

    def test_uses_stale_catalog_when_leboncoin_is_temporarily_unavailable(
        self,
    ) -> None:
        with TemporaryDirectory() as directory:
            client = object.__new__(VehicleCatalogClient)
            client.cache_path = Path(directory) / "catalog.json"
            client.cache_seconds = 300
            client.session = Mock()
            client.session.get.side_effect = RuntimeError("temporary failure")
            client._write_cache(
                {
                    "catalog": {
                        "version": 1,
                        "sourceVersion": "old",
                        "fetchedAt": "2020-01-01T00:00:00Z",
                        "brands": [
                            {"value": "CITROEN", "label": "CITROEN", "models": []}
                        ],
                    },
                    "trims": {},
                }
            )

            catalog = client.get_catalog()

            self.assertEqual(catalog["cacheStatus"], "stale")
            self.assertEqual(catalog["brands"][0]["value"], "CITROEN")


if __name__ == "__main__":
    unittest.main()
