"""Read-only bounded GPDoc slides/notebook/script shape validator; no client dependency.

Not a client importer, renderer, review validator, or universal GPDoc schema.
"""
import argparse
from pathlib import Path
from validate_gpdoc import json_load, require


def validate(data):
    require(isinstance(data, dict), 'envelope must be an object')
    for key in ('id', 'filename', 'created_at', 'updated_at'):
        require(isinstance(data.get(key), str) and bool(data[key]), key + ' must be a nonempty string')
    require(isinstance(data.get('meta', {}), dict), 'meta must be an object')
    content = data.get('content')
    require(isinstance(content, dict), 'content must be an object')
    kind = data.get('filetype')
    if kind == 'slides':
        require(isinstance(content.get('slides'), list), 'content.slides must be an array')
        require(all(isinstance(x, str) for x in content['slides']), 'slide objects are outside the string-array profile; preserve and investigate')
        return 'slides/string-array'
    if kind == 'notebook':
        cells = content.get('cells')
        require(isinstance(cells, list), 'content.cells must be an array')
        dialects, ids = set(), set()
        for cell in cells:
            require(isinstance(cell, dict), 'cell must be an object')
            if 'id' in cell:
                require(isinstance(cell['id'], str) and bool(cell['id']) and cell['id'] not in ids, 'invalid or duplicate cell ID')
                ids.add(cell['id'])
            web = 'type' in cell or 'content' in cell
            desktop = 'cell_type' in cell or 'source' in cell
            require(web != desktop, 'ambiguous cell dialect')
            if web:
                require(cell.get('type') in ('markdown', 'code', 'python'), 'unknown web cell type; preserve and investigate')
                require(isinstance(cell.get('content'), str), 'web cell content must be a string')
                dialects.add('web')
            else:
                require(cell.get('cell_type') in ('markdown', 'code'), 'unknown desktop cell type; preserve and investigate')
                source = cell.get('source')
                require(isinstance(source, str) or isinstance(source, list) and all(isinstance(x, str) for x in source), 'desktop source must be string or string array')
                if 'metadata' in cell:
                    require(isinstance(cell['metadata'], dict), 'cell metadata must be an object')
                dialects.add('desktop')
        require(len(dialects) <= 1, 'mixed notebook dialects')
        return 'notebook/' + next(iter(dialects), 'empty')
    if kind == 'script':
        aliases = [key for key in ('code', 'script', 'document') if key in content]
        require(len(aliases) == 1 and aliases[0] in ('code', 'script'), 'ambiguous or unsupported script source alias')
        require(isinstance(content[aliases[0]], str), 'script source must be a string')
        require(isinstance(content.get('language'), str) and bool(content['language']), 'language must be a nonempty string')
        return 'script/' + ('web' if aliases[0] == 'code' else 'desktop')
    require(False, 'unsupported structured filetype')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('files', nargs='+', type=Path)
    args = parser.parse_args()
    failed = False
    for path in args.files:
        try:
            result = validate(json_load(path.read_bytes().decode('utf-8-sig')))
            print(str(path) + ': valid bounded ' + result + ' shape (not client certification)')
        except Exception as exc:
            failed = True
            print(str(path) + ': INVALID/UNSUPPORTED: ' + str(exc))
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
