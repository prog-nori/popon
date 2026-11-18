#!/usr/bin/env python3
"""Offline fixture: real yt-dlp Niconico HLS parsing/selection and downloader.

Only the watch/access API response is replaced. All media is a generated local
test tone; no account, cookies, real video, or remote service is used.
"""
import os
import yt_dlp
from yt_dlp.extractor.niconico import NiconicoIE


def extract_fixture(self, url):
    video_id = self._match_id(url)
    base = os.environ["POPON_NICONICO_FIXTURE_BASE"]
    assert base.startswith("http://127.0.0.1:")
    api_data = {
        "media": {"domand": {
            "videos": [{"id": "video-h264-360p", "isAvailable": True, "qualityLevel": 0}],
            "audios": [{"id": "audio-aac-128kbps", "isAvailable": True,
                        "bitRate": 128000, "samplingRate": 48000, "qualityLevel": 0}],
            "accessRightKey": "fixture-only",
        }},
        "client": {"watchTrackId": "fixture-only"},
    }
    self._download_json = lambda *args, **kwargs: {"data": {"contentUrl": base + "/master.m3u8"}}
    return {
        "id": video_id, "title": "Local test tone", "duration": 1,
        "availability": "public", "formats": self._extract_formats(api_data, video_id),
    }


NiconicoIE._real_extract = extract_fixture
yt_dlp.main()
