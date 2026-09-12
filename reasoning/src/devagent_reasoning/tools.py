"""Tool specs for the reasoning loop's LLM, built from schemas/tools/*.schema.json.

The reasoning loop never executes these tools itself — it only proposes tool calls (as an
interrupt(), see graph.py) which the harness validates against the same schema files and
executes. Reusing the schema files here (as the `parameters` the model is told to fill in)
means a tool's argument shape and its description live in exactly one place.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

TOOL_NAMES = ("read_file", "list_dir", "search_code")


def load_tool_specs(schemas_dir: Path) -> list[dict[str, Any]]:
    specs = []
    for name in TOOL_NAMES:
        schema = json.loads((schemas_dir / "tools" / f"{name}.schema.json").read_text("utf-8"))
        parameters = {k: v for k, v in schema.items() if k not in ("$schema", "$id", "title", "description")}
        specs.append(
            {
                "name": name,
                "description": schema.get("description", ""),
                "parameters": parameters,
            }
        )
    return specs
