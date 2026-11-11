import json
from pathlib import Path

from engine.tests.parity_cases import build

PARITY = Path(__file__).resolve().parents[2] / "docs" / "parity.json"


def test_parity_file_matches_python():
    """If this fails, regenerate: python -m engine.tests.parity_cases > docs/parity.json,
    then make ui/tests/parity.test.js pass too."""
    assert json.loads(PARITY.read_text()) == json.loads(json.dumps(build()))
