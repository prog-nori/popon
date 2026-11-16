"""Offline compatibility check in the SAME Python environment as yt-dlp.

No config, credentials, token requests, raw exceptions, or network access.
"""
import importlib
import importlib.metadata
import json
import re
import sys


def main():
    versions = {}
    for name in ("yt-dlp", "yt-dlp-ejs", "bgutil-ytdlp-pot-provider"):
        value = importlib.metadata.version(name)
        if not re.fullmatch(r"[0-9.]+", value):
            raise ValueError()
        versions[name] = value
    module = importlib.import_module("yt_dlp_plugins.extractor.getpot_bgutil_http")
    provider = module.BgUtilHTTPPTP
    gvs = any(context.value == "gvs" for context in provider._SUPPORTED_CONTEXTS)
    ok = (
        versions == {"yt-dlp": "2026.10.26", "yt-dlp-ejs": "0.8.0", "bgutil-ytdlp-pot-provider": "2.0.2"}
        and provider.PROVIDER_VERSION == "2.0.2"
        and gvs
    )
    print(json.dumps({"event": "youtube_pot_compatibility", "ok": ok, "versions": versions,
                      "httpPluginImportable": True, "gvsSupported": gvs}))
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        status = main()
    except Exception:
        print(json.dumps({"event": "youtube_pot_compatibility", "ok": False,
                          "classification": "plugin_missing_or_incompatible"}))
        status = 1
    sys.exit(status)
