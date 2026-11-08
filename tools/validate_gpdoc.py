"""Read-only standalone GPDoc document/source-review validator. Python 3.10+."""
import argparse
import json
from pathlib import Path
import re


class ValidationError(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise ValidationError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate key: ' + key)
        result[key] = value
    return result


def json_load(text):
    return json.loads(text, object_pairs_hook=unique_object,
                      parse_constant=lambda v: (_ for _ in ()).throw(ValidationError('nonfinite JSON: ' + v)))


def parse(text, envelope=False):
    text = text.removeprefix('\ufeff')
    require('\r' not in text.replace('\r\n', ''), 'bare CR is unsupported')
    text = text.replace('\r\n', '\n')
    if envelope:
        data = json_load(text)
        require(isinstance(data, dict), 'JSON envelope must be an object')
        content = data.get('content')
        require(isinstance(content, dict) and isinstance(content.get('document'), str), 'content.document must be a string')
        return data, content['document'].replace('\r\n', '\n')
    match = re.match(r'\A---\n(.*?)\n---(?:\n|$)', text, re.S)
    require(match is not None, 'managed Markdown requires frontmatter')
    header = match[1]
    if header.lstrip().startswith('{'):
        data = json_load(header)
    else:
        try:
            import yaml
        except ImportError as exc:
            raise ValidationError('YAML validation needs optional PyYAML; JSON frontmatter needs no packages') from exc
        for token in yaml.scan(header):
            require(not isinstance(token, (yaml.tokens.AliasToken, yaml.tokens.AnchorToken, yaml.tokens.TagToken)), 'YAML aliases, anchors and explicit tags are unsupported')
        class Loader(yaml.SafeLoader):
            pass
        def mapping(loader, node):
            return unique_object([(loader.construct_object(k), loader.construct_object(v)) for k, v in node.value])
        Loader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
        data = yaml.load(header, Loader=Loader)
        require(isinstance(data, dict) and isinstance(data.get('gpdoc_metadata'), dict), 'YAML requires gpdoc_metadata object')
        require(not any(k in data for k in ('id', 'filetype', 'meta')), 'competing root identity/review fields')
        data = data['gpdoc_metadata']
    require(isinstance(data, dict), 'metadata must be an object')
    require('gpdoc_metadata' not in data, 'JSON frontmatter must use direct metadata')
    require('content' not in data, 'Markdown body is authoritative; remove embedded content only after reconciliation')
    return data, text[match.end():]


def lines(text):
    return text.split('\n') if text else []


def validate(metadata, body):
    require(isinstance(metadata, dict) and isinstance(body, str), 'metadata/body types')
    for key in ('id', 'filename', 'created_at', 'updated_at'):
        require(isinstance(metadata.get(key), str) and bool(metadata[key]), key + ' must be a nonempty string')
    require(metadata.get('filetype') == 'document', 'validator covers document profile only')
    meta = metadata.get('meta', {})
    require(isinstance(meta, dict), 'meta must be an object')
    state = meta.get('suggestions')
    if state is not None:
        require(isinstance(state, dict), 'suggestions must be an object')
        require(state.get('enabled') is True, 'canonical review requires enabled: true')
        require(state.get('baselineContent') == body, 'body differs from baselineContent')
        proposal = state.get('proposedContent')
        require(isinstance(proposal, str) and '\r' not in proposal, 'proposedContent must be LF-normalized text')
        items = state.get('items')
        require(isinstance(items, dict), 'items must be an object')
        old, new = lines(body), lines(proposal)
        for key, item in items.items():
            require(isinstance(item, dict) and item.get('id') == key, 'suggestion map key/id mismatch')
            for side in ('old', 'new'):
                for edge in ('Start', 'End'):
                    require(type(item.get(side + edge)) is int and item[side + edge] >= 0, 'invalid range')
                value = item.get(side + 'Lines')
                require(isinstance(value, list) and all(isinstance(v, str) and '\n' not in v and '\r' not in v for v in value), 'invalid line array')
                require(item[side + 'End'] - item[side + 'Start'] == len(value), 'range length mismatch')
                require(type(item.get(side + 'LineCount')) is int and item[side + 'LineCount'] == len(value), 'line count mismatch')
                require(item.get(side + 'Content') == '\n'.join(value), 'content mismatch')
            require(item.get('oldLineNumber') == item['oldStart'] + 1 and item.get('lineNumber') == item['newStart'] + 1, 'line number mismatch')
            expected = 'added' if not item['oldLines'] else 'deleted' if not item['newLines'] else 'modified'
            require(item.get('changeType') == expected and item.get('applied') is False, 'invalid pending change flags')
            require(item['oldLines'] != item['newLines'], 'no-op hunk')
            require(isinstance(item.get('suggestedAt'), str) and item['suggestedAt'], 'missing suggestedAt')
        ordered = sorted(items.values(), key=lambda v: (v['oldStart'], v['newStart']))
        end = delta = 0
        previous = None
        for item in ordered:
            a, b = item['oldStart'], item['oldEnd']
            require(a >= end and b <= len(old), 'overlap or out-of-bounds baseline range')
            require(previous != a, 'multiple hunks at one source position must be combined')
            require(item['newStart'] == a + delta and item['newEnd'] <= len(new), 'proposal range mismatch')
            require(old[a:b] == item['oldLines'], 'stale baseline lines')
            require(new[item['newStart']:item['newEnd']] == item['newLines'], 'stale proposed lines')
            end, previous = b, a
            delta += len(item['newLines']) - len(item['oldLines'])
        rebuilt = old[:]
        for item in reversed(ordered):
            rebuilt[item['oldStart']:item['oldEnd']] = item['newLines']
        require(rebuilt == new, 'hunks do not reconstruct proposedContent lines')
    comments = meta.get('comments')
    if comments is not None:
        require(isinstance(comments, dict) and isinstance(comments.get('threads'), dict), 'comments.threads must be an object')
        all_comments = []
        resolved = 0
        ids = set()
        source = lines(body)
        for key, thread in comments['threads'].items():
            require(isinstance(thread, dict) and thread.get('id') == key, 'thread key/id mismatch')
            require(type(thread.get('resolved')) is bool, 'resolved must be boolean')
            resolved += thread['resolved']
            position = thread.get('position', {})
            require(isinstance(position, dict), 'position must be an object')
            n = position.get('lineNumber')
            require(type(n) is int and 0 <= n <= len(source), 'invalid source anchor')
            require(n == 0 or position.get('lineContent') == source[n-1], 'stale comment anchor')
            require(not any(k in position for k in ('from', 'to', 'logicalBlockNumber')), 'rich-editor coordinates are not source anchors')
            entries = thread.get('comments')
            require(isinstance(entries, list) and bool(entries), 'thread must contain comments')
            for comment in entries:
                require(isinstance(comment, dict), 'comment must be object')
                cid = comment.get('id')
                require(isinstance(cid, str) and cid and cid not in ids, 'duplicate/missing comment id')
                ids.add(cid)
                require(isinstance(comment.get('text'), str) and isinstance(comment.get('createdAt'), str), 'invalid comment text/date')
                all_comments.append(comment)
        stats = comments.get('metadata', {})
        require(isinstance(stats, dict), 'comment statistics must be object')
        require(stats.get('totalComments') == len(all_comments) and stats.get('resolvedComments') == resolved, 'comment statistics mismatch')
        if all_comments:
            require(stats.get('lastCommentAt') == max(c['createdAt'] for c in all_comments), 'lastCommentAt mismatch')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('files', nargs='+', type=Path)
    args = parser.parse_args()
    failed = False
    for path in args.files:
        try:
            metadata, body = parse(path.read_bytes().decode('utf-8'), path.name.endswith('.gpdoc.json'))
            validate(metadata, body)
            print(str(path) + ': valid document/source-review profile')
        except Exception as exc:  # Parser errors are diagnostics, never writes.

            failed = True
            print(str(path) + ': INVALID: ' + str(exc))
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
