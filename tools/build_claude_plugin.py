"""Build or check the text-only skill distribution, separate from developer tools."""
import argparse
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'plugins/gpdoc-markdown'
FILES = [
    '.claude-plugin/plugin.json',
    'LICENSE',
    'PRIVACY.md',
    'assets/gpdoc-icon.png',
    'assets/NOTICE.md',
]


def sources():
    paths = [ROOT / name for name in FILES]
    paths += sorted(p for p in (ROOT / 'skills/gpdoc-markdown').rglob('*') if p.is_file())
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true', help='copy canonical files into the distribution')
    args = parser.parse_args()
    for source in sources():
        target = DEST / source.relative_to(ROOT)
        if args.write:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        elif not target.is_file() or target.read_bytes() != source.read_bytes():
            raise SystemExit(f'Distribution differs: {target.relative_to(ROOT)}')
    expected = {p.relative_to(ROOT) for p in sources()} | {Path('README.md')}
    actual = {p.relative_to(DEST) for p in DEST.rglob('*') if p.is_file()}
    if actual != expected:
        raise SystemExit(f'Unexpected or missing distribution files: {actual ^ expected}')
    print(f'Claude plugin distribution matches {len(expected)} files.')


if __name__ == '__main__':
    main()
