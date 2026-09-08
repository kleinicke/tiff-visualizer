"""Scientific image visualization using the shared Svelte/WASM viewer."""

from .session import ViewerSession, show
from .bridge import RendererError

__all__ = ["ViewerSession", "show", "RendererError"]
__version__ = "0.1.0"
