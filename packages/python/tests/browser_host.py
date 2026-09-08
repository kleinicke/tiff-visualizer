"""JSON-line driver for real-browser integration tests; not shipped as a CLI."""

import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import numpy as np
from scientific_image_visualizer import show

session = None
try:
    for line in sys.stdin:
        request = json.loads(line)
        try:
            operation = request["operation"]
            args = request.get("args", {})
            if operation == "open":
                session = show(
                    np.arange(12, dtype=np.float32).reshape(3, 4), open_browser=False
                )
                result = session.status()
            elif operation == "update_array":
                result = session.update(np.full((2, 3, 3), 42, dtype=np.uint16))
            elif operation == "capture":
                result = {"png": base64.b64encode(session.capture()).decode()}
            else:
                result = getattr(session, operation)(**args)
            print(json.dumps({"result": result}), flush=True)
        except Exception as error:
            print(json.dumps({"error": str(error)}), flush=True)
finally:
    if session:
        session.close()
