"""Helpers for reading the sealed v3 release index."""


def channel_platform_version(index: dict, channel: str) -> str:
    """Return the platform version the given channel selects."""
    return index["channels"][channel]


def stable_platform_version(index: dict) -> str:
    """Return the platform version selected by the stable channel."""
    return channel_platform_version(index, "stable")
