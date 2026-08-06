from __future__ import annotations

import argparse

import uvicorn

from .app import create_app
from .config import load_config


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local point-cloud annotation API")
    parser.add_argument("--config", required=True, help="path to config.yaml")
    args = parser.parse_args()
    config = load_config(args.config)
    uvicorn.run(create_app(config), host=config.host, port=config.port)


if __name__ == "__main__":
    main()
