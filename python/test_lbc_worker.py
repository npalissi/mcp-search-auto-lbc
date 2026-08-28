from __future__ import annotations

import os
import re
import unittest
from unittest.mock import patch

from lbc_worker import MatchedMobileClient, build_client, search_location


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


if __name__ == "__main__":
    unittest.main()
