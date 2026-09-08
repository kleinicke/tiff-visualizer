import argparse
import threading
from .session import show


def main():
    parser = argparse.ArgumentParser(
        description="Open scientific images in a private local viewer"
    )
    parser.add_argument("files", nargs="+")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    with show(*args.files, open_browser=not args.no_browser) as session:
        print(session.url, flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
