#!/usr/bin/env python3
"""Thin wrapper around Docling — converts a document to Markdown and prints to stdout."""

import sys

from docling.document_converter import DocumentConverter

if len(sys.argv) < 2:
    print("Usage: convert.py <file_path>", file=sys.stderr)
    sys.exit(1)

result = DocumentConverter().convert(sys.argv[1])
print(result.document.export_to_markdown())
