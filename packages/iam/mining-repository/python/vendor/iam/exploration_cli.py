"""Command line for the exploration workbook importer.

Kept in its own module because ``iam/__init__.py`` imports ``iam.exploration``
for its public functions; running ``python -m iam.exploration`` would therefore
execute a module the package had already imported, with a runpy warning.  The
CLI itself is just the function that lives beside the importer.
"""

from .exploration import main

if __name__ == "__main__":
    raise SystemExit(main())
