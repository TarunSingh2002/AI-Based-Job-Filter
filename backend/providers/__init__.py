"""The AI provider: always Jev."""

from config import JEV_MODEL, JEV_URL
from providers.base import Provider
from providers.jev import JevProvider


def get_provider(settings) -> Provider:
    return JevProvider(settings.JEV_API_KEY, JEV_MODEL, JEV_URL)
